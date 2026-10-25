import express from 'express';
import { pipeline } from 'stream/promises';
import { LRUCache } from 'lru-cache';
import consola from 'consola';
import { envInt } from '../../utils/envNumber';
import { mapWithConcurrency } from '../../utils/concurrency';
import { hasAgeRatingCap } from '../../utils/ageRating';
import { randomUUID, timingSafeEqual } from 'crypto';
import {
  attachJellyfinContext,
  clientInfo,
  loadConfig,
  requireAuth,
  serverIdFor,
  runWithClient,
  clientHasOwnWatchlist,
} from './context';
import { mintToken, readToken, revokeToken } from './tokens';
import { pinOpens, splitSecret } from './pins';
import {
  EMPTY_USER_DATA,
  itemList,
  extensionInfo,
  publicSystemInfo,
  sessionInfo,
  systemInfo,
  userDto,
  SERVER_NAME,
} from './dto';
import { buildViews, catalogView, collectionTypeFor, findCatalogByViewId, getCatalogs, getSearchableCatalogs, isBoxSetCatalog, isBrowsable, requiresGenre, rowFor } from './views';
import { decodeJellyfinId } from './ids';
import { artTag, imageTag, isWideTag } from './imageTags';
import { buildEpisodes, buildSeasons, withSeasonAnimeIds, fetchCatalogPage, fetchMeta, fetchWindow, filterByIncludeTypes, includeTypesFilter, buildEpisode, findEpisodeVideo, knownCatalogLength, metaToBaseItem, pageChildren, pageEpisodes, recallArt, recallImages, rememberArt, rememberImages, sortNameFor, warmCatalogLengths, isLandscapeCatalog, showLandscape } from './items';
import { dashedGuid, encodeJellyfinId, normaliseJellyfinId, parseStremioId, stremioIdFor } from './ids';
import { coalesce, fetchStreams, fileFor, languageCode, languageName, mediaSourceFor, normaliseStreamBase, forgetDuration, placeholderMediaSource, recallDuration, recallFailure, recallIssued, recallStreams, rememberDuration, rememberFailure, rememberStreams, runtimeTicksFrom, streamClient, streamsState, streamUserAgent, toNotice, toPlayable, type StreamClient } from './streams';
import { fetchAddonSubtitles, formatOf, pickSubtitles, recallOffered, rememberOffered, subtitleBody, subtitleCodecFor, subtitleExtensionOf, subtitleFormatFor, subtitleLanguage, type SubtitleTrack } from './subtitles';
import { memoNextUp, resumeSnapshot, resumeUserData } from './resume';
import { animeSequels } from './sequels';
import { isAnimeTitle, showIdentity } from './canonicalIds';
import { keepsAnimeOnly, sourceFor } from './trackerSource';
import { refreshSeriesIndex, seriesIndex, warmSeriesIndex } from './episodeIndex';
import { authorizeQuickConnect, claimQuickConnect, initiateQuickConnect, quickConnectResult, readQuickConnect } from './quickConnect';
import { playbackAllowed, viewingTimeZone } from './viewingHours';
import { avatarTag, keepsUnderProfileCap, listProfiles, profileById, profileByName, profileByUserId, profileKey, profileTags, scopeConfigToProfile, type Profile } from './profiles';
import { malEpisodeFor, segmentId, segmentsFor, type SegmentType } from './segments';
import { hasCreditDate, personByName, personCredits, resolvePerson, similarTitles } from './people';
import { titleCards } from '../titleCards';
import { allBoxSets, boxSetGenres, boxSetMembers, boxSetsDeep, boxSetsFor, boxSetsUnder, collectionById, collectionView, folderById } from './collections';
import { entryItemType, setWatchlisted, watchlistEntries, watchlistItems } from './watchlist';
import { applyRatings, applyWatchedState, finishedSeries, ownNextUpRows, seriesCountsAmong, upcomingFollowed, watchedAmong, watchedHistory, watchedSnapshot, type NextUpRow, type UpcomingRow } from './watched';
import { cachedArtwork } from './artwork';
import { ImageQueueFull, SIZED_WIDTH, imageQueueFull, inImageSlot, shrinkToWidth, widthStep } from '../posterCache/resize';
import { IMAGE_CSP } from '../posterCache/proxyResponse';
import { registerStubs } from './stubs';
import { decodeCursor, exportRow, findUser, historyPage, historyUsers, isEpisodeVideo, itemIdForVideo, userByKey, videoIdsOf } from './history';
import { forgetUserSettings, liveSessionsFor, recordPlayed, recordPlayedUpTo, recordPlaying, recordProgress, recordStopped, recordUnplayed, recordUserData, sessionTouchDue, touchSessions, type LiveSession } from './playstate';

const database: any = require('../database');

const logger = consola.withTag('Jellyfin');

function maxMediaSources(): number {
  return envInt('JELLYFIN_MAX_MEDIA_SOURCES', 50, 1);
}

function streamNoticesOffered(): boolean {
  return String(require('../settingsService').getSetting('JELLYFIN_STREAM_NOTICES') ?? 'true').trim().toLowerCase() !== 'false';
}

function encodeSeriesId(descriptor: any): string {
  return encodeJellyfinId({ k: 'series', t: descriptor.t, i: descriptor.i });
}

/** A show's episodes from the meta in hand, for seasons counted before the show is indexed. */
function seriesVideosOf(meta: any): Map<string, any[]> {
  return new Map(meta?.id && Array.isArray(meta.videos) ? [[String(meta.id), meta.videos]] : []);
}

/**
 * The episode a tracker row names, among a meta's episodes: by the row's own
 * id, by its aliases, by the meta's own id with the row's numbering, and last
 * by season and episode number alone.
 */
async function locateEpisode(episodes: any[], videoId: string, mediaType: string, metaId: string): Promise<any | undefined> {
  const byId = (id: string) => {
    const parsed = parseStremioId(id);
    if (!parsed) return undefined;
    const wanted = encodeJellyfinId({ k: 'episode', t: mediaType, i: parsed.base, s: parsed.season, e: parsed.episode as number });
    return episodes.find((episode: any) => episode.Id === wanted);
  };
  const parsed = parseStremioId(videoId);
  if (!parsed) return undefined;
  let found = byId(videoId);
  if (found) return found;
  const { videoIdAliases } = require('./aliases');
  for (const alias of await videoIdAliases(videoId)) {
    found = byId(alias);
    if (found) return found;
  }
  if (parsed.base !== metaId) {
    found = byId(parsed.season === null || parsed.season === undefined ? `${metaId}:${parsed.episode}` : `${metaId}:${parsed.season}:${parsed.episode}`);
    if (found) return found;
  }
  // An absolute number only matches an absolute list.
  const absolute = parsed.season === null || parsed.season === undefined;
  return episodes.find(
    (episode: any) =>
      episode.IndexNumber === parsed.episode &&
      (absolute ? episode.ParentIndexNumber === null || episode.ParentIndexNumber === undefined : episode.ParentIndexNumber === parsed.season)
  );
}

// An anime episode's id names its own entry; the library may group the show under an IMDb id.
async function seriesForEpisode(userUUID: string, config: any, descriptor: any): Promise<{ meta: any; seriesId: string } | null> {
  const idMapper: any = require('../id-mapper');
  const perEntry = /^(kitsu|mal|anilist|anidb):/.test(String(descriptor.i));
  const grouped = perEntry && config?.providers?.anime !== 'kitsu' && config?.providers?.anime !== 'mal';
  if (grouped) {
    const numeric = parseInt(String(descriptor.i).split(':')[1], 10);
    const mapping = String(descriptor.i).startsWith('kitsu:') ? idMapper.getMappingByKitsuId(numeric)
      : String(descriptor.i).startsWith('mal:') ? idMapper.getMappingByMalId(numeric)
      : String(descriptor.i).startsWith('anilist:') ? idMapper.getMappingByAnilistId(numeric)
      : idMapper.getMappingByAnidbId(numeric);
    const imdb = mapping?.imdb_id;
    if (imdb) {
      const meta = await fetchMeta(userUUID, 'series', String(imdb));
      if (meta && findEpisodeVideo(meta, descriptor)) {
        return { meta, seriesId: encodeJellyfinId({ k: 'series', t: descriptor.t, i: String(meta.id) }) };
      }
    }
  }
  const meta = await fetchMeta(userUUID, 'series', descriptor.i);
  return meta ? { meta, seriesId: encodeSeriesId(descriptor) } : null;
}

async function nowPlayingItem(userUUID: string, config: any, serverId: string, itemId: string): Promise<any | null> {
  const descriptor = await decodeJellyfinId(itemId);
  if (descriptor?.k === 'movie') {
    const meta = await fetchMeta(userUUID, 'movie', descriptor.i);
    if (!meta) return null;
    const item = metaToBaseItem(meta, descriptor.t, serverId, null);
    item.Id = normaliseJellyfinId(itemId);
    return item;
  }
  if (descriptor?.k !== 'episode') return null;
  const found = await seriesForEpisode(userUUID, config, descriptor);
  if (!found) return null;
  const episodes = buildEpisodes(found.meta, descriptor.t, found.seriesId, serverId, null);
  const wanted = normaliseJellyfinId(itemId);
  return episodes.find((e: any) => e.Id === wanted) ?? episodes.find((e: any) => e.IndexNumber === descriptor.e && e.ParentIndexNumber === descriptor.s) ?? null;
}

type ActivityCounts = { byKey: Map<string, any>; favourites: Map<string, number> };

const activityMemo = new LRUCache<string, Promise<ActivityCounts>>({ max: envInt('JELLYFIN_RESUME_CACHE_MAX', 500, 1) });

/**
 * The Activity page's counts, held for a while: the apps ask every few seconds
 * while it is open, and counting folds every row a history holds.
 */
function activityCounts(userUUID: string, config: any): Promise<ActivityCounts> {
  const held = activityMemo.get(userUUID);
  if (held) return held;
  const work = (async (): Promise<ActivityCounts> => {
    const byKey: Map<string, any> = await require('./dashboard').playCounts(userUUID);
    const owners = historyUsers(config, userUUID, null).filter((user) => user.owns);
    const favourites = new Map<string, number>();
    for (const user of owners) {
      const scoped = scopeConfigToProfile({ ...config }, userUUID, user.profile.id);
      scoped.userUUID = userUUID;
      favourites.set(user.key, (await watchlistEntries(userUUID, scoped).catch(() => ({ entries: [] }))).entries.length);
    }
    return { byKey, favourites };
  })();
  activityMemo.set(userUUID, work, { ttl: envInt('JELLYFIN_ACTIVITY_COUNTS_TTL', 300, 10) * 1000 });
  work.catch(() => activityMemo.delete(userUUID));
  return work;
}

/** What each device is playing, from its last progress report, as a Jellyfin session carries it. */
async function withNowPlaying(userUUID: string, config: any, serverId: string, sessions: any[]): Promise<void> {
  const profile = profileKey(config);
  const window = envInt('JELLYFIN_DASHBOARD_LIVE_SECONDS', 120, 10) * 1000;
  const now = Date.now();
  const playing = new Map<string, LiveSession>();
  for (const live of await liveSessionsFor(userUUID)) {
    if (live.profile !== profile || !live.device || now - live.at > window) continue;
    if (!playing.has(live.device)) playing.set(live.device, live);
  }
  await Promise.all(sessions.map(async (session) => {
    const live = playing.get(String(session.DeviceId));
    if (!live) return;
    const item = await nowPlayingItem(userUUID, config, serverId, live.itemId).catch(() => null);
    if (!item) return;
    session.NowPlayingItem = item;
    session.PlayState = playStateOf(live);
  }));
}

function playStateOf(live: LiveSession): any {
  return {
    PositionTicks: live.positionMs * 10000,
    CanSeek: true,
    IsPaused: live.paused,
    IsMuted: false,
    PlayMethod: 'DirectStream',
    RepeatMode: 'RepeatNone',
    PlaybackOrder: 'Default',
    ...(live.playSession ? { PlaySessionId: live.playSession } : {}),
  };
}

/** What every user of the account is playing now, one session per device. */
async function playingSessions(userUUID: string, config: any, serverId: string): Promise<any[]> {
  const window = envInt('JELLYFIN_DASHBOARD_LIVE_SECONDS', 120, 10) * 1000;
  const now = Date.now();
  const seen = new Set<string>();
  const live = (await liveSessionsFor(userUUID)).filter((s) => {
    if (!s.device || now - s.at > window || seen.has(`${s.profile}|${s.device}`)) return false;
    seen.add(`${s.profile}|${s.device}`);
    return true;
  });
  const sessions = await Promise.all(live.map(async (s) => {
    const viewer = profileById(config, userUUID, s.viewer ?? (s.profile || null));
    const scoped = scopeConfigToProfile({ ...config }, userUUID, viewer.id);
    scoped.userUUID = userUUID;
    const item = await nowPlayingItem(userUUID, scoped, serverId, s.itemId).catch(() => null);
    if (!item) return null;
    const client = { client: s.app?.client ?? 'Unknown', device: s.app?.device ?? 'Unknown', deviceId: s.device!, version: s.app?.version ?? '0.0.0' };
    return { ...sessionInfo(viewer.userId, serverId, viewer.name, client), NowPlayingItem: item, PlayState: playStateOf(s) };
  }));
  return sessions.filter(Boolean);
}

/** An episode its meta does not list yet, built from the tracker's air date. */
function episodeFromDate(meta: any, row: { videoId: string | null; episode: number; mediaType: string }, released: string, seriesId: string, serverId: string): any {
  const host = process.env.HOST_NAME?.startsWith('http') ? process.env.HOST_NAME : `https://${process.env.HOST_NAME}`;
  const thumbnail = meta.background || (Date.parse(released) <= Date.now() ? `${host}/missing_thumbnail.png` : null);
  const video = { ...(row.videoId ? { id: row.videoId } : {}), episode: row.episode, released, ...(thumbnail ? { thumbnail } : {}) };
  return buildEpisode(meta, video, row.mediaType, seriesId, serverId);
}

function localAddress(req: any): string {
  const host = process.env.HOST_NAME || req.get('host') || '';
  return host.startsWith('http') ? host : `https://${host}`;
}

function baseFor(req: any): string {
  return `${localAddress(req)}/jellyfin/${req.params.userUUID}`;
}

/** Metas a shelf hydrates at once; each cold anime meta is several Jikan calls. */
function shelfConcurrency(): number {
  return envInt('JELLYFIN_SHELF_META_CONCURRENCY', 4, 1);
}

/** The profile a signed-in request belongs to, or the unrestricted user. */
function sessionProfile(req: any, config: any): Profile {
  return profileById(config, req.params.userUUID, req.jellyfin?.profileId ?? null);
}

/** A request's played filter, in either spelling a client sends it. */
function playedFilter(req: any): 'played' | 'unplayed' | null {
  const filters = String(req.query.Filters ?? req.query.filters ?? '').split(',').map((f) => f.trim().toLowerCase());
  const flag = String(req.query.IsPlayed ?? req.query.isPlayed ?? '').toLowerCase();
  if (filters.includes('isplayed') || flag === 'true') return 'played';
  if (filters.includes('isunplayed') || flag === 'false') return 'unplayed';
  return null;
}

async function playedPick(req: any, userUUID: string, config: any, type: string, serverId: string, parentId: string): Promise<{ pick?: (metas: any[]) => Promise<any[]>; key: string }> {
  const played = playedFilter(req);
  if (!played) return { key: '' };
  const snapshot = await watchedSnapshot(userUUID, config);
  return {
    key: `|${played}`,
    pick: async (metas: any[]) => {
      const built = metas.map((meta: any) => metaToBaseItem(meta, type, serverId, parentId));
      await applyWatchedState(built, snapshot, userUUID, profileKey(config));
      return metas.filter((_: any, i: number) => (built[i].UserData?.Played === true) === (played === 'played'));
    },
  };
}

function userFor(profile: Profile, serverId: string, configuration?: any): any {
  const user = userDto(profile.userId, serverId, profile.name, avatarTag(profile));
  if (configuration && typeof configuration === 'object') user.Configuration = { ...user.Configuration, ...configuration };
  if (profile.downloads === false) user.Policy = { ...user.Policy, EnableContentDownloading: false };
  return user;
}

const USER_CONFIGURATION_ID = 'user-configuration';

const CACHEABLE_PATH =
  /^\/(items\/[^/]+\/images|persons\/[^/]+\/images|userimage|users\/[^/]+\/images|images\/general|videos\/)/i;

function landingPage(req: any): string {
  const origin = `${req.protocol}://${req.get('host')}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIOMetadata for Jellyfin</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; margin: 0; padding: 3rem 1.5rem;
         background: #101418; color: #e6e9ee; }
  main { max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.3rem; margin: 0 0 1rem; }
  p { margin: 0 0 1rem; color: #aab3c0; }
  code { background: #1c2430; padding: .15rem .4rem; border-radius: .25rem; color: #e6e9ee; }
  a { color: #7aa7ff; }
</style>
</head>
<body>
<main>
  <h1>AIOMetadata for Jellyfin</h1>
  <p>This address is a Jellyfin-compatible API, not a web client. Add
     <code>${origin}${req.baseUrl}</code> as a server in a Jellyfin app and sign
     in with your configuration password.</p>
  <p>Streams are played directly, so nothing is transcoded here.</p>
  <p><a href="${origin}/configure">Open the configuration page</a></p>
</main>
</body>
</html>`;
}

const streamCacheKey = (userUUID: string, profile: string, type: string, id: string, client?: StreamClient): string =>
  `${userUUID}:${profile}:${type}:${id}:${client?.tag ?? ''}`;

export type NextUpSource = 'server' | 'tracker' | 'sequel';

export interface NextUpStep {
  outcome: 'shown' | 'caught-up' | 'airs-later' | 'no-air-date' | 'missing-episode' | 'no-meta' | 'finished' | 'dropped' | 'not-anime' | 'rating-cap' | 'duplicate';
  next?: { season: number | null; number: number | null; name: string | null };
  from?: { season: number | null; number: number | null; name: string | null };
  airsAt?: number;
  episodes?: number;
  watched?: number;
  total?: number;
  meta?: any;
}

type NextUpTrace = (row: any, source: NextUpSource, step: NextUpStep) => void;

let nextUpTracer: ((userUUID: string, config: any, trace: NextUpTrace) => Promise<any[]>) | null = null;
let calendarReader: ((userUUID: string, config: any, from: number, to: number) => Promise<any[]>) | null = null;

export async function readCalendar(userUUID: string, config: any, from: number, to: number): Promise<any[] | null> {
  return calendarReader ? calendarReader(userUUID, config, from, to) : null;
}

const episodeLabel = (episode: any) => ({
  season: Number.isFinite(episode?.ParentIndexNumber) ? episode.ParentIndexNumber : null,
  number: Number.isFinite(episode?.IndexNumber) ? episode.IndexNumber : null,
  name: episode?.Name ?? null,
});

export async function explainNextUp(userUUID: string, config: any, trace: NextUpTrace): Promise<boolean> {
  if (!nextUpTracer) return false;
  await nextUpTracer(userUUID, config, trace);
  return true;
}

export function createJellyfinRouter(options: { loginRateLimit?: any } = {}): any {
  const loginRateLimit = options.loginRateLimit || ((_req: any, _res: any, next: any) => next());
  const router = express.Router({ mergeParams: true, caseSensitive: false });

  router.use(express.json({ limit: '1mb', type: ['application/json', 'text/json', 'application/*+json'] }));
  router.use(express.urlencoded({ extended: false }));

  router.use((req: any, res: any, next: any) => {
    res.setHeader('Access-Control-Allow-Origin', req.get('origin') || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  router.use((req: any, _res: any, next: any) => {
    if (/^\/(emby|mediabrowser)(\/|$)/i.test(req.url)) {
      req.url = req.url.replace(/^\/(emby|mediabrowser)/i, '') || '/';
    }
    if (req.url.length > 1 && /\/(\?|$)/.test(req.url)) {
      req.url = req.url.replace(/\/(\?|$)/, '$1');
    }
    next();
  });

  // A client that parses every response as JSON reads a bodyless 304 as the server being unreachable.
  router.use((req: any, res: any, next: any) => {
    if (!CACHEABLE_PATH.test(req.path)) {
      delete req.headers['if-none-match'];
      delete req.headers['if-modified-since'];
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  });

  router.use((req: any, res: any, next: any) => {
    const query = req.originalUrl.includes('?') ? `?${req.originalUrl.split('?')[1]}` : '';
    const line = `${req.method} ${req.path}${query}`;
    const started = process.hrtime.bigint();
    res.once('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const slow = envInt('JELLYFIN_SLOW_REQUEST_MS', 1000, 1);
      if (ms >= slow) logger.warn(`${Math.round(ms)}ms ${res.statusCode} ${line}`);
      else logger.debug(`${Math.round(ms)}ms ${res.statusCode} ${line}`);
    });
    next();
  });

  // The official SDK parses ids as UUIDs and refuses the bare form. ServerId is
  // a plain string, but a client matches it to the Id it saw at discovery.
  // A media source's Id stays bare, as a real server sends it: a client reads it up to the first dash.
  const ID_FIELD = /^(Id|ItemId|ParentId|SeriesId|SeasonId|UserId|ServerId|AlbumId|ChannelId|ParentLogoItemId|ParentBackdropItemId|ParentThumbItemId|ParentPrimaryImageItemId|Key|DisplayPreferencesId|PlaylistItemId)$/;
  const BARE_GUID = /^[0-9a-f]{32}$/i;
  // Apple TV has no browser to open a web link, so its trailers open in the YouTube app.
  const APPLE_TV = /tvos|apple ?tv/i;
  const youtubeApp = (trailer: any): any =>
    typeof trailer?.Url === 'string' ? { ...trailer, Url: trailer.Url.replace(/^https?:\/\/(www\.)?youtube\.com\//i, 'youtube://www.youtube.com/') } : trailer;
  const jsonReplacer = (appleTv: boolean) => {
    const sources = new WeakSet<object>();
    return function (this: any, key: string, value: any): any {
      if (typeof value === 'string') {
        return BARE_GUID.test(value) && (ID_FIELD.test(key) || key.endsWith('Ids')) && !(key === 'Id' && sources.has(this)) ? dashedGuid(value) : value;
      }
      if (!value || typeof value !== 'object') return value;
      if (key === 'MediaSources') {
        for (const source of Array.isArray(value) ? value : [value]) if (source && typeof source === 'object') sources.add(source);
        return value;
      }
      if (!Array.isArray(value)) return value;
      if (key.endsWith('Ids')) return value.map((x) => (typeof x === 'string' && BARE_GUID.test(x) ? dashedGuid(x) : x));
      if (appleTv && key === 'RemoteTrailers') return value.map(youtubeApp);
      return value;
    };
  };

  const seenClients = new Set<string>();
  router.use((req: any, res: any, next: any) => {
    const info = clientInfo(req);
    const label = `${info.client} | ${info.device}`;
    if (!seenClients.has(label) && info.client !== 'Unknown') {
      seenClients.add(label);
      logger.info(`Client seen: ${label} (${info.version})`);
    }
    const started = Date.now();
    res.on('finish', () => {
      const from = info.client !== 'Unknown' ? `${label} (${info.version})` : `ua ${req.get('user-agent') || 'none'}`;
      logger.debug(`${req.method} ${String(req.originalUrl || '').split('?')[0]} ${res.statusCode} ${Date.now() - started}ms from ${from}`);
    });
    const appleTv = APPLE_TV.test(info.client) || APPLE_TV.test(info.device);
    res.json = (body: any) => {
      if (!res.get('Content-Type')) res.set('Content-Type', 'application/json');
      return res.send(JSON.stringify(body, jsonReplacer(appleTv)));
    };
    next();
  });

  router.use(attachJellyfinContext);
  router.use((req: any, _res: any, next: any) => runWithClient(req, next));

  // --- Handshake ---

  router.get('/System/Info/Public', (req: any, res: any) => {
    res.json({ ...publicSystemInfo(serverIdFor(req.params.userUUID), baseFor(req)), aiostreams: extensionInfo(localAddress(req)) });
  });

  router.all('/System/Ping', (_req: any, res: any) => {
    res.json(SERVER_NAME);
  });

  router.get('/QuickConnect/Enabled', (_req: any, res: any) => {
    res.json(true);
  });

  router.post('/QuickConnect/Initiate', loginRateLimit, async (req: any, res: any) => {
    const request = await initiateQuickConnect(req.params.userUUID, clientInfo(req));
    res.json(quickConnectResult(request));
  });

  router.get('/QuickConnect/Connect', async (req: any, res: any) => {
    const request = await readQuickConnect(req.params.userUUID, String(req.query.secret ?? req.query.Secret ?? ''));
    if (!request) {
      res.status(404).json({ Message: 'Unknown quick connect secret' });
      return;
    }
    res.json(quickConnectResult(request));
  });

  // A client styles itself with whatever the server hands out here.
  const customCss = (): string => String(require('../settingsService').getSetting('JELLYFIN_CUSTOM_CSS') || '');

  router.get('/Branding/Configuration', (_req: any, res: any) => {
    res.json({ LoginDisclaimer: '', CustomCss: customCss(), SplashscreenEnabled: false });
  });

  router.get('/Branding/Splashscreen', (_req: any, res: any) => {
    res.status(404).end();
  });

  // The web client asks for this while the sign-in page is still loading, so it
  // has to answer before there is a token to answer with.
  router.get(['/Branding/Css', '/Branding/Css.css'], (_req: any, res: any) => {
    res.type('text/css').send(customCss());
  });

  router.get('/Users/Public', async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const config = await database.getUserConfig(userUUID).catch(() => null);
    if (!config) {
      res.json([]);
      return;
    }
    const serverId = serverIdFor(userUUID);
    res.json(listProfiles(config, userUUID).map((p) => userFor(p, serverId)));
  });

  // Anonymous, like item art: a client renders it with a plain image tag.
  const avatarFor = async (req: any, res: any, userId: string): Promise<void> => {
    const userUUID = req.params.userUUID;
    const config = await database.getUserConfig(userUUID).catch(() => null);
    const profile = config && userId && profileByUserId(config, userUUID, userId);
    if (!profile || !profile.avatar) {
      res.status(404).end();
      return;
    }
    res.redirect(302, profile.avatar);
  };
  router.get(['/Users/:userId/Images/Primary', '/Users/:userId/Images/Primary/:index'], (req: any, res: any) =>
    avatarFor(req, res, String(req.params.userId)));
  // Jellyfin 10.9 moved user images here.
  router.get('/UserImage', (req: any, res: any) => avatarFor(req, res, String(req.query.userId ?? req.query.UserId ?? '')));

  // --- Authentication ---

  /** Compared in constant time so a wrong guess reveals nothing by how long it took. */
  const signIn = async (req: any, res: any, userUUID: string, config: any, profile: Profile): Promise<void> => {
    const serverId = serverIdFor(userUUID);
    const token = await mintToken(userUUID, profile.id);

    res.json({
      User: userFor(profile, serverId),
      SessionInfo: sessionInfo(profile.userId, serverId, profile.name, clientInfo(req)),
      AccessToken: token,
      ServerId: serverId,
    });
  };

  const matchesAppPassword = (stored: string, supplied: string): boolean => {
    const a = Buffer.from(String(stored));
    const b = Buffer.from(supplied);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  /** The configuration this password opens, or null. */
  const configForPassword = async (userUUID: string, password: string): Promise<any> => {
    const config = await database.verifyUserAndGetConfig(userUUID, password);
    if (config) return config;
    // An account that signs in through a provider has no configuration password
    // to type, and a client's sign-in form cannot run that flow, so a password
    // issued for these clients is accepted here as well.
    const stored = await database.getUserConfig(userUUID).catch(() => null);
    return stored?.jellyfinAppPassword && matchesAppPassword(stored.jellyfinAppPassword, password) ? stored : null;
  };

  router.post('/Users/AuthenticateByName', loginRateLimit, async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const password = String(req.body?.Pw ?? req.body?.pw ?? req.body?.Password ?? '');

    let config: any = null;
    let pin = '';
    for (const candidate of splitSecret(password)) {
      config = await configForPassword(userUUID, candidate.password);
      if (config) {
        pin = candidate.pin;
        break;
      }
    }
    if (!config) {
      logger.debug(`Rejected Jellyfin login for ${userUUID}`);
      res.status(401).json({ Message: 'Invalid username or password' });
      return;
    }

    const profile = profileByName(config, userUUID, req.body?.Username ?? req.body?.username);
    if (!(await pinOpens(userUUID, profile, pin))) {
      res.status(401).json({ Message: 'PIN required' });
      return;
    }
    await signIn(req, res, userUUID, config, profile);
  });

  router.post('/Users/AuthenticateWithQuickConnect', loginRateLimit, async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const request = await claimQuickConnect(userUUID, String(req.body?.Secret ?? req.body?.secret ?? ''));
    if (!request) {
      res.status(401).json({ Message: 'Quick connect request is not approved' });
      return;
    }

    const config = await database.getUserConfig(userUUID).catch(() => null);
    if (!config) {
      res.status(401).json({ Message: 'Unknown configuration' });
      return;
    }

    await signIn(req, res, userUUID, config, profileById(config, userUUID, request.profileId));
  });

  router.post('/Sessions/Logout', async (req: any, res: any) => {
    await revokeToken(req.jellyfin?.token);
    res.status(204).end();
  });

  // A client derives the API base by truncating the address at /web, so /web must answer.
  router.all('/', (req: any, res: any) => {
    res.redirect(302, `${req.baseUrl}/web/`);
  });
  router.all(['/web', '/web/index.html'], (req: any, res: any) => {
    res.type('html').send(landingPage(req));
  });

  // --- Authenticated surface ---

  router.use(requireAuth);

  router.get('/System/Info', (req: any, res: any) => {
    res.json({ ...systemInfo(serverIdFor(req.params.userUUID), baseFor(req)), aiostreams: extensionInfo(localAddress(req)) });
  });

  // Every user of a configuration signs in with its one password, so a session has
  // already proved it and only a PIN tells users apart. A user with a PIN asks for it on
  // every switch, back to itself too, or handing over a signed-in device would hand it over.
  type Secret = 'pin';
  const switchNeeds = (_req: any, target: Profile): Secret | null => (target.pin ? 'pin' : null);

  router.get('/AIOStreams/Users', async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const config = await database.getUserConfig(userUUID).catch(() => null);
    if (!config) {
      res.json([]);
      return;
    }
    const serverId = serverIdFor(userUUID);
    res.json(listProfiles(config, userUUID).map((profile) => ({
      user: userFor(profile, serverId),
      avatar: profile.avatar,
      hidden: false,
      needs: switchNeeds(req, profile),
    })));
  });

  router.post('/AIOStreams/Token', loginRateLimit, async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const config = await database.getUserConfig(userUUID).catch(() => null);
    const profile = config && profileByUserId(config, userUUID, req.body?.UserId);
    if (!profile) {
      res.status(404).json({ Message: 'User not found' });
      return;
    }
    const needs = switchNeeds(req, profile);
    if (needs && !(await pinOpens(userUUID, profile, String(req.body?.Pw ?? '')))) {
      res.status(401).json({ Message: 'Invalid password' });
      return;
    }
    await signIn(req, res, userUUID, config, profile);
  });

  router.get('/AIOStreams/Activity', async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const config = await database.getUserConfig(userUUID).catch(() => null);
    if (!config) {
      res.json({ users: [], sessions: [] });
      return;
    }
    const serverId = serverIdFor(userUUID);
    const caller = req.jellyfin?.profileId ?? null;
    const users = historyUsers(config, userUUID, caller);
    const [{ byKey, favourites }, sessions] = await Promise.all([
      activityCounts(userUUID, config),
      caller ? Promise.resolve([]) : playingSessions(userUUID, config, serverId),
    ]);
    const main = listProfiles(config, userUUID)[0];
    res.json({
      users: users.map((user) => {
        const row: any = byKey.get(user.key);
        return {
          user: userFor(user.profile, serverId),
          avatar: user.profile.avatar,
          hidden: false,
          locked: Boolean(user.profile.pin),
          historyOf: dashedGuid(user.key ? user.profile.userId : main.userId),
          counts: user.owns
            ? { played: row?.played ?? 0, movies: row?.movies ?? 0, episodes: row?.episodes ?? 0, inProgress: row?.inProgress ?? 0, favorites: favourites.get(user.key) ?? 0, lastAt: row?.lastAt ?? null }
            : null,
        };
      }),
      sessions,
    });
  });

  router.get('/AIOStreams/History', async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const config = await loadConfig(req);
    const stored = await database.getUserConfig(userUUID).catch(() => null);
    if (!config || !stored) {
      res.json({ items: [], cursor: null });
      return;
    }
    const users = historyUsers(stored, userUUID, req.jellyfin?.profileId ?? null);
    const asked = req.query.userId ?? req.query.UserId;
    const scoped = asked ? findUser(users, asked) : undefined;
    if (asked && !scoped) {
      res.status(404).json({ Message: 'User not found' });
      return;
    }
    const owners = userByKey(users);
    const keys = scoped ? [scoped.key] : [...owners.keys()];
    const limit = Math.min(Math.max(1, parseInt(String(req.query.limit ?? req.query.Limit ?? 50), 10) || 50), 200);
    const localOnly = String(req.query.source ?? '') === 'local';
    const serverId = serverIdFor(userUUID);
    const { entries, cursor } = await historyPage(
      (take, after) => database.listHistoryRows(userUUID, keys, { limit: take, after, localOnly }),
      (candidates) => mapWithConcurrency(candidates, envInt('JELLYFIN_DASHBOARD_DESCRIBE_CONCURRENCY', 8, 1), (entry) =>
        nowPlayingItem(userUUID, config, serverId, itemIdForVideo(entry.videoId)).catch(() => null)
      ),
      limit,
      decodeCursor(req.query.cursor)
    );
    res.json({
      items: entries.map((entry) => {
        const episode = isEpisodeVideo(entry.videoId);
        const { profile, videoId, item, ...rest } = entry;
        return {
          userId: dashedGuid((owners.get(profile) ?? users[0]).profile.userId),
          kind: episode ? 'episode' : 'movie',
          favorite: false,
          ...rest,
          item: item ?? { Id: itemIdForVideo(videoId), Name: videoId, Type: episode ? 'Episode' : 'Movie' },
        };
      }),
      cursor,
    });
  });

  // Local only: a tracker that still lists a title brings it back on its next sync.
  router.post('/AIOStreams/History/Clear', async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const stored = await database.getUserConfig(userUUID).catch(() => null);
    const users = stored ? historyUsers(stored, userUUID, req.jellyfin?.profileId ?? null) : [];
    const user = findUser(users, req.body?.userId ?? req.body?.UserId);
    if (!user) {
      res.status(404).json({ Message: 'User not found' });
      return;
    }
    const keys = req.body?.itemKeys;
    if (keys !== undefined && (!Array.isArray(keys) || !keys.length || keys.length > 1000 || keys.some((key: any) => typeof key !== 'string' || !key))) {
      res.status(400).json({ Message: 'userId and optional itemKeys expected' });
      return;
    }
    activityMemo.delete(userUUID);
    const cleared = await database.clearHistory(userUUID, user.key, keys ? [...new Set(keys.flatMap((key: string) => videoIdsOf(key)))] : undefined);
    const { invalidateResume } = require('./resume');
    invalidateResume(userUUID);
    logger.info(`Cleared ${cleared} history row(s) of ${userUUID}${user.key ? ` (${user.key})` : ''}${keys ? '' : ', all of it'}`);
    res.json({ cleared });
  });

  // Written a page at a time, so a long history is never held whole.
  router.get('/AIOStreams/History/Export', async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const stored = await database.getUserConfig(userUUID).catch(() => null);
    const owners = stored ? historyUsers(stored, userUUID, req.jellyfin?.profileId ?? null).filter((user) => user.owns) : [];
    const keys = owners.map((user) => user.key);
    res.setHeader('Content-Disposition', `attachment; filename="watch-history-${userUUID.slice(0, 8)}.json"`);
    res.type('json');
    let gone = false;
    res.once('close', () => (gone = true));
    const write = (chunk: string): Promise<void> => {
      if (res.write(chunk)) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => {
          res.off('drain', done);
          res.off('close', done);
          resolve();
        };
        res.once('drain', done);
        res.once('close', done);
      });
    };
    try {
      const head = JSON.stringify({
        exportedAt: new Date().toISOString(),
        users: owners.map((user) => ({ id: dashedGuid(user.profile.userId), profile: user.key, name: user.profile.name })),
      });
      await write(`${head.slice(0, -1)},"rows":[`);
      const size = 1000;
      let after: { profile: string; videoId: string } | undefined;
      let first = true;
      while (!gone) {
        const page: any[] = await database.listPlaystatePage(userUUID, keys, size, after);
        if (!page.length) break;
        await write(`${first ? '' : ','}${page.map((row) => JSON.stringify(exportRow(row))).join(',')}`);
        first = false;
        if (page.length < size) break;
        const last = page[page.length - 1];
        after = { profile: String(last.profile ?? ''), videoId: String(last.video_id) };
      }
      res.end(']}');
    } catch (error: any) {
      logger.warn(`History export failed for ${userUUID}: ${error?.message || error}`);
      res.destroy();
    }
  });

  router.post('/QuickConnect/Authorize', async (req: any, res: any) => {
    const config = await loadConfig(req);
    const asked = req.query.userId ?? req.query.UserId;
    const profile = (asked && profileByUserId(config, req.params.userUUID, asked)) || sessionProfile(req, config);
    if (profile.id !== (req.jellyfin?.profileId ?? null) && switchNeeds(req, profile)) {
      res.status(403).json({ Message: 'Switch to this user to approve a device for them' });
      return;
    }
    const request = await authorizeQuickConnect(req.params.userUUID, String(req.query.code ?? req.query.Code ?? ''), profile.id);
    if (!request) {
      res.status(404).json({ Message: 'Unknown quick connect code' });
      return;
    }
    res.json(true);
  });

  router.get('/System/Endpoint', (_req: any, res: any) => {
    res.json({ IsLocal: false, IsInNetwork: false });
  });

  router.get('/System/Configuration', (_req: any, res: any) => {
    res.json({ EnableMetrics: false, ServerName: SERVER_NAME });
  });

  const storedConfiguration = async (req: any, profile: Profile): Promise<any> =>
    database.getPreferences(req.params.userUUID, profile.id ?? '', USER_CONFIGURATION_ID, '').catch(() => null);

  const meHandler = async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const serverId = serverIdFor(userUUID);
    const config = await database.getUserConfig(userUUID);
    const profile = (req.params.userId && profileByUserId(config, userUUID, req.params.userId)) || sessionProfile(req, config);
    res.json(userFor(profile, serverId, await storedConfiguration(req, profile)));
  };
  router.get('/Users/Me', meHandler);

  router.post(['/Users/:userId/Configuration', '/Users/Configuration'], async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const config = await database.getUserConfig(userUUID);
    const profile = (req.params.userId && profileByUserId(config, userUUID, req.params.userId)) || sessionProfile(req, config);
    if (req.body && typeof req.body === 'object') {
      await database.savePreferences(userUUID, profile.id ?? '', USER_CONFIGURATION_ID, '', req.body).catch((error: any) =>
        logger.debug(`User configuration save failed: ${error?.message || error}`)
      );
      forgetUserSettings(userUUID);
    }
    res.status(204).end();
  });
  router.get('/Users', async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const config = await database.getUserConfig(userUUID);
    const serverId = serverIdFor(userUUID);
    res.json(listProfiles(config, userUUID).map((p) => userFor(p, serverId)));
  });
  router.get('/Users/:userId', meHandler);

  const viewsHandler = async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const config = await loadConfig(req);
    if (!config) {
      res.json(itemList([], 0, 0));
      return;
    }
    const views = await buildViews(userUUID, serverIdFor(userUUID), config);
    res.json(itemList(views, views.length, 0));
  };
  router.get(['/Users/:userId/Views', '/UserViews'], viewsHandler);
  router.get('/Library/MediaFolders', viewsHandler);

  // Part of at least one client's startup, so a 404 here is fatal.
  router.get('/Library/VirtualFolders', async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const config = await loadConfig(req);
    if (!config) {
      res.json([]);
      return;
    }
    const views = await buildViews(userUUID, serverIdFor(userUUID), config);
    res.json(
      views.map((view: any) => ({
        Name: view.Name,
        Locations: [view.Path],
        CollectionType: view.CollectionType ?? null,
        LibraryOptions: {
          Enabled: true,
          EnableRealtimeMonitor: false,
          PathInfos: [],
        },
        ItemId: view.Id,
        PrimaryImageItemId: view.Id,
        RefreshStatus: 'Idle',
      }))
    );
  });

  // Both spellings: newer clients ask the /UserViews form, and a 404 is fatal.
  router.get(['/UserViews/GroupingOptions', '/Users/:userId/GroupingOptions'], async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const config = await loadConfig(req);
    if (!config) {
      res.json([]);
      return;
    }
    const views = await buildViews(userUUID, serverIdFor(userUUID), config);
    res.json(views.map((v: any) => ({ Name: v.Name, Id: v.Id })));
  });

  const qInt = (req: any, name: string, fallback: number): number => {
    const raw = req.query[name] ?? req.query[name.charAt(0).toLowerCase() + name.slice(1)];
    const parsed = parseInt(String(raw), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  router.get(['/Items', '/Users/:userId/Items'], async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const startIndex = Math.max(0, qInt(req, 'StartIndex', 0));
    const limit = Math.min(Math.max(1, qInt(req, 'Limit', 100)), 500);
    const includeItemTypes = req.query.IncludeItemTypes ?? req.query.includeItemTypes;
    const parentId = req.query.ParentId ?? req.query.parentId;
    const filters = String(req.query.Filters ?? req.query.filters ?? '');
    const favouriteFlag = String(req.query.IsFavorite ?? req.query.isFavorite ?? '').toLowerCase() === 'true';

    const config = await loadConfig(req);
    if (!config) {
      res.json(itemList([], 0, startIndex));
      return;
    }

    const serverId = serverIdFor(userUUID);

    // The watchlist, newest first, is every client's favourites; older clients ask for it by likes.
    const ownWatchlist = clientHasOwnWatchlist();
    const likesFilter = filters.split(',').map((f) => f.trim()).includes('Likes');
    if (filters.includes('IsFavorite') || favouriteFlag || (ownWatchlist && likesFilter)) {
      const started = Date.now();
      const wanted = includeItemTypes
        ? new Set(String(includeItemTypes).split(',').map((t) => t.trim()).filter(Boolean))
        : null;
      if (wanted && !wanted.has('Movie') && !wanted.has('Series')) {
        res.json(itemList([], 0, startIndex));
        return;
      }
      const { watchlistOrigins } = require('./dashboard');
      const origins = { WatchlistSources: watchlistOrigins(config) };
      const shelved = await serverWatchlistItems(userUUID, config, serverId, wanted);
      if (shelved) {
        await applyWatchedState(shelved, await watchedSnapshot(userUUID, config), userUUID, profileKey(config));
        res.json({ ...itemList(shelved.slice(startIndex, startIndex + limit), shelved.length, startIndex), ...origins, WatchlistComplete: true });
        return;
      }
      const read = await watchlistEntries(userUUID, config);
      const entries = read.entries.filter((entry) =>
        !wanted || wanted.has(entryItemType(entry))
      );
      const listed = Date.now() - started;
      const page = entries.slice(startIndex, startIndex + limit);
      const items = await watchlistItems(userUUID, config, serverId, page, shelfConcurrency());
      await applyWatchedState(items, await watchedSnapshot(userUUID, config), userUUID, profileKey(config));
      const count = read.exhausted ? entries.length : Math.max(entries.length, startIndex + items.length + limit);
      logger.debug(`Favourites for ${userUUID} from ${clientInfo(req).client}/${clientInfo(req).version}: ${items.length} of ${count}, types ${includeItemTypes ?? 'any'}, from ${startIndex}, in ${Date.now() - started}ms (entries ${listed}ms)`);
      res.json({ ...itemList(items, count, startIndex), ...origins, WatchlistComplete: read.complete !== false });
      return;
    }

    // Dropped shows are the disliked ones, as a dislike drops a show. Rated is not a
    // Jellyfin filter: it lists the titles this profile rated, newest first.
    const filterList = filters.split(',').map((f) => f.trim());
    const library = filterList.includes('Dislikes') ? 'dropped' : filterList.includes('Rated') ? 'ratings' : null;
    if (library) {
      const wanted = includeItemTypes ? String(includeItemTypes).split(',').map((t) => t.trim()) : null;
      const fits = (type: 'movie' | 'series') => !wanted || wanted.includes(type === 'movie' ? 'Movie' : 'Series');
      const { libraryPicks } = require('./dashboard');
      const picks = (await libraryPicks(userUUID, config, library)).filter((pick: any) => pick.types.some(fits));
      const page = picks.slice(startIndex, startIndex + limit);
      const built = await mapWithConcurrency(page, shelfConcurrency(), async (pick: any) => {
        for (const type of pick.types.filter(fits)) {
          const meta = await fetchMeta(userUUID, type, pick.metaId).catch(() => null);
          if (!meta) continue;
          const item = metaToBaseItem(meta, type, serverId, null);
          if (pick.at) item.DateCreated = new Date(pick.at).toISOString();
          else delete item.DateCreated;
          if (library === 'dropped') item.UserData = { ...item.UserData, Likes: false };
          return item;
        }
        return null;
      });
      const items = built.filter(Boolean).filter(keepsUnderProfileCap(config));
      await applyWatchedState(items, await watchedSnapshot(userUUID, config), userUUID, profileKey(config));
      res.json(itemList(items, picks.length, startIndex));
      return;
    }
    const minPremiere = Date.parse(String(req.query.MinPremiereDate ?? req.query.minPremiereDate ?? ''));
    const maxPremiere = Date.parse(String(req.query.MaxPremiereDate ?? req.query.maxPremiereDate ?? ''));
    const wantsEpisodes = String(includeItemTypes ?? '').split(',').map((t) => t.trim()).includes('Episode');
    if (!parentId && wantsEpisodes && (Number.isFinite(minPremiere) || Number.isFinite(maxPremiere))) {
      const dayMs = 24 * 60 * 60 * 1000;
      const today = Math.floor(Date.now() / dayMs) * dayMs;
      const earliest = today - envInt('JELLYFIN_CALENDAR_PAST_DAYS', 75, 0) * dayMs;
      const latest = today + (envInt('JELLYFIN_CALENDAR_FUTURE_DAYS', 365, 1) + 1) * dayMs;
      const from = Math.max(earliest, Number.isFinite(minPremiere) ? minPremiere : earliest);
      const to = Math.min(latest, Number.isFinite(maxPremiere) ? maxPremiere : latest);
      if (from > to) {
        res.json(itemList([], 0, startIndex));
        return;
      }
      const withFilms = String(includeItemTypes ?? '').split(',').map((t) => t.trim()).includes('Movie');
      const episodes = await heldCalendar(userUUID, config, from, to, withFilms);
      const pageSize = (req.query.Limit ?? req.query.limit) === undefined ? 500 : limit;
      res.json(itemList(episodes.slice(startIndex, startIndex + pageSize), episodes.length, startIndex));
      return;
    }

    const playedFlag = String(req.query.IsPlayed ?? req.query.isPlayed ?? '').toLowerCase() === 'true';
    if ((filters.split(',').map((f) => f.trim()).includes('IsPlayed') || playedFlag) && !parentId) {
      const started = Date.now();
      const wanted = includeItemTypes
        ? new Set(String(includeItemTypes).split(',').map((t) => t.trim()).filter(Boolean))
        : new Set(['Movie', 'Episode']);
      const countOnly = String(req.query.Limit ?? req.query.limit ?? '') === '0';
      const snapshot = await watchedSnapshot(userUUID, config);
      const profile = profileKey(config);

      type Played =
        | { kind: 'movie' | 'episode'; id: string; metaId?: string; mediaType: 'movie' | 'series' | 'anime'; at: number }
        | { kind: 'series'; id: string; mediaType: 'series' | 'anime'; at: number };
      const played: Played[] = [];

      if (wanted.has('Movie') || wanted.has('Episode')) {
        const kinds = new Set<string>([wanted.has('Movie') ? 'movie' : '', wanted.has('Episode') ? 'episode' : '']);
        played.push(...(await watchedHistory(snapshot, [...kinds].filter(Boolean) as Array<'movie' | 'episode'>, envInt('JELLYFIN_HISTORY_TRACKER_LIMIT', 20000, 1))));
        const database: any = require('../database');
        const { groupBySpelling } = require('./aliases');
        const rows: any[] = await database.listPlaystatePlayedFor(userUUID, envInt('JELLYFIN_HISTORY_LOCAL_LIMIT', 5000, 1), profile).catch(() => []);
        const onTracker = await watchedAmong(snapshot, rows.map((row) => String(row.video_id)));
        const finishedAt = new Map<string, number>();
        for (const watch of await database.listWatchesFor(userUUID, profile, rows.map((row) => String(row.video_id))).catch(() => [])) {
          finishedAt.set(watch.video_id, Math.max(finishedAt.get(watch.video_id) ?? 0, watch.watched_at));
        }
        for (const group of (await groupBySpelling(rows)) as any[][]) {
          if (group.some((row: any) => onTracker.has(String(row.video_id)))) continue;
          const row = group.find((r: any) => String(r.video_id).startsWith('tt')) ?? group[0];
          const videoId = String(row.video_id);
          const parsed = parseStremioId(videoId);
          if (!parsed) continue;
          const isEpisode = parsed.episode !== null;
          if (!kinds.has(isEpisode ? 'episode' : 'movie')) continue;
          const finished = Math.max(0, ...group.map((r: any) => finishedAt.get(String(r.video_id)) ?? 0));
          const at = finished || Math.max(...group.map((r: any) => Number(r.last_played_at) || 0));
          played.push(
            isEpisode
              ? { kind: 'episode', id: videoId, metaId: parsed.base, mediaType: videoId.startsWith('kitsu:') ? 'anime' : 'series', at }
              : { kind: 'movie', id: videoId, mediaType: 'movie', at }
          );
        }
      }

      if (wanted.has('Series')) {
        for (const show of await finishedSeries(snapshot)) {
          played.push({ kind: 'series', id: show.id, mediaType: show.id.startsWith('kitsu:') ? 'anime' : 'series', at: show.at });
        }
      }

      played.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id, undefined, { numeric: true }));
      if (countOnly) {
        res.json(itemList([], played.length, startIndex));
        return;
      }

      const page = played.slice(startIndex, startIndex + limit);
      const shows = [...new Set(page.flatMap((entry) => (entry.kind === 'episode' && entry.metaId ? [entry.metaId] : [])))];
      await warmSeriesIndex(userUUID, shows);
      const built = await mapWithConcurrency(page, shelfConcurrency(), async (entry): Promise<any | null> => {
        if (entry.kind === 'movie') {
          const meta = await fetchMeta(userUUID, 'movie', entry.id);
          return meta ? metaToBaseItem(meta, 'movie', serverId, null) : null;
        }
        if (entry.kind === 'series') {
          const meta = await fetchMeta(userUUID, 'series', entry.id);
          return meta ? metaToBaseItem(meta, entry.mediaType, serverId, null) : null;
        }
        if (!entry.metaId) return null;
        const meta = await seriesIndex(userUUID, entry.metaId);
        if (!meta) return null;
        const mediaType = entry.mediaType === 'anime' ? 'anime' : 'series';
        const episodes = buildEpisodes(meta, mediaType, encodeJellyfinId({ k: 'series', t: mediaType, i: String(meta.id) }), serverId, null);
        return (await locateEpisode(episodes, entry.id, mediaType, String(meta.id))) ?? null;
      });
      const items = built.filter(Boolean);
      await applyWatchedState(items, snapshot, userUUID, profile);
      const seen = new Set<string>();
      const shelf = items
        .filter((item: any) => item.UserData?.Played === true && !seen.has(item.Id) && seen.add(item.Id))
        .filter(keepsUnderProfileCap(config));
      logger.debug(`History for ${userUUID} from ${clientInfo(req).client}: ${shelf.length} of ${played.length}, types ${[...wanted].join(',')}, from ${startIndex}, in ${Date.now() - started}ms`);
      res.json(itemList(shelf, played.length, startIndex));
      return;
    }

    const searchTerm = req.query.SearchTerm ?? req.query.searchTerm;

    // Particular items by id, not a listing of whichever library comes first.
    const idsRaw = req.query.Ids ?? req.query.ids;
    if (idsRaw) {
      const ids = String(idsRaw).split(',').map((id) => id.trim()).filter(Boolean);
      const items: any[] = [];
      for (const id of ids) {
        const captured: any[] = [];
        // query and params are prototype getters, so a spread would lose them.
        const forged = Object.create(req, {
          params: { value: { ...req.params, itemId: id, listed: true, lookup: ids.length === 1 }, enumerable: true },
          query: { value: req.query, enumerable: true },
        });
        await singleItemHandler(
          forged,
          { json: (body: any) => captured.push(body), status: () => ({ json: () => undefined, end: () => undefined }) }
        );
        if (captured[0]?.Id) items.push(captured[0]);
      }
      res.json(itemList(items, items.length, 0));
      return;
    }

    // Clients send Genres pipe-delimited, or GenreIds holding our own guids.
    // A catalog's genre extra takes exactly one value, so only the first is
    // passed on rather than silently dropping the filter altogether.
    const genreNames: string[] = [];
    const rawGenres = req.query.Genres ?? req.query.genres ?? req.query.Genre ?? req.query.genre;
    if (typeof rawGenres === 'string' && rawGenres) {
      genreNames.push(...rawGenres.split('|').filter(Boolean));
    }

    const rawGenreIds = req.query.GenreIds ?? req.query.genreIds;
    if (!genreNames.length && typeof rawGenreIds === 'string' && rawGenreIds) {
      for (const id of rawGenreIds.split('|').filter(Boolean)) {
        const decoded = await decodeJellyfinId(id);
        if (decoded && decoded.k === 'genre') genreNames.push(decoded.g);
      }
    }

    // A client builds one row per kind by ruling out the kinds another row owns.
    // Where that leaves nothing this server publishes, the row wants to be empty
    // rather than filled with the same titles under a heading they do not belong
    // to. Only movies and episodes are video; a series is a folder.
    const queryList = (...values: any[]): Set<string> =>
      new Set(
        values
          .flat()
          .filter(Boolean)
          .flatMap((value: any) => String(value).split(','))
          .map((value: string) => value.trim())
          .filter(Boolean)
      );

    const excluded = queryList(req.query.ExcludeItemTypes ?? req.query.excludeItemTypes);
    const wantedMedia = queryList(req.query.MediaTypes ?? req.query.mediaTypes);

    if (excluded.size || wantedMedia.size) {
      const survives = (['Movie', 'Series', 'Episode'] as const).some((kind) => {
        if (excluded.has(kind)) return false;
        if (!wantedMedia.size) return true;
        return wantedMedia.has(kind === 'Series' ? 'Unknown' : 'Video');
      });

      if (!survives) {
        res.json(itemList([], 0, startIndex));
        return;
      }
    }

    const extras: Record<string, string> = {};
    if (genreNames.length) extras.genre = genreNames[0];

    if (genreNames.length > 1) {
      logger.debug(`Only the first of ${genreNames.length} genres is filterable: ${genreNames[0]}`);
    }

    const personIds = String(req.query.PersonIds ?? req.query.personIds ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    if (personIds.length) {
      const asked = req.query.Limit ?? req.query.limit;
      const take = asked === undefined ? envInt('JELLYFIN_FILMOGRAPHY_PAGE', 100, 1) : limit;
      const ascending = String(req.query.SortOrder ?? req.query.sortOrder ?? '').toLowerCase().startsWith('asc');
      const personTypes = String(req.query.PersonTypes ?? req.query.personTypes ?? '').split(',').map((v) => v.trim()).filter(Boolean);
      const { items, total } = await personItems(userUUID, config, serverId, personIds[0], includeItemTypes, personTypes, startIndex, take, ascending);
      res.json(itemList(items, total, startIndex));
      return;
    }

    // Clients build search rows here, one call per section: /Search/Hints is
    // a single flat list with no way to express them.
    if (searchTerm) {
      const kinds = includeItemTypes ? String(includeItemTypes).split(',').map((t) => t.trim()).filter(Boolean) : [];
      const titleKinds = kinds.filter((kind) => kind !== 'Person');
      const people = kinds.includes('Person') ? await peopleMatching(config, serverId, String(searchTerm)) : [];
      const titles = kinds.length && !titleKinds.length ? [] : await searchAcross(
        userUUID,
        config,
        serverId,
        String(searchTerm),
        startIndex + limit,
        kinds.length ? titleKinds.join(',') : includeItemTypes
      );
      const found = [...people, ...titles];
      const page = found.slice(startIndex, startIndex + limit);
      await applyWatchedState(page.filter((item: any) => item.Type !== 'Person'), await watchedSnapshot(userUUID, config), userUUID, profileKey(config), config, {
        indexWaitMs: envInt('JELLYFIN_SEARCH_INDEX_WAIT_MS', 3000, 0),
      });
      res.json(itemList(page, found.length, startIndex));
      return;
    }

    if (!parentId) {
      const recursive = String(req.query.Recursive ?? req.query.recursive ?? '')
        .toLowerCase() === 'true';

      if (!recursive) {
        const views = await buildViews(userUUID, serverId, config);
        res.json(itemList(views.slice(startIndex, startIndex + limit), views.length, startIndex));
        return;
      }

      // Nothing here carries an added-date, so a cross-library row is the
      // catalogs of that type walked in order, with one running offset across
      // all of them so paging does not restart at every catalog boundary.
      const wanted = includeItemTypes
        ? new Set(String(includeItemTypes).split(',').map((t) => t.trim()).filter(Boolean))
        : null;

      if (wanted?.has('BoxSet')) {
        const sets = await allBoxSets(userUUID, config, serverId);
        res.json(itemList(sets.slice(startIndex, startIndex + limit), sets.length, startIndex));
        return;
      }

      const pool = (await getCatalogs(userUUID, config)).filter((catalog: any) => isBrowsable(catalog) && !requiresGenre(catalog)).filter((catalog: any) => {
        if (!wanted || !wanted.size) return true;
        const kind = collectionTypeFor(catalog.type);
        if (kind === 'movies') return wanted.has('Movie');
        if (kind === 'tvshows') return wanted.has('Series');
        return true;
      });

      const collected: any[] = [];
      let passed = 0;
      const tags = profileTags(config);

      const typesKey = includeItemTypes ? String(includeItemTypes) : '';
      await warmCatalogLengths(userUUID, pool, extras, tags, typesKey);
      for (const catalog of pool) {
        if (collected.length >= limit) break;

        const known = knownCatalogLength(userUUID, catalog, extras, tags, typesKey);
        if (known !== undefined && passed + known <= startIndex) {
          passed += known;
          continue;
        }

        const skip = Math.max(0, startIndex - passed);
        const page = await fetchWindow(
          userUUID,
          catalog,
          skip,
          limit - collected.length,
          extras,
          includeTypesFilter(catalog.type, typesKey || undefined),
          tags,
          typesKey
        ).catch(() => ({ items: [] as any[], hasMore: false }));

        const viewId = encodeJellyfinId({ k: 'view', t: catalog.type, c: catalog.id });
        for (const meta of page.items) {
          if (!meta?.id || collected.length >= limit) continue;
          collected.push(metaToBaseItem(meta, catalog.type, serverId, viewId));
        }

        if (page.hasMore) break;
        passed += knownCatalogLength(userUUID, catalog, extras, tags, typesKey) ?? skip + page.items.length;
      }

      const across = filterByIncludeTypes(
        collected,
        includeItemTypes ? String(includeItemTypes) : undefined
      );
      await applyWatchedState(across, await watchedSnapshot(userUUID, config), userUUID, profileKey(config), config);

      res.json(itemList(across, startIndex + across.length, startIndex));
      return;
    }

    let catalog: any;
    {
      const descriptor = await decodeJellyfinId(String(parentId));

      if (descriptor && (descriptor.k === 'series' || descriptor.k === 'season')) {
        const meta = await fetchMeta(userUUID, 'series', descriptor.i);
        if (!meta) {
          res.json(itemList([], 0, startIndex));
          return;
        }
        // Episodes across a series is how a client finds the last one played.
        const wantsEpisodes =
          descriptor.k === 'season' ||
          (String(req.query.Recursive ?? req.query.recursive ?? '').toLowerCase() === 'true' &&
            String(includeItemTypes ?? '').split(',').map((t) => t.trim()).includes('Episode'));

        const played = playedFilter(req);
        const filters = [
          ...String(req.query.Filters ?? req.query.filters ?? '').split(',').map((f) => f.trim()),
          ...(played === 'played' ? ['IsPlayed'] : played === 'unplayed' ? ['IsUnplayed'] : []),
        ];
        const sortBy = String(req.query.SortBy ?? req.query.sortBy ?? '');
        const descending = String(req.query.SortOrder ?? req.query.sortOrder ?? '').toLowerCase() === 'descending';
        const applyState = async (items: any[]) =>
          applyWatchedState(items, await watchedSnapshot(userUUID, config), userUUID, profileKey(config), config, {
            seriesVideos: seriesVideosOf(meta),
          });

        // Filtering on played judges every child, so only an unfiltered page is built alone.
        if (wantsEpisodes && !filters.includes('IsPlayed') && !filters.includes('IsUnplayed')) {
          const windowed = pageEpisodes(
            meta,
            descriptor.t,
            encodeSeriesId(descriptor),
            serverId,
            descriptor.k === 'season' ? descriptor.s : null,
            { sortBy, descending, startIndex, limit }
          );
          await applyState(windowed.page);
          res.json(itemList(windowed.page, windowed.total, startIndex));
          return;
        }

        const children = wantsEpisodes
          ? buildEpisodes(meta, descriptor.t, encodeSeriesId(descriptor), serverId, descriptor.k === 'season' ? descriptor.s : null)
          : await withSeasonAnimeIds(meta, buildSeasons(meta, descriptor.t, String(parentId), serverId));

        const { page, total } = await pageChildren(
          children,
          { filters, sortBy, descending, startIndex, limit },
          applyState
        );

        res.json(itemList(page, total, startIndex));
        return;
      }

      if (descriptor?.k === 'collection') {
        const collection = collectionById(config, descriptor.c);
        const sets = collection ? await boxSetsFor(userUUID, config, serverId, collection) : [];
        res.json(itemList(sets.slice(startIndex, startIndex + limit), sets.length, startIndex));
        return;
      }

      if (descriptor?.k === 'boxset') {
        const collection = collectionById(config, descriptor.c);
        const folder = folderById(collection, descriptor.f);
        if (!collection || !folder) {
          res.json(itemList([], 0, startIndex));
          return;
        }
        const wantedTypes = includeItemTypes ? String(includeItemTypes).split(',').map((t) => t.trim()) : [];
        const children = !extras.genre && (!wantedTypes.length || wantedTypes.includes('BoxSet'))
          ? await boxSetsUnder(userUUID, config, serverId, collection, folder)
          : [];
        const pageCap = envInt('JELLYFIN_LIST_PAGE_MAX', 50, 20);
        const folderLimit = limit > pageCap * 2 ? pageCap : limit;
        const ahead = children.slice(startIndex, startIndex + folderLimit);
        const titlesFrom = Math.max(0, startIndex - children.length);
        const room = folderLimit - ahead.length;
        const page = room > 0
          ? await boxSetMembers(userUUID, config, serverId, collection, folder, titlesFrom, room, includeItemTypes ? String(includeItemTypes) : undefined, extras.genre)
          : { items: [], hasMore: true };
        await applyWatchedState(page.items, await watchedSnapshot(userUUID, config), userUUID, profileKey(config), config);
        const items = [...ahead, ...page.items];
        res.json(itemList(
          items,
          page.hasMore && items.length > 0 ? startIndex + items.length + folderLimit : startIndex + items.length,
          startIndex
        ));
        return;
      }

      if (descriptor?.k === 'movie' && String(descriptor.i).startsWith('tvdbc:')) {
        const set = await fetchMeta(userUUID, 'movie', descriptor.i);
        const memberIds = [...new Set<string>((Array.isArray(set?.videos) ? set.videos : []).map((v: any) => String(v?.id || '')).filter(Boolean))];
        const members: any[] = [];
        await mapWithConcurrency(memberIds, shelfConcurrency(), async (memberId, index) => {
          const meta = await fetchMeta(userUUID, 'movie', memberId);
          if (meta) members[index] = metaToBaseItem(meta, 'movie', serverId, String(parentId));
        });
        const listed = filterByIncludeTypes(members.filter(Boolean), includeItemTypes ? String(includeItemTypes) : undefined);
        const page = listed.slice(startIndex, startIndex + limit);
        await applyWatchedState(page, await watchedSnapshot(userUUID, config), userUUID, profileKey(config), config);
        res.json(itemList(page, listed.length, startIndex));
        return;
      }

      if (!descriptor || descriptor.k !== 'view') {
        res.json(itemList([], 0, startIndex));
        return;
      }
      const found = await findCatalogByViewId(userUUID, config, descriptor.t, descriptor.c);
      if (!found || (String(includeItemTypes ?? '') === 'BoxSet' && !isBoxSetCatalog(found))) {
        res.json(itemList([], 0, startIndex));
        return;
      }
      catalog = found;
    }

    // A few catalogs list nothing without a genre; a browsing client never sends one.
    if (!extras.genre && (await needsDefaultGenre(userUUID, catalog, profileTags(config)))) {
      const genreExtra = (catalog.extra ?? []).find((e: any) => e?.name === 'genre' && e?.default);
      if (genreExtra) extras.genre = String(genreExtra.default);
    }

    // A library that needs a genre lists nothing until one is picked.
    if (!extras.genre && requiresGenre(catalog)) {
      res.json(itemList([], 0, startIndex));
      return;
    }

    // A grid asking for hundreds at once is answered a folder page at a time, as
    // collection folders are, and reads on by the count; a row is filled as asked.
    const pageCap = envInt('JELLYFIN_LIST_PAGE_MAX', 50, 20);
    const pageLimit = limit > pageCap * 2 ? pageCap : limit;

    const played = await playedPick(req, userUUID, config, catalog.type, serverId, String(parentId));
    const window = await fetchWindow(
      userUUID,
      catalog,
      startIndex,
      pageLimit,
      extras,
      includeTypesFilter(catalog.type, includeItemTypes ? String(includeItemTypes) : undefined),
      profileTags(config),
      `${includeItemTypes ? String(includeItemTypes) : ''}${played.key}`,
      played.pick
    );
    const hasMore = window.hasMore;

    const items = window.items
      .filter((meta: any) => meta && meta.id)
      .map((meta: any) => metaToBaseItem(meta, catalog.type, serverId, String(parentId)));
    if (isLandscapeCatalog(config, catalog)) showLandscape(items);

    const filtered = filterByIncludeTypes(items, includeItemTypes ? String(includeItemTypes) : undefined)
      .slice(0, pageLimit);

    // Catalogs report no total, so one page of lookahead keeps the client asking
    // and collapses to the truth once the catalog runs out.
    const total = hasMore && filtered.length > 0
      ? startIndex + filtered.length + pageLimit
      : startIndex + filtered.length;

    await applyWatchedState(filtered, await watchedSnapshot(userUUID, config), userUUID, profileKey(config), config);
    res.json(itemList(filtered, total, startIndex));
  });

  const genreNeeded = new Map<string, boolean>();
  const needsDefaultGenre = async (userUUID: string, catalog: any, tags: string[]): Promise<boolean> => {
    const genreExtra = (catalog.extra ?? []).find((e: any) => e?.name === 'genre' && e?.default && e.default !== 'None');
    if (!genreExtra) return false;

    const key = `${catalog.type}|${catalog.id}|${tags.join(',')}`;
    const known = genreNeeded.get(key);
    if (known !== undefined) return known;

    const probe = await fetchWindow(userUUID, catalog, 0, 1, {}, undefined, tags);
    const needed = probe.items.length === 0;
    genreNeeded.set(key, needed);
    return needed;
  };

  const clientFor = (req: any, config: any): StreamClient | undefined =>
    streamClient(`${req.params.userUUID}:${profileKey(config)}`, clientInfo(req), req.get?.('user-agent'));

  const headerSources = new WeakSet<any>();

  const resolveMediaSources = async (
    req: any,
    descriptor: any,
    runtimeTicks: number | null,
    refresh = false,
    allowHeaders = false
  ): Promise<any[]> => {
    if (!descriptor || (descriptor.k !== 'movie' && descriptor.k !== 'episode')) return [];

    const config = await loadConfig(req);
    const base = normaliseStreamBase(config?.jellyfinStreamUrl || '');
    if (!base) {
      logger.warn(`No stream addon configured for ${req.params.userUUID}: it will show no streams for anything`);
      return [];
    }

    const stremioId = stremioIdFor(descriptor);
    if (!stremioId) return [];

    const stremioType = descriptor.k === 'movie' ? 'movie' : 'series';
    const client = clientFor(req, config);
    const cacheKey = streamCacheKey(req.params.userUUID, profileKey(config), stremioType, stremioId, client);

    const streams =
      (refresh ? undefined : recallStreams(cacheKey)) ??
      (await coalesce(cacheKey, async () => {
        const fetched = await fetchStreams(base, stremioType, stremioId, client);
        if (fetched.streams.length) rememberStreams(cacheKey, fetched.streams);
        if (fetched.failure) rememberFailure(cacheKey, fetched.failure);
        return fetched.streams;
      }));

    const seen = new Set<string>();
    const sources: any[] = [];
    const notices: any[] = [];
    for (const stream of streams) {
      const playable = toPlayable(stream, allowHeaders);
      if (!playable) {
        if (!streamNoticesOffered()) continue;
        const notice = toNotice(stream);
        if (!notice || seen.has(notice.id)) continue;
        seen.add(notice.id);
        notices.push(placeholderMediaSource(notice.id, notice.name));
        continue;
      }
      if (seen.has(playable.id)) continue;
      seen.add(playable.id);
      const source = mediaSourceFor(playable, runtimeTicks);
      if (playable.needsHeaders) headerSources.add(source);
      sources.push(source);
    }

    logger.debug(`Streams ${stremioType}/${stremioId}: ${streams.length} offered, ${sources.length} playable, ${notices.length} to read`);
    if (streams.length && !sources.length && !notices.length) rememberFailure(cacheKey, 'No playable stream for this title');
    return [...sources.slice(0, maxMediaSources()), ...notices];
  };

  // What the picker says when a resolve leaves nothing to list.
  const streamFailure = async (req: any, descriptor: any): Promise<string> => {
    const stremioId = stremioIdFor(descriptor);
    const stremioType = descriptor.k === 'movie' ? 'movie' : 'series';
    const config = await loadConfig(req);
    const key = streamCacheKey(req.params.userUUID, profileKey(config), stremioType, stremioId, clientFor(req, config));
    return recallFailure(key) ?? 'No streams found for this title';
  };

  /**
   * Real sources replace the placeholder, and the item mirrors the default
   * source's tracks and container: a client reads those off the item, not only
   * off the source.
   */
  // A single item carries its versions inline, as a real server's does: a
  // client builds its picker from them and asks PlaybackInfo only to play. The
  // page is not held past the budget; the placeholder stays when it runs out.
  // A client asking for MediaSources plays nothing without them.
  const asksForSources = (req: any): boolean =>
    /\bMediaSources\b/i.test(String(req.query?.Fields ?? req.query?.fields ?? ''));

  // Instance rule first; on resolves streams when a title opens.
  const resolveOnOpen = async (req: any): Promise<boolean> => {
    const mode = String(require('../settingsService').getSetting('JELLYFIN_RESOLVE_ON_OPEN') || 'user');
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    return (await loadConfig(req))?.jellyfinResolveOnOpen === true;
  };

  const streamsKnown = async (req: any, descriptor: any): Promise<'cached' | 'fetching' | null> => {
    if (!descriptor || (descriptor.k !== 'movie' && descriptor.k !== 'episode')) return null;
    const stremioId = stremioIdFor(descriptor);
    if (!stremioId) return null;
    const type = descriptor.k === 'movie' ? 'movie' : 'series';
    const config = await loadConfig(req);
    return streamsState(streamCacheKey(req.params.userUUID, profileKey(config), type, stremioId, clientFor(req, config)));
  };

  const attachSourcesInTime = async (req: any, item: any, descriptor: any, itemId: string): Promise<void> => {
    if (req.params?.listed && !req.params?.lookup) return;
    const asked = req.params?.forceSources || asksForSources(req);
    const known = asked ? null : await streamsKnown(req, descriptor);
    const on = asked || known === 'cached' || req.params?.listed ? false : await resolveOnOpen(req);
    if (asked || known === 'cached' || (on && known === 'fetching')) {
      await attachSources(req, item, descriptor, itemId).catch((error: any) =>
        logger.debug(`Sources for ${itemId} unavailable: ${error?.message || error}`)
      );
      return;
    }
    if (on) {
      void resolveMediaSources(req, descriptor, item.RunTimeTicks ?? null).catch((error: any) =>
        logger.debug(`Background sources for ${itemId} unavailable: ${error?.message || error}`)
      );
    }
  };

  // Subtitle addons answer IMDb ids, so an anime id is spelled that way first,
  // through the same anidb pivot the watch tracking uses.
  const imdbVideoId = async (videoId: string, type: 'movie' | 'series'): Promise<string> => {
    if (videoId.startsWith('tt')) return videoId;
    const idMapper: any = require('../id-mapper');
    const parsed = parseStremioId(videoId);
    if (!parsed) return videoId;
    if (type === 'series') {
      const { videoIdAliases } = require('./aliases');
      const imdb = (await videoIdAliases(videoId)).find((alias: string) => alias.startsWith('tt'));
      return imdb ?? videoId;
    }
    const numeric = parseInt(parsed.base.split(':')[1], 10);
    const mapping =
      parsed.idType === 'kitsu' ? idMapper.getMappingByKitsuId(numeric)
      : parsed.idType === 'mal' ? idMapper.getMappingByMalId(numeric) ?? { type: 'MOVIE', mal_id: numeric }
      : parsed.idType === 'anilist' ? idMapper.getMappingByAnilistId(numeric)
      : null;
    const imdb = idMapper.filmIdsFor(mapping).imdbId;
    return imdb ? String(imdb) : videoId;
  };

  const subtitleKey = (userUUID: string, itemId: string, sourceId: string): string =>
    `${userUUID}:${normaliseJellyfinId(itemId)}:${normaliseJellyfinId(sourceId)}`;

  /**
   * Subtitle files a client can fetch, as external streams after the embedded
   * ones: those the stream carries, and for the source being played, those the
   * stream addon finds for that file. The route serves them by the index sent.
   */
  const attachExternalSubtitles = async (
    req: any,
    itemId: string,
    sources: any[],
    opts: { profile?: any; addonFor?: string | null }
  ): Promise<void> => {
    const userUUID = req.params.userUUID;
    const token = req.jellyfin?.token ? `?api_key=${encodeURIComponent(req.jellyfin.token)}` : '';
    const client = clientInfo(req).client;
    const config = await loadConfig(req);
    const base = normaliseStreamBase(config?.jellyfinStreamUrl || '');

    for (const source of sources) {
      const file = fileFor(source);
      const tracks: SubtitleTrack[] = [...file.subtitles];
      const wantsAddon = opts.addonFor && normaliseJellyfinId(source.Id) === normaliseJellyfinId(opts.addonFor);
      if (wantsAddon && base) {
        const descriptor = await decodeJellyfinId(itemId);
        const videoId = descriptor ? stremioIdFor(descriptor) : null;
        if (videoId) {
          const type = descriptor.k === 'movie' ? 'movie' : 'series';
          const seen = new Set(tracks.map((t) => t.url));
          for (const track of await fetchAddonSubtitles(base, type, await imdbVideoId(videoId, type), file.hints, streamUserAgent())) {
            if (!seen.has(track.url)) tracks.push(track);
          }
        }
      }
      if (!tracks.length) continue;

      // A subtitle addon answers with dozens of files per language; a menu wants a few of each.
      const kept = pickSubtitles(
        tracks.map((track) => ({ ...track, language: subtitleLanguage(track.lang, languageCode) })),
        envInt('JELLYFIN_SUBTITLES_PER_LANGUAGE', 3, 1),
        envInt('JELLYFIN_SUBTITLES_MAX', 40, 1)
      );

      const streams: any[] = Array.isArray(source.MediaStreams) ? source.MediaStreams : [];
      const start = streams.length;
      kept.forEach((track, i) => {
        const index = start + i;
        const format = subtitleFormatFor(opts.profile, client, subtitleExtensionOf(track.url));
        const url = `/Videos/${itemId}/${source.Id}/Subtitles/${index}/0/Stream.${format}${token}`;
        const name = languageName(track.language) ?? track.lang;
        const title = track.ordinal > 1 ? `${name} ${track.ordinal}` : name;
        streams.push({
          Type: 'Subtitle',
          Index: index,
          Codec: subtitleCodecFor(format),
          Language: track.language,
          Title: title,
          DisplayTitle: `${title} (external)`,
          IsDefault: false,
          IsForced: false,
          IsHearingImpaired: false,
          IsOriginal: false,
          IsInterlaced: false,
          IsExternal: true,
          IsExternalUrl: false,
          IsTextSubtitleStream: true,
          SupportsExternalStream: true,
          DeliveryMethod: 'External',
          DeliveryUrl: url,
          Path: url,
        });
      });
      source.MediaStreams = streams;
      rememberOffered(subtitleKey(userUUID, itemId, source.Id), kept);
    }
  };

  const attachSources = async (
    req: any,
    item: any,
    descriptor: any,
    itemId: string
  ): Promise<void> => {
    const resolved = await withDefaultSourceId(
      await resolveMediaSources(req, descriptor, item.RunTimeTicks ?? null),
      itemId
    );
    if (!resolved.length) {
      if (!Array.isArray(item.MediaSources) || !item.MediaSources.length) return;
      const reason = placeholderMediaSource(item.MediaSources[0].Id, await streamFailure(req, descriptor));
      item.MediaSources = [reason, ...item.MediaSources.slice(1)];
      item.MediaStreams = reason.MediaStreams;
      return;
    }
    await attachExternalSubtitles(req, itemId, resolved, {});

    item.MediaSources = resolved;
    item.MediaStreams = resolved[0].MediaStreams;
    item.Container = resolved[0].Container;
    if (resolved.length > 1) item.MediaSourceCount = resolved.length;
  };

  /**
   * A client picks the source whose Id matches the item's own, so the default
   * one has to carry the item guid rather than its own hash or nothing is
   * selectable.
   */
  const withDefaultSourceId = async (sources: any[], itemId: string): Promise<any[]> => {
    const first = sources.findIndex((source) => !headerSources.has(source));
    if (first < 0) return sources;
    const id = normaliseJellyfinId(itemId);
    // A play report then names the item, not the hash the duration sits under.
    const ms = await recallDuration(sources[first].Id).catch(() => null);
    if (ms) rememberDuration(id, ms);
    else forgetDuration(id);
    return sources.map((source, index) =>
      index === first ? { ...source, Id: id, ETag: id } : source
    );
  };

  const unwrapMarker = async (itemId: string): Promise<{ itemId: string; descriptor: any }> => {
    const descriptor = await decodeJellyfinId(itemId);
    if (descriptor?.k === 'marker') return { itemId: descriptor.i, descriptor: await decodeJellyfinId(descriptor.i) };
    return { itemId, descriptor };
  };

  const requestedSource = async (value: unknown): Promise<string | undefined> => {
    if (typeof value !== 'string' || !value) return undefined;
    return (await decodeJellyfinId(value))?.k === 'marker' ? undefined : value;
  };

  const outsideViewingHours = async (req: any): Promise<boolean> => {
    const config = await loadConfig(req);
    if (!config) return false;
    return !playbackAllowed(sessionProfile(req, config).viewingHours, viewingTimeZone(config));
  };

  const playbackHandler = async (req: any, res: any) => {
    const { itemId, descriptor } = await unwrapMarker(String(req.params.itemId));

    if (!descriptor || (descriptor.k !== 'movie' && descriptor.k !== 'episode')) {
      res.status(404).json({ MediaSources: [], PlaySessionId: '', ErrorCode: 'NotAllowed' });
      return;
    }

    if (await outsideViewingHours(req)) {
      res.json({ MediaSources: [], PlaySessionId: randomUUID(), ErrorCode: 'NotAllowed' });
      return;
    }

    const requested = await requestedSource(req.query.MediaSourceId ?? req.query.mediaSourceId ?? req.body?.MediaSourceId);
    // A named version keeps the list it came from.
    const named = typeof requested === 'string' && !!requested && normaliseJellyfinId(requested) !== normaliseJellyfinId(itemId);
    const all = await resolveMediaSources(req, descriptor, null, req.body?.Refresh === true && !named, req.body?.EnableRequiredHttpHeaders === true);
    const withIds = await withDefaultSourceId(all, itemId);

    let sources = withIds;
    if (typeof requested === 'string' && requested && normaliseJellyfinId(requested) !== normaliseJellyfinId(itemId)) {
      const picked = withIds.filter((s: any) => normaliseJellyfinId(s.Id) === normaliseJellyfinId(requested));
      if (picked.length) sources = picked;
    }

    if (!sources.length) {
      res.json({ MediaSources: [], PlaySessionId: randomUUID(), ErrorCode: 'NoCompatibleStream' });
      return;
    }

    // A segments request names the item and follows this, so the item's length is the picked version's.
    if (sources[0].Id !== normaliseJellyfinId(itemId)) {
      const ms = await recallDuration(sources[0].Id).catch(() => null);
      if (ms) rememberDuration(normaliseJellyfinId(itemId), ms);
      else forgetDuration(normaliseJellyfinId(itemId));
    }

    await attachExternalSubtitles(req, itemId, sources, {
      profile: req.body?.DeviceProfile,
      addonFor: sources[0].Id,
    });
    res.json({ MediaSources: sources, PlaySessionId: randomUUID() });
  };

  const subtitleHandler = async (req: any, res: any) => {
    const { itemId, descriptor } = await unwrapMarker(String(req.params.itemId));
    if (!descriptor || (descriptor.k !== 'movie' && descriptor.k !== 'episode')) {
      res.status(404).end();
      return;
    }
    const userUUID = req.params.userUUID;
    const sourceId = String(req.params.mediaSourceId);
    const index = parseInt(String(req.params.index), 10);
    const format = formatOf(String(req.params.format));

    const sources = await withDefaultSourceId(await resolveMediaSources(req, descriptor, null, false, true), itemId);
    const source = sources.find((s: any) => normaliseJellyfinId(s.Id) === normaliseJellyfinId(sourceId));
    if (!source) {
      res.status(404).end();
      return;
    }
    const embedded = Array.isArray(source.MediaStreams) ? source.MediaStreams.length : 0;
    const key = subtitleKey(userUUID, itemId, sourceId);
    let tracks = recallOffered(key);
    if (!tracks) {
      await attachExternalSubtitles(req, itemId, [source], { addonFor: source.Id });
      tracks = recallOffered(key) ?? [];
    }
    const track = tracks[index - embedded];
    if (!track) {
      res.status(404).end();
      return;
    }

    const converted = await subtitleBody(track.url, format);
    if (!converted) {
      res.status(502).end();
      return;
    }
    res.set('Content-Type', converted.contentType);
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(converted.body);
  };

  router.get(
    [
      '/Videos/:itemId/:mediaSourceId/Subtitles/:index/Stream.:format',
      '/Videos/:itemId/:mediaSourceId/Subtitles/:index/:start/Stream.:format',
    ],
    subtitleHandler
  );

  // Some clients never fetch the URL a MediaSource carries: they ask the server
  // for the video and expect to be sent on.
  const videoStreamHandler = async (req: any, res: any) => {
    const { itemId, descriptor } = await unwrapMarker(String(req.params.itemId));
    if (!descriptor || (descriptor.k !== 'movie' && descriptor.k !== 'episode')) {
      res.status(404).json({ Message: 'Item not found' });
      return;
    }

    if (/\/Download$/i.test(String(req.path))) {
      const config = await loadConfig(req);
      if (config && sessionProfile(req, config).downloads === false) {
        res.status(403).json({ Message: 'Downloads are turned off for this user' });
        return;
      }
    }
    if (await outsideViewingHours(req)) {
      res.status(403).json({ Message: 'Outside this user\'s viewing hours' });
      return;
    }

    const requested = await requestedSource(req.query.MediaSourceId ?? req.query.mediaSourceId);
    const wantedId = typeof requested === 'string' && requested ? normaliseJellyfinId(requested) : null;

    // A source the client already holds is sent to the URL it was issued with.
    // The stream addon's URL stands on its own, so nothing is resolved again: a
    // fresh search can come back without the file, and did, mid-playback.
    if (wantedId && wantedId !== normaliseJellyfinId(itemId)) {
      const pinned = await recallIssued(wantedId);
      if (pinned) {
        const ms = await recallDuration(wantedId).catch(() => null);
        if (ms) rememberDuration(normaliseJellyfinId(itemId), ms);
        else forgetDuration(normaliseJellyfinId(itemId));
        res.redirect(302, pinned);
        return;
      }
    }

    // No pin for it, so it is resolved: a client that never called PlaybackInfo
    // or has outlived the pin gets the source matched from a fresh list.
    const sources = await withDefaultSourceId(await resolveMediaSources(req, descriptor, null), itemId);
    if (!sources.length) {
      res.status(404).json({ Message: 'No playable stream' });
      return;
    }

    const wanted = wantedId
      ? sources.find((s: any) => normaliseJellyfinId(s.Id) === wantedId)
      : undefined;

    if (wantedId && !wanted) {
      logger.debug(`Source ${requested} is no longer offered for ${itemId}`);
      res.status(404).json({ Message: 'Media source not found' });
      return;
    }

    const chosen = wanted ?? sources[0];
    if (!chosen?.Path) {
      res.status(404).json({ Message: 'No playable stream' });
      return;
    }

    logger.debug(`Redirecting ${itemId} to its source`);
    res.redirect(302, chosen.Path);
  };

  router.get(
    [
      '/Videos/:itemId/stream',
      '/Videos/:itemId/stream.:ext',
      '/Videos/:itemId/stream/:filename',
      '/Videos/:itemId/original',
      '/Videos/:itemId/original.:ext',
      '/Items/:itemId/Download',
    ],
    videoStreamHandler
  );

  router.get('/Items/:itemId/PlaybackInfo', playbackHandler);
  router.post('/Items/:itemId/PlaybackInfo', playbackHandler);
  router.get('/Items/:itemId/MediaSources', async (req: any, res: any) => {
    const captured: any[] = [];
    await playbackHandler(req, {
      json: (body: any) => captured.push(body),
      status: () => ({ end: () => undefined, json: () => undefined }),
    });
    res.json(captured[0]?.MediaSources ?? []);
  });

  const genreOptionsFor = async (req: any, parentId: any): Promise<{ catalog: any; genres: string[] }> => {
    const config = await loadConfig(req);
    if (!config || !parentId) return { catalog: null, genres: [] };

    const descriptor = await decodeJellyfinId(String(parentId));
    if (descriptor?.k === 'boxset') {
      const folder = folderById(collectionById(config, descriptor.c), descriptor.f);
      return folder ? boxSetGenres(req.params.userUUID, config, folder) : { catalog: null, genres: [] };
    }
    if (!descriptor || descriptor.k !== 'view') return { catalog: null, genres: [] };

    const catalog = await findCatalogByViewId(req.params.userUUID, config, descriptor.t, descriptor.c);
    if (!catalog) return { catalog: null, genres: [] };

    const extra = (catalog.extra ?? []).find((e: any) => e?.name === 'genre');
    const options = Array.isArray(extra?.options) ? extra.options : [];
    return {
      catalog,
      genres: options.filter((g: any) => typeof g === 'string' && g),
    };
  };

  // Each catalog returns its own ranked list, so results are interleaved rather
  // than concatenated: one catalog's weak matches would bury another's best.
  const isoDate = (value: any): string | null => {
    const at = Date.parse(String(value ?? ''));
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
  };
  const personItem = (id: string, serverId: string, name: string, person: any): any => {
    const bare = normaliseJellyfinId(id);
    if (person?.photo) rememberImages(serverId, bare, { primary: person.photo });
    return {
      Name: person?.name || name,
      SortName: sortNameFor(person?.name || name),
      Id: bare,
      ServerId: serverId,
      Type: 'Person',
      Overview: person?.biography || '',
      PremiereDate: isoDate(person?.birthday),
      EndDate: isoDate(person?.deathday),
      ProductionLocations: person?.birthplace ? [person.birthplace] : [],
      // Not a Jellyfin field: the PersonTypes value a filmography opens on.
      KnownForType: person?.knownFor ?? undefined,
      ImageTags: person?.photo ? { Primary: imageTag(person.photo) } : {},
      BackdropImageTags: [],
      UserData: { ...EMPTY_USER_DATA, Key: bare, ItemId: bare },
    };
  };

  const peopleMatching = async (config: any, serverId: string, term: string): Promise<any[]> => {
    const person = await personByName(config, term).catch(() => null);
    if (!person) return [];
    const id = encodeJellyfinId({ k: 'person', n: person.name, s: person.source, x: person.id });
    return [personItem(id, serverId, person.name, person)];
  };

  const personItems = async (
    userUUID: string,
    config: any,
    serverId: string,
    personId: string,
    includeItemTypes: any,
    personTypes: string[],
    startIndex: number,
    take: number,
    ascending = false
  ): Promise<{ items: any[]; total: number }> => {
    const descriptor = await decodeJellyfinId(personId);
    if (!descriptor || descriptor.k !== 'person') return { items: [], total: 0 };
    const person = await resolvePerson(config, descriptor);
    if (!person) return { items: [], total: 0 };
    const wanted = includeItemTypes ? String(includeItemTypes) : undefined;
    const newest = (await personCredits(config, person)).filter(
      (meta: any) =>
        (!wanted || wanted.split(',').map((t) => t.trim()).includes(meta.type === 'movie' ? 'Movie' : 'Series')) &&
        (!personTypes.length || personTypes.some((kind) => meta._personTypes.includes(kind)))
    );
    const listed = ascending
      ? [...newest.filter(hasCreditDate).reverse(), ...newest.filter((meta: any) => !hasCreditDate(meta))]
      : newest;
    const page = listed.slice(startIndex, startIndex + take);
    const cards = await titleCards(config, userUUID, page);
    const items = cards.map((card: any, i: number) => metaToBaseItem(card, page[i].type, serverId, null)).filter(keepsUnderProfileCap(config));
    await applyWatchedState(items, await watchedSnapshot(userUUID, config), userUUID, profileKey(config), config);
    return { items, total: listed.length };
  };

  const searchAcross = async (
    userUUID: string,
    config: any,
    serverId: string,
    term: string,
    limit: number,
    includeItemTypes: any
  ): Promise<any[]> => {
    // Only catalogs whose type could answer: asking a movie-only catalog for
    // Series spends a request on a result that would be filtered away.
    const wanted = includeItemTypes
      ? new Set(String(includeItemTypes).split(',').map((t) => t.trim()).filter(Boolean))
      : null;
    const catalogs = getSearchableCatalogs(await getCatalogs(userUUID, config)).filter(
      (catalog: any) => {
        if (!wanted || !wanted.size) return true;
        const kind = collectionTypeFor(catalog.type);
        if (kind === 'movies') return wanted.has('Movie');
        if (kind === 'tvshows') return wanted.has('Series');
        return true;
      }
    );

    // One page per catalog; a second page of an AI or MAL search is another full query.
    const pages = await Promise.all(
      catalogs.map((catalog: any) =>
        fetchCatalogPage(userUUID, catalog.type, catalog.id, { search: term, light: '1' }, profileTags(config))
          .then((items) => ({ catalog, items: (items ?? []).slice(0, limit) }))
          .catch(() => ({ catalog, items: [] as any[] }))
      )
    );

    const seen = new Set<string>();
    const items: any[] = [];
    const depth = Math.max(0, ...pages.map((p) => p.items.length));
    for (let rank = 0; rank < depth; rank++) {
      for (const page of pages) {
        const meta = page.items[rank];
        if (!meta?.id) continue;
        if (seen.has(String(meta.id))) continue;
        // An untyped catalog such as AI search would give the same film a
        // second id, and a client merging two calls then shows it twice.
        const kind = collectionTypeFor(page.catalog.type) ? page.catalog.type : meta.type === 'movie' ? 'movie' : 'series';
        const item = metaToBaseItem(meta, kind, serverId, null);
        // The same title reaches us from more than one catalog under different
        // ids, so identity alone cannot spot the repeat. Only the leading year
        // is compared: one catalog says '2023-' where another says '2023-2024'.
        const year = String(meta.year ?? meta.releaseInfo ?? '').slice(0, 4);
        const title = `${String(meta.name || '').toLowerCase()}|${year}|${item.Type}`;
        if (meta.name && seen.has(title)) continue;
        seen.add(String(meta.id));
        if (meta.name) seen.add(title);
        items.push(item);
      }
    }

    return filterByIncludeTypes(items, includeItemTypes ? String(includeItemTypes) : undefined);
  };

  // A client's search asks for people alongside titles; the best match by name is the one shown.
  router.get('/Persons', async (req: any, res: any) => {
    const term = String(req.query.SearchTerm ?? req.query.searchTerm ?? '').trim();
    const config = await loadConfig(req);
    if (!term || !config) {
      res.json(itemList([], 0, 0));
      return;
    }
    const people = await peopleMatching(config, serverIdFor(req.params.userUUID), term);
    res.json(itemList(people, people.length, 0));
  });

  const toHint = (item: any) => ({
    ItemId: item.Id,
    Id: item.Id,
    Name: item.Name,
    Type: item.Type,
    MediaType: item.MediaType ?? 'Video',
    ProductionYear: item.ProductionYear,
    PrimaryImageTag: item.ImageTags?.Primary,
    BackdropImageTag: item.BackdropImageTags?.[0],
    BackdropImageItemId: item.Id,
    PrimaryImageAspectRatio: item.PrimaryImageAspectRatio,
    RunTimeTicks: item.RunTimeTicks,
    Artists: [],
  });

  // LumiereDB's typeahead, for a search bar asking on each key press. Nothing else is
  // fast enough to answer it, so without it there are no hints. It carries no age
  // ratings, so a capped profile gets none either.
  const suggestHints = async (config: any, serverId: string, term: string, limit: number, includeItemTypes: any): Promise<any[]> => {
    const { lumiereApiBase } = require('../../utils/lumiereLists');
    const { fetchLumiereSuggest } = require('../../utils/lumiereSearch');
    const { getSetting } = require('../settingsService');
    const base = lumiereApiBase();
    if (!base || hasAgeRatingCap(config)) return [];

    const wanted = includeItemTypes
      ? new Set(String(includeItemTypes).split(',').map((t) => t.trim()).filter(Boolean))
      : null;
    const movies = !wanted || !wanted.size || wanted.has('Movie');
    const shows = !wanted || !wanted.size || wanted.has('Series');
    if (!movies && !shows) return [];

    const timeoutMs = parseInt(getSetting('LUMIERE_SUGGEST_TIMEOUT_MS'), 10) || 1500;
    const found = await fetchLumiereSuggest(base, movies && shows ? null : movies ? 'movie' : 'series', term, limit, !!config.includeAdult, timeoutMs);
    // Metahub's poster, kept by its tag alone so it never replaces the title's own art.
    return (found ?? []).map((title: any) => {
      const item = metaToBaseItem({ id: title.imdbId, type: title.kind, name: title.title, releaseInfo: title.year ? String(title.year) : undefined }, title.kind, serverId, null);
      const poster = `https://images.metahub.space/poster/medium/${title.imdbId}/img`;
      rememberArt(poster);
      item.ImageTags = { ...item.ImageTags, Primary: imageTag(poster) };
      return item;
    });
  };

  router.get('/Search/Hints', async (req: any, res: any) => {
    const term = String(req.query.SearchTerm ?? req.query.searchTerm ?? '').trim();
    const limit = Math.min(Math.max(1, qInt(req, 'Limit', 20)), 50);
    const includeItemTypes = req.query.IncludeItemTypes ?? req.query.includeItemTypes;

    const config = term ? await loadConfig(req) : null;
    if (!config) {
      res.json({ SearchHints: [], TotalRecordCount: 0 });
      return;
    }

    const items = await suggestHints(config, serverIdFor(req.params.userUUID), term, limit, includeItemTypes).catch((error: any) => {
      logger.debug(`Search suggestions unavailable: ${error.message}`);
      return [];
    });
    res.json({ SearchHints: items.map(toHint), TotalRecordCount: items.length });
  });

  router.get('/Genres', async (req: any, res: any) => {
    const parentId = req.query.ParentId ?? req.query.parentId;
    const { catalog, genres } = await genreOptionsFor(req, parentId);
    if (!catalog) {
      res.json(itemList([], 0, 0));
      return;
    }

    const serverId = serverIdFor(req.params.userUUID);
    const items = genres.map((genre: string) => ({
      Name: genre,
      Id: encodeJellyfinId({ k: 'genre', t: catalog.type, c: catalog.id, g: genre }),
      ServerId: serverId,
      Type: 'Genre',
      IsFolder: false,
      ImageTags: {},
      BackdropImageTags: [],
      ImageBlurHashes: {},
    }));
    res.json(itemList(items, items.length, 0));
  });

  /**
   * A genre is looked up by name across every browsable catalog, since the
   * client asking has only the name. An unmatched name still answers with a
   * genre rather than a 404, so a stale link renders instead of erroring.
   */
  router.get('/Genres/:name', async (req: any, res: any) => {
    const name = decodeURIComponent(String(req.params.name));
    const serverId = serverIdFor(req.params.userUUID);
    const config = await loadConfig(req);

    let match: { catalog: any; genre: string } | null = null;
    if (config) {
      const catalogs = (await getCatalogs(req.params.userUUID, config)).filter(isBrowsable);
      for (const catalog of catalogs) {
        const extra = (catalog.extra ?? []).find((e: any) => e?.name === 'genre');
        const options: any[] = Array.isArray(extra?.options) ? extra.options : [];
        const found = options.find(
          (g: any) => typeof g === 'string' && g.toLowerCase() === name.toLowerCase()
        );
        if (found) {
          match = { catalog, genre: found };
          break;
        }
      }
    }

    res.json({
      Name: match ? match.genre : name,
      Id: encodeJellyfinId({
        k: 'genre',
        t: match ? match.catalog.type : 'movie',
        c: match ? match.catalog.id : '',
        g: match ? match.genre : name,
      }),
      ServerId: serverId,
      Type: 'Genre',
      IsFolder: false,
      ImageTags: {},
      BackdropImageTags: [],
      ImageBlurHashes: {},
    });
  });

  const genrePairs = async (req: any): Promise<{ genres: string[]; pairs: any[] }> => {
    const parentId = req.query.ParentId ?? req.query.parentId;
    const { catalog, genres } = await genreOptionsFor(req, parentId);
    const serverId = serverIdFor(req.params.userUUID);
    const pairs = catalog
      ? genres.map((genre: string) => ({
          Name: genre,
          Id: encodeJellyfinId({ k: 'genre', t: catalog.type, c: catalog.id, g: genre }),
          ServerId: serverId,
        }))
      : [];
    return { genres, pairs };
  };

  router.get('/Items/Filters', async (req: any, res: any) => {
    const { genres, pairs } = await genrePairs(req);
    res.json({ Genres: genres, Tags: [], OfficialRatings: [], Years: [], GenreItems: pairs });
  });

  // Unlike the legacy route, genres here are { Name, Id } pairs.
  router.get('/Items/Filters2', async (req: any, res: any) => {
    const { pairs } = await genrePairs(req);
    res.json({
      Genres: pairs.map(({ Name, Id }: any) => ({ Name, Id })),
      Tags: [],
      AudioLanguages: [],
      SubtitleLanguages: [],
    });
  });

  /**
   * Images are remembered as items are built, which a client outlives: it holds
   * ids across a restart and asks for their art before anything has rebuilt
   * them. Resolving from the id keeps posters working instead of every one
   * turning into a 404 until the list happens to be walked again.
   */
  const imagesFor = async (req: any, itemId: string): Promise<any | undefined> => {
    const userUUID = req.params.userUUID;
    const scope = serverIdFor(userUUID);
    await loadConfig(req).catch(() => null);

    const known = await recallImages(scope, itemId);
    if (known) return known;

    const descriptor = await decodeJellyfinId(itemId);
    if (!descriptor) return undefined;
    if (descriptor.k === 'movie' || descriptor.k === 'series' || descriptor.k === 'season') {
      const stremioType = descriptor.k === 'movie' ? 'movie' : 'series';
      const meta = await fetchMeta(userUUID, stremioType, descriptor.i);
      if (!meta) return undefined;
      metaToBaseItem(meta, descriptor.t, scope, null);
      return (await recallImages(scope, itemId)) ?? {
        primary: meta.poster || undefined,
        backdrop: meta.background || undefined,
        logo: meta.logo || undefined,
        thumb: meta.landscapePoster || undefined,
      };
    }

    if (descriptor.k === 'episode') {
      const meta = await fetchMeta(userUUID, 'series', descriptor.i);
      if (!meta) return undefined;
      const video = findEpisodeVideo(meta, descriptor);
      if (video) buildEpisode(meta, video, descriptor.t, encodeSeriesId(descriptor), scope);
      return (await recallImages(scope, itemId)) ?? { primary: meta.poster || undefined };
    }

    if (descriptor.k === 'collection' || descriptor.k === 'boxset') {
      const config = await loadConfig(req);
      const collection = config ? collectionById(config, descriptor.c) : null;
      if (!collection) return undefined;
      if (descriptor.k === 'collection') collectionView(scope, collection, null);
      else await boxSetsDeep(userUUID, config, scope, collection);
      return recallImages(scope, itemId);
    }

    return undefined;
  };

  // Walked for a breadcrumb when a client opens an item. A season names its
  // series, an episode both, and anything else has no parent worth naming.
  router.get('/Items/:itemId/Ancestors', async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const descriptor = await decodeJellyfinId(String(req.params.itemId));
    if (!descriptor || (descriptor.k !== 'episode' && descriptor.k !== 'season')) {
      res.json([]);
      return;
    }

    const found = descriptor.k === 'episode'
      ? await seriesForEpisode(userUUID, await loadConfig(req), descriptor)
      : await fetchMeta(userUUID, 'series', descriptor.i).then((meta: any) => (meta ? { meta, seriesId: encodeSeriesId(descriptor) } : null));
    if (!found) {
      res.json([]);
      return;
    }
    const meta = found.meta;

    const serverId = serverIdFor(userUUID);
    const series = metaToBaseItem(meta, descriptor.t, serverId, null);
    const chain: any[] = [];

    if (descriptor.k === 'episode') {
      const video = findEpisodeVideo(meta, descriptor);
      const number = (Number.isInteger(video?.season) ? video.season : null) ?? descriptor.s;
      const season = number === null || number === undefined
        ? null
        : buildSeasons(meta, descriptor.t, series.Id, serverId).find((entry: any) => entry.IndexNumber === number);
      if (season) chain.push(season);
    }

    chain.push(series);
    res.json(chain);
  });

  router.get(['/Items/:itemId/Images/:imageType', '/Items/:itemId/Images/:imageType/:index'], async (req: any, res: any) => {
    const requested = String(req.params.imageType).toLowerCase();
    const tag = String(req.query.tag ?? req.query.Tag ?? '');
    const images = await imagesFor(req, String(req.params.itemId));
    const wide = requested === 'primary' && isWideTag(tag);
    const kind = wide ? (images?.thumb ? 'thumb' : 'backdrop') : requested;
    let url =
      kind === 'primary' ? images?.primary
      : kind === 'backdrop' ? images?.backdrop
      : kind === 'logo' ? images?.logo
      : kind === 'thumb' ? images?.thumb
      : undefined;
    const named = tag ? artTag(tag) : '';
    if (named && (!url || imageTag(url) !== named)) {
      url = (await recallArt(named)) ?? url;
    }

    if (!url) {
      res.status(404).end();
      return;
    }
    const maxWidth = qInt(req, 'MaxWidth', 0) || qInt(req, 'FillWidth', 0) || qInt(req, 'Width', 0);
    url = sourceSized(url, kind, maxWidth);
    const descriptor = await decodeJellyfinId(String(req.params.itemId));
    const collectionArt = descriptor?.k === 'collection' || descriptor?.k === 'boxset';

    const relaying = relaysImages(req);
    const cached = throughPosterCache(url, collectionArt ? 'collection' : descriptor?.k === 'episode' && kind === 'primary' ? 'thumb' : kind);
    if (cached) {
      const local = builtinPosterCachePath(cached);
      if (local) {
        const step = hasRenditions(url) ? null : widthStep(maxWidth);
        await serveFromPosterCache(req, res, local, cached, step);
        return;
      }
      if (relaying) {
        await relayImage(req, res, cached);
        return;
      }
      res.set('Cache-Control', 'public, max-age=86400');
      res.redirect(302, cached);
      return;
    }
    // An episode still is 16:9; shaping it to 2:3 blurs and enlarges it for
    // nothing. Only the sources that publish landscape posters are reshaped.
    const poster = kind === 'primary' && !collectionArt && descriptor?.k !== 'episode';
    if (poster && shapesPoster(url)) {
      await shapedPoster(req, res, url, maxWidth, relaying);
      return;
    }
    if (relaying) {
      await relayImage(req, res, url);
      return;
    }
    res.set('Cache-Control', 'public, max-age=86400');
    res.redirect(302, url);
  });

  const TMDB_ORIGINAL = 'https://image.tmdb.org/t/p/original/';
  const TMDB_WIDTHS: Record<string, number[]> = {
    logo: [92, 154, 185, 300, 500],
    poster: [92, 154, 185, 342, 500, 780],
    backdrop: [300, 780, 1280],
  };
  const TVDB = 'https://artworks.thetvdb.com/banners/';
  const TVDB_THUMBS: [RegExp, number][] = [
    [/\/posters\//, 340],
    [/\/(fanart|backgrounds)\//, 640],
  ];
  const METAHUB = /^https:\/\/images\.metahub\.space\/(poster|background)\/(small|medium|large)\//;
  const METAHUB_WIDTHS: Record<string, Record<string, number>> = {
    poster: { small: 300, medium: 500, large: 780 },
    background: { small: 480, medium: 1920, large: 1920 },
  };

  /** Hosts that publish each image at several sizes, so a smaller one is a link rather than a resize. */
  const hasRenditions = (url: string): boolean =>
    url.startsWith('https://image.tmdb.org/t/p/') || url.startsWith(TVDB) || METAHUB.test(url);

  /** The source's own smallest rendition at least as wide as asked, never larger than the link names. */
  const sourceSized = (url: string, kind: string, maxWidth: number): string => {
    if (url.includes(TMDB_ORIGINAL)) {
      const bucket = kind === 'logo' ? 'logo' : kind === 'backdrop' || kind === 'thumb' ? 'backdrop' : 'poster';
      const widths = TMDB_WIDTHS[bucket];
      const wanted = maxWidth > 0 ? maxWidth : bucket === 'backdrop' ? 1280 : bucket === 'logo' ? 500 : 780;
      const width = widths.find((w) => w >= wanted);
      return width ? url.replace(TMDB_ORIGINAL, `https://image.tmdb.org/t/p/w${width}/`) : url;
    }
    if (!(maxWidth > 0)) return url;
    if (url.startsWith(TVDB) && !/_t\.\w+$/.test(url)) {
      const thumb = TVDB_THUMBS.find(([path]) => path.test(url));
      return thumb && maxWidth <= thumb[1] ? url.replace(/(\.\w+)$/, '_t$1') : url;
    }
    const metahub = METAHUB.exec(url);
    if (metahub) {
      const [prefix, kindName, size] = metahub;
      const widths = METAHUB_WIDTHS[kindName];
      const pick = Object.keys(widths).find((name) => widths[name] >= maxWidth);
      return pick && widths[pick] < widths[size] ? url.replace(prefix, prefix.replace(`/${size}/`, `/${pick}/`)) : url;
    }
    return url;
  };

  // With shaping turned off nothing needs reshaping, so a poster is free to redirect.
  const shapesPoster = (url: string): boolean => {
    const shape = require('../posterCache/shape');
    return shape.shapesPosters() && shape.shapesPosterFrom(url);
  };

  const builtinPosterCachePath = (url: string): string | null => {
    const posterCache = require('../posterCache/config');
    if (!posterCache.isBuiltinPosterCacheEnabled?.()) return null;
    const origin: string = posterCache.getSelfOrigin?.() || '';
    const route: string = posterCache.POSTER_CACHE_ROUTE;
    if (!origin || !url.startsWith(`${origin}${route}/`)) return null;
    return url.slice(origin.length);
  };

  const serveFromPosterCache = (req: any, res: any, path: string, fallback: string, width: number | null = null): Promise<void> =>
    new Promise((resolve) => {
      const inner = Object.create(req, {
        url: { value: path, writable: true },
        originalUrl: { value: path, writable: true },
        baseUrl: { value: '', writable: true },
        method: { value: 'GET' },
        ...(width ? { [SIZED_WIDTH]: { value: width } } : {}),
      });
      res.once('finish', resolve);
      res.once('close', resolve);
      req.app.handle(inner, res, () => {
        if (!res.headersSent) res.redirect(302, fallback);
        resolve();
      });
    });

  const relaysImages = (req: any): boolean => {
    const { getSetting } = require('../settingsService');
    const mode = String(getSetting('JELLYFIN_IMAGE_DELIVERY') || 'auto').trim().toLowerCase();
    if (mode === 'relay') return true;
    if (mode === 'redirect') return false;
    const names = String(getSetting('JELLYFIN_IMAGE_RELAY_CLIENTS') || '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    if (!names.length) return false;
    const seen = `${clientInfo(req).client} ${req.get('user-agent') || ''}`.toLowerCase();
    return names.some((name) => seen.includes(name));
  };

  const imageSetting = (key: string, fallback: number, min: number): number => {
    const value = Number(require('../settingsService').getSetting(key));
    return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
  };

  let liveRelays = 0;

  const relayImage = async (req: any, res: any, url: string): Promise<void> => {
    if (liveRelays >= imageSetting('JELLYFIN_IMAGE_RELAY_CONCURRENCY', 32, 1)) {
      res.redirect(302, url);
      return;
    }
    liveRelays++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), imageSetting('JELLYFIN_IMAGE_RELAY_TIMEOUT_MS', 15000, 1000));
    const abandon = () => controller.abort();
    res.once('close', abandon);
    try {
      const { openImageStream } = require('../posterCache/upstream');
      const { getMaxObjectBytes } = require('../posterCache/config');
      const etag = req.get('if-none-match');
      const upstream = await openImageStream(url, { signal: controller.signal, ...(etag ? { validators: { etag } } : {}) });
      if (upstream.notModified) {
        res.status(304).end();
        return;
      }
      const stream = upstream.response.data;
      const headers = upstream.response.headers;
      if (Number(headers['content-length'] || 0) > getMaxObjectBytes()) {
        stream.destroy();
        res.redirect(302, url);
        return;
      }
      res.set('Content-Type', upstream.contentType);
      if (headers['etag']) res.set('ETag', headers['etag']);
      if (headers['last-modified']) res.set('Last-Modified', headers['last-modified']);
      res.set('Content-Security-Policy', IMAGE_CSP);
      res.set('Cache-Control', 'public, max-age=86400');
      if (req.method === 'HEAD') {
        stream.destroy();
        res.end();
        return;
      }
      await pipeline(stream, res).catch(() => undefined);
    } catch (error: any) {
      logger.debug(`Image relay failed for ${url}: ${error?.message || error}`);
      if (!res.headersSent) res.redirect(302, url);
    } finally {
      clearTimeout(timer);
      res.off('close', abandon);
      liveRelays--;
    }
  };

  const shapedPoster = async (req: any, res: any, url: string, maxWidth: number, relaying: boolean): Promise<void> => {
    try {
      const image = await cachedArtwork(`${url}|${widthStep(maxWidth) ?? 0}|shaped`, async () => {
        if (imageQueueFull()) throw new ImageQueueFull();
        const { openImageStream } = require('../posterCache/upstream');
        const { getMaxObjectBytes } = require('../posterCache/config');
        const { shapePoster } = require('../posterCache/shape');
        const upstream = await openImageStream(url);
        if (upstream.notModified) throw new Error('not modified');
        const limit = getMaxObjectBytes();
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of upstream.response.data) {
          bytes += chunk.length;
          if (bytes > limit) {
            upstream.response.data.destroy();
            throw new Error(`larger than ${limit} bytes`);
          }
          chunks.push(Buffer.from(chunk));
        }
        const source = Buffer.concat(chunks);
        return inImageSlot(async () => {
          const shaped = await shapePoster(source, upstream.contentType);
          const step = widthStep(maxWidth);
          return step ? shrinkToWidth(shaped.body, shaped.contentType, step) : shaped;
        });
      });
      res.set('Content-Type', image.contentType);
      res.set('Content-Security-Policy', IMAGE_CSP);
      res.set('Cache-Control', 'public, max-age=86400');
      res.end(image.body);
    } catch (error: any) {
      if (error instanceof ImageQueueFull) {
        if (relaying) await relayImage(req, res, url);
        else res.redirect(302, url);
        return;
      }
      logger.debug(`Image stream failed for ${url}: ${error?.message || error}`);
      res.status(404).end();
    }
  };

  // A script fetching art needs a same-origin answer with CORS headers, which a
  // redirect straight to a CDN does not give it.
  const throughPosterCache = (url: string, kind: string): string | null => {
    const posterCache = require('../posterCache/config');
    if (!/^https?:\/\//i.test(url)) return url;
    const prefix: string = posterCache.getPosterProxyPrefix?.() || '';
    const selfOrigin: string = posterCache.getSelfOrigin?.() || '';
    if ((prefix && url.startsWith(prefix)) || (selfOrigin && url.startsWith(selfOrigin))) return url;
    if (!prefix) return null;
    const imageClass = kind === 'collection' ? 'collection' : kind === 'backdrop' ? 'background' : kind === 'logo' ? 'logo' : kind === 'thumb' ? 'landscape' : 'poster';
    return posterCache.buildCachedUrl(prefix, imageClass, url);
  };

  // A bare array, not a list. Some clients build their whole view from this and
  // never call /Items, so an empty answer reads as a server with no content.
  router.get(['/Items/Latest', '/Users/:userId/Items/Latest'], async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const parentId = req.query.ParentId ?? req.query.parentId;
    const limit = Math.min(Math.max(1, qInt(req, 'Limit', 20)), 100);
    const includeItemTypes = req.query.IncludeItemTypes ?? req.query.includeItemTypes;

    if (!parentId) {
      res.json([]);
      return;
    }

    const config = await loadConfig(req);
    if (!config || config.jellyfinLatestRows === false) {
      res.json([]);
      return;
    }

    const descriptor = await decodeJellyfinId(String(parentId));
    if (descriptor?.k === 'collection') {
      const collection = collectionById(config, descriptor.c);
      const sets = collection ? await boxSetsFor(userUUID, config, serverIdFor(userUUID), collection) : [];
      res.json(sets.slice(0, limit));
      return;
    }
    if (!descriptor || descriptor.k !== 'view') {
      res.json([]);
      return;
    }

    const catalog = await findCatalogByViewId(userUUID, config, descriptor.t, descriptor.c);
    if (!catalog || requiresGenre(catalog)) {
      res.json([]);
      return;
    }

    const serverId = serverIdFor(userUUID);
    const played = await playedPick(req, userUUID, config, catalog.type, serverId, String(parentId));
    const window = await fetchWindow(userUUID, catalog, 0, limit, {}, undefined, profileTags(config), played.key, played.pick);
    const items = window.items
      .filter((meta: any) => meta && meta.id)
      .map((meta: any) => metaToBaseItem(meta, catalog.type, serverId, String(parentId)));
    if (isLandscapeCatalog(config, catalog)) showLandscape(items);

    const latest = filterByIncludeTypes(items, includeItemTypes ? String(includeItemTypes) : undefined).slice(0, limit);
    await applyWatchedState(latest, await watchedSnapshot(userUUID, config), userUUID, profileKey(config), config);
    res.json(latest);
  });

  const warmSeriesMetas = (req: any, userUUID: string, items: any[]): void => {
    if (!/odin|fusion/i.test(clientInfo(req).client)) return;
    const seen = new Set<string>();
    const targets: Array<{ type: 'movie' | 'series'; id: string }> = [];
    for (const item of items) {
      const id = String(item?.SeriesId || item?.Id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      targets.push({ type: item?.Type === 'Movie' ? 'movie' : 'series', id });
    }
    void mapWithConcurrency(targets, shelfConcurrency(), async ({ type, id }) => {
      const descriptor = await decodeJellyfinId(id);
      if (descriptor && (descriptor.k === 'movie' || descriptor.k === 'series')) await fetchMeta(userUUID, type, descriptor.i).catch(() => undefined);
    }).catch(() => undefined);
  };

  router.get(['/UserItems/Resume', '/Users/:userId/Items/Resume'], async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const config = await loadConfig(req);
    if (!config) {
      res.json(itemList([], 0, 0));
      return;
    }

    const startIndex = Math.max(0, qInt(req, 'StartIndex', 0));
    const limit = Math.min(Math.max(1, qInt(req, 'Limit', 20)), 100);
    const watched = await watchedSnapshot(userUUID, config);
    const animeOnly = keepsAnimeOnly(config);
    const rows = (await resumeSnapshot(userUUID, config))
      .filter((row) => row.kind === 'movie' || !watched.dropped.has(row.metaId))
      .filter((row) => !animeOnly || isAnimeTitle(row.metaId, row.kind === 'movie' ? 'movie' : 'series'));
    if (!rows.length) {
      res.json(itemList([], 0, startIndex));
      return;
    }

    const serverId = serverIdFor(userUUID);
    const window = rows.slice(startIndex, startIndex + limit);
    const finished = await watchedAmong(watched, window.map((row) => row.videoId));

    // One meta per title, not per row: a show with several part-watched
    // episodes is the normal shape of this list.
    // A film reads its meta; a show reads the episode index, the way Next Up does.
    const metas = new Map<string, any>();
    await warmSeriesIndex(userUUID, window.filter((row) => row.kind !== 'movie').map((row) => row.metaId));
    await mapWithConcurrency([...new Set(window.map((row) => row.metaId))], shelfConcurrency(), async (metaId) => {
      const row = window.find((r) => r.metaId === metaId)!;
      const meta = row.kind === 'movie' ? await fetchMeta(userUUID, 'movie', metaId) : await seriesIndex(userUUID, metaId);
      if (meta) metas.set(metaId, meta);
    });

    const items: any[] = [];
    for (const row of window) {
      let meta = metas.get(row.metaId);
      if (!meta) continue;

      if (row.kind === 'movie') {
        const item = metaToBaseItem(meta, row.mediaType, serverId, null);
        item.UserData = resumeUserData(item.Id, row, item.RunTimeTicks ?? null, finished.has(row.videoId));
        items.push(item);
        continue;
      }

      const parsed = parseStremioId(row.videoId);
      if (!parsed) continue;

      // An episode the index lacks may have aired since it was read.
      let episodes = buildEpisodes(meta, row.mediaType, encodeJellyfinId({ k: 'series', t: row.mediaType, i: String(meta.id) }), serverId, null);
      let target = await locateEpisode(episodes, row.videoId, row.mediaType, String(meta.id));
      if (!target) {
        const fresh = await refreshSeriesIndex(userUUID, row.metaId);
        if (fresh) {
          meta = fresh;
          episodes = buildEpisodes(meta, row.mediaType, encodeJellyfinId({ k: 'series', t: row.mediaType, i: String(meta.id) }), serverId, null);
          target = await locateEpisode(episodes, row.videoId, row.mediaType, String(meta.id));
        }
      }
      if (!target) {
        logger.debug(`Resume row ${row.videoId} is not in its meta`);
        continue;
      }

      target.UserData = resumeUserData(target.Id, row, target.RunTimeTicks ?? null, finished.has(row.videoId));
      items.push(target);
    }

    // A play is held under every spelling of its title; the spellings build one item.
    const shown = new Set<string>();
    const distinct = items.filter((item) => !shown.has(item.Id) && shown.add(item.Id));
    const shelf = distinct.filter(keepsUnderProfileCap(config));
    res.json(itemList(shelf, rows.length, startIndex));
    warmSeriesMetas(req, userUUID, shelf);
  });

  const seriesMetaFor = async (req: any) => {
    const descriptor = await decodeJellyfinId(String(req.params.seriesId));
    if (!descriptor || descriptor.k !== 'series') return null;
    await loadConfig(req);
    const meta = await fetchMeta(req.params.userUUID, 'series', descriptor.i);
    return meta ? { descriptor, meta } : null;
  };

  router.get('/Shows/:seriesId/Seasons', async (req: any, res: any) => {
    const found = await seriesMetaFor(req);
    if (!found) {
      res.json(itemList([], 0, 0));
      return;
    }
    const seasons = await withSeasonAnimeIds(found.meta, buildSeasons(found.meta, found.descriptor.t, String(req.params.seriesId), serverIdFor(req.params.userUUID)));
    const seasonsConfig = await loadConfig(req);
    if (seasonsConfig) {
      await applyWatchedState(seasons, await watchedSnapshot(req.params.userUUID, seasonsConfig), req.params.userUUID, profileKey(seasonsConfig), seasonsConfig, {
        seriesVideos: seriesVideosOf(found.meta),
      });
    }
    res.json(itemList(seasons, seasons.length, 0));
  });

  router.get('/Shows/:seriesId/Episodes', async (req: any, res: any) => {
    const found = await seriesMetaFor(req);
    if (!found) {
      res.json(itemList([], 0, 0));
      return;
    }
    const raw = req.query.Season ?? req.query.season;
    let season: number | null = null;
    if (raw !== undefined) {
      const parsed = parseInt(String(raw), 10);
      if (Number.isFinite(parsed)) season = parsed;
    } else {
      const seasonId = req.query.SeasonId ?? req.query.seasonId;
      if (seasonId) {
        const seasonDescriptor = await decodeJellyfinId(String(seasonId));
        if (seasonDescriptor && seasonDescriptor.k === 'season') season = seasonDescriptor.s;
      }
    }

    const episodes = buildEpisodes(
      found.meta,
      found.descriptor.t,
      String(req.params.seriesId),
      serverIdFor(req.params.userUUID),
      season
    );
    // A play queue starts at the episode being played, not the first.
    const startItemId = req.query.StartItemId ?? req.query.startItemId;
    let from = 0;
    if (startItemId) {
      const wanted = normaliseJellyfinId(String(startItemId));
      const at = episodes.findIndex((e: any) => e.Id === wanted);
      if (at > 0) from = at;
    }
    let list = episodes.slice(from);
    const adjacentTo = req.query.AdjacentTo ?? req.query.adjacentTo;
    if (adjacentTo) {
      const at = list.findIndex((e: any) => e.Id === normaliseJellyfinId(String(adjacentTo)));
      list = at < 0 ? [] : list.slice(Math.max(0, at - 1), at + 2);
    }
    const startIndex = Math.max(0, qInt(req, 'StartIndex', 0));
    const limit = Math.max(1, qInt(req, 'Limit', list.length || 1));
    const page = list.slice(startIndex, startIndex + limit);

    const episodesConfig = await loadConfig(req);
    if (episodesConfig) {
      await applyWatchedState(page, await watchedSnapshot(req.params.userUUID, episodesConfig), req.params.userUUID, profileKey(episodesConfig), episodesConfig);
    }
    res.json(itemList(page, list.length, startIndex));
  });

  router.get('/Shows/NextUp', async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const config = await loadConfig(req);
    const startIndex = Math.max(0, qInt(req, 'StartIndex', 0));
    const limit = Math.min(Math.max(1, qInt(req, 'Limit', 20)), 100);

    if (!config) {
      res.json(itemList([], 0, startIndex));
      return;
    }

    // Built once per shelf shape; every page is cut from it.
    const q = (name: string) => String(req.query[name] ?? req.query[name.charAt(0).toLowerCase() + name.slice(1)] ?? '');
    const digest = (await watchedSnapshot(userUUID, config)).fingerprint;
    const shelfKey = `${userUUID}:${profileKey(config)}:${sourceFor(config) ?? ''}:${q('EnableResumable')}:${q('EnableRewatching')}:${q('SeriesId') || q('ParentId')}`;
    const memoKey = `${userUUID}:${profileKey(config)}:${digest}:${q('EnableResumable')}:${q('EnableRewatching')}:${q('SeriesId') || q('ParentId')}`;
    let firstPending: number | null = null;
    const notePending = (at: number) => {
      if (firstPending === null || at < firstPending) firstPending = at;
    };
    const found = await memoNextUp(userUUID, memoKey, () => buildNextUp(req, userUUID, config, notePending), () => firstPending, {
      ms: envInt('JELLYFIN_NEXTUP_DEADLINE_MS', 10000, 1000),
      shelfKey,
    });
    const page = found.slice(startIndex, startIndex + limit);
    res.json(itemList(page, found.length, startIndex));
    warmSeriesMetas(req, userUUID, page);
  });

  nextUpTracer = (userUUID, config, trace) => buildNextUp({ query: {} }, userUUID, config, undefined, trace);

  const buildNextUp = async (req: any, userUUID: string, config: any, notePending: (at: number) => void = () => {}, trace?: NextUpTrace): Promise<any[]> => {
    const t0 = Date.now();
    const lap = { snapshot: 0, resumable: 0, own: 0, meta: 0, episodes: 0, state: 0 };
    const snapshot = await watchedSnapshot(userUUID, config);
    lap.snapshot = Date.now() - t0;
    const followedTimes = upcomingFollowed(config, envInt('JELLYFIN_UPCOMING_DAYS', 90, 1));

    // The client's recency cutoff is deliberately not applied: the tracker's own
    // view of what is in progress is the one people expect to see.
    const flag = (name: string, fallback: boolean): boolean => {
      const raw = req.query[name] ?? req.query[name.charAt(0).toLowerCase() + name.slice(1)];
      return raw === undefined ? fallback : String(raw).toLowerCase() === 'true';
    };
    const includeResumable = flag('EnableResumable', true);
    const includeRewatching = flag('EnableRewatching', false);

    let resumable: Set<string> | null = null;
    const t1 = Date.now();
    if (!includeResumable) {
      const { videoIdAliases } = require('./aliases');
      resumable = new Set<string>();
      for (const row of await resumeSnapshot(userUUID, config)) {
        resumable.add(row.metaId);
        if (row.kind === 'episode') resumable.add(await showIdentity(row.metaId, config));
        for (const alias of await videoIdAliases(row.videoId)) {
          const parsed = parseStremioId(alias);
          if (parsed) resumable.add(parsed.base);
        }
      }
    }

    lap.resumable = Date.now() - t1;
    // The table first; a tracker adds the shows it knows that the table does not.
    const t2 = Date.now();
    const ownRows = await ownNextUpRows(userUUID, profileKey(config));
    const own = ownRows.filter((row) => !snapshot.dropped.has(row.metaId));
    lap.own = Date.now() - t2;
    if (trace) {
      for (const row of ownRows) if (snapshot.dropped.has(row.metaId)) trace(row, 'server', { outcome: 'dropped' });
      for (const row of snapshot.nextUp) if (snapshot.dropped.has(row.metaId)) trace(row, 'tracker', { outcome: 'dropped' });
    }
    const sourceOf = (row: any): NextUpSource => (own.includes(row) ? 'server' : snapshot.nextUp.includes(row) ? 'tracker' : 'sequel');
    // One row per resolved show; the table's newest spelling first.
    const animeOnly = keepsAnimeOnly(config) && !(req.query.SeriesId ?? req.query.seriesId ?? req.query.ParentId ?? req.query.parentId);
    const sequels = (await animeSequels(snapshot)).nextUp;
    const offered = [...[...own].sort((a, b) => b.lastWatchedAt - a.lastWatchedAt), ...snapshot.nextUp.filter((row) => !snapshot.dropped.has(row.metaId)), ...sequels]
      .filter((row) => {
        if (!animeOnly || isAnimeTitle(row.metaId, 'series')) return true;
        trace?.(row, sourceOf(row), { outcome: 'not-anime' });
        return false;
      });
    const identities = new Map<string, string>();
    await mapWithConcurrency([...new Set(offered.map((row) => row.metaId))], shelfConcurrency(), async (metaId) => {
      identities.set(metaId, await showIdentity(metaId, config));
    });
    const trackerTimes = new Map<string, Omit<NextUpRow, 'lastWatchedAt'>>();
    for (const row of [...snapshot.nextUp, ...(await followedTimes)]) {
      if ((row.airsAt || row.aired) && !trackerTimes.has(row.metaId)) trackerTimes.set(row.metaId, row);
    }
    const taken = new Set<string>();
    const merged = offered
      .filter((row) => {
        const identity = identities.get(row.metaId) ?? row.metaId;
        if (taken.has(identity)) return false;
        taken.add(identity);
        return true;
      })
      .sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);
    const sources = new Map(offered.map((row) => [row, sourceOf(row)]));
    const trackerRanks = new Map<string, number>();
    for (const row of snapshot.nextUp) {
      const identity = identities.get(row.metaId) ?? row.metaId;
      if (Number.isFinite(row.trackerRank) && !trackerRanks.has(identity)) trackerRanks.set(identity, row.trackerRank!);
    }

    // A series page asks for its own next episode; an unplayed show starts at the first.
    const seriesParam = req.query.SeriesId ?? req.query.seriesId ?? req.query.ParentId ?? req.query.parentId;
    let scoped = merged;
    if (seriesParam) {
      const wanted = await decodeJellyfinId(String(seriesParam));
      if (!wanted || wanted.k !== 'series') {
        return [];
      }
      const meta = await fetchMeta(userUUID, 'series', wanted.i);
      const matches = (row: any) => row.metaId === wanted.i || (meta && row.metaId === String(meta.id));
      scoped = merged.filter(matches);
      if (!scoped.length) {
        scoped = [{ metaId: wanted.i, videoId: null, season: 1, episode: 1, mediaType: wanted.t === 'anime' ? 'anime' : 'series', lastWatchedAt: 0 }];
      }
    }

    const counted = !includeRewatching && !seriesParam ? await seriesCountsAmong(snapshot, scoped.map((row) => row.metaId)) : new Map();
    const listedAt = Date.now();
    const rows = scoped.filter((row) => {
      if (resumable && (resumable.has(row.metaId) || resumable.has(identities.get(row.metaId) ?? row.metaId))) return false;
      if (!includeRewatching && !seriesParam) {
        const counts = counted.get(row.metaId);
        const timed = trackerTimes.get(row.metaId);
        const airedSinceCounted = Boolean(timed?.aired) || (timed?.airsAt ?? Infinity) <= listedAt;
        if (counts && counts.total > 0 && counts.watched >= counts.total && !airedSinceCounted) {
          trace?.(row, sources.get(row) ?? 'server', { outcome: 'finished', watched: counts.watched, total: counts.total });
          return false;
        }
      }
      return true;
    });
    if (!rows.length) {
      return [];
    }

    const serverId = serverIdFor(userUUID);

    // Every candidate is tried once; a page needs no second scan.
    const items: any[] = [];
    const identity: string[] = [];
    const availableAt: number[] = [];
    let skipped = 0;
    await warmSeriesIndex(userUUID, rows.map((row) => row.metaId));
    await mapWithConcurrency(rows, shelfConcurrency(), async (row, index) => {
      const locate = async (episodes: any[], metaId: string, videoId = row.videoId): Promise<any | undefined> =>
        videoId
          ? locateEpisode(episodes, videoId, row.mediaType, metaId)
          : episodes.find(
              (episode: any) =>
                episode.IndexNumber === row.episode &&
                (row.season === null || episode.ParentIndexNumber === row.season)
            );

      // An episode the index lacks that the tracker names means it has moved on.
      const tm = Date.now();
      let meta = await seriesIndex(userUUID, row.metaId);
      lap.meta += Date.now() - tm;
      if (!meta) {
        skipped += 1;
        logger.debug(`Next Up skipped ${row.metaId}: no meta`);
        trace?.(row, sources.get(row) ?? 'server', { outcome: 'no-meta' });
        return;
      }
      let seriesId = encodeJellyfinId({ k: 'series', t: row.mediaType, i: String(meta.id) });
      const te = Date.now();
      let episodes = buildEpisodes(meta, row.mediaType, seriesId, serverId, null);
      lap.episodes += Date.now() - te;
      let target = await locate(episodes, String(meta.id));
      if (!target) {
        const fresh = await refreshSeriesIndex(userUUID, row.metaId);
        if (fresh) {
          meta = fresh;
          seriesId = encodeJellyfinId({ k: 'series', t: row.mediaType, i: String(meta.id) });
          episodes = buildEpisodes(meta, row.mediaType, seriesId, serverId, null);
          target = await locate(episodes, String(meta.id));
        }
      }
      if (!target && !episodes.length && row.episode === 1 && row.airsAt && row.airsAt <= Date.now()) {
        target = episodeFromDate(meta, row, new Date(row.airsAt).toISOString(), seriesId, serverId);
        episodes = [target];
      }

      // The table and a tracker can name one show in different id spaces.
      identity[index] = meta._tmdbId ? `tmdb:${meta._tmdbId}` : meta._imdbId ? `imdb:${meta._imdbId}` : String(meta.id);

      if (!target) {
        skipped += 1;
        logger.debug(`Next Up skipped ${row.metaId}: ${row.videoId ?? `S${row.season ?? '?'}E${row.episode}`} is not among its ${episodes.length} episodes`);
        trace?.(row, sources.get(row) ?? 'server', { outcome: 'missing-episode', episodes: episodes.length, meta });
        return;
      }

      // The table wins; walked one episode at a time since the first is nearly always it.
      const from = episodes.indexOf(target);
      const onward = episodes.slice(from);
      const ts = Date.now();
      let next: any = null;
      for (let i = 0; i < onward.length; i++) {
        const episode = onward[i];
        if (i > 0 && episode.ParentIndexNumber === 0) continue;
        await applyWatchedState([episode], snapshot, userUUID, profileKey(config));
        if (episode.UserData?.Played !== true) {
          next = episode;
          break;
        }
      }
      lap.state += Date.now() - ts;
      const nowMs = Date.now();
      const borrowed = row.airsAt ? undefined : trackerTimes.get(row.metaId);
      const borrowedFits = Boolean(borrowed && next) && (
        (next.IndexNumber === borrowed!.episode && (borrowed!.season === null || next.ParentIndexNumber === borrowed!.season))
        || (Boolean(borrowed!.videoId) && (await locate(episodes, String(meta.id), borrowed!.videoId)) === next)
      );
      const airedAt = next === target && row.airsAt
        ? row.airsAt
        : borrowedFits
          ? borrowed!.airsAt ?? Math.min(Date.parse(next.PremiereDate || '') || nowMs, nowMs)
          : Date.parse(next?.PremiereDate || '');
      const traced = async (step: Omit<NextUpStep, 'meta' | 'watched' | 'total'>) => {
        if (!trace) return;
        const regular = episodes.filter((episode: any) => episode.ParentIndexNumber !== 0);
        await applyWatchedState(regular, snapshot, userUUID, profileKey(config));
        const aired = regular.filter((episode: any) => !(Date.parse(episode.PremiereDate || '') > nowMs));
        trace(row, sources.get(row) ?? 'server', { ...step, meta, watched: aired.filter((episode: any) => episode.UserData?.Played === true).length, total: aired.length });
      };
      if (!next) {
        skipped += 1;
        logger.debug(`Next Up skipped ${row.metaId}: every episode from ${target.Name} on is played`);
        await traced({ outcome: 'caught-up', from: episodeLabel(target) });
        return;
      }
      if (Number.isFinite(airedAt) && airedAt > nowMs) {
        notePending(airedAt);
        skipped += 1;
        logger.debug(`Next Up skipped ${row.metaId}: ${next.Name} airs ${next.PremiereDate}`);
        await traced({ outcome: 'airs-later', next: episodeLabel(next), airsAt: airedAt });
        return;
      }
      if (!Number.isFinite(airedAt) && episodes.some((episode: any) => Number.isFinite(Date.parse(episode?.PremiereDate || '')))) {
        skipped += 1;
        logger.debug(`Next Up skipped ${row.metaId}: ${next.Name} has no air date`);
        await traced({ outcome: 'no-air-date', next: episodeLabel(next) });
        return;
      }
      if (Number.isFinite(airedAt) && airedAt !== Date.parse(next.PremiereDate || '')) next.PremiereDate = new Date(airedAt).toISOString();
      items[index] = next;
      availableAt[index] = Math.max(row.lastWatchedAt || 0, Number.isFinite(airedAt) ? airedAt : 0);
      await traced({ outcome: 'shown', next: episodeLabel(next) });
    });

    const shown = new Set<string>();
    const capped = keepsUnderProfileCap(config);
    const rankOf = (row: any) => trackerRanks.get(identities.get(row.metaId) ?? row.metaId) ?? Number.MAX_SAFE_INTEGER;
    const found = items
      .map((item, index) => ({ item, row: rows[index], index }))
      .filter(({ item, row, index }) => {
        if (!item) return false;
        if (shown.has(identity[index])) {
          trace?.(row, sources.get(row) ?? 'server', { outcome: 'duplicate' });
          return false;
        }
        shown.add(identity[index]);
        if (capped(item)) return true;
        trace?.(row, sources.get(row) ?? 'server', { outcome: 'rating-cap' });
        return false;
      })
      .sort((a, b) => availableAt[b.index] - availableAt[a.index] || rankOf(a.row) - rankOf(b.row))
      .map(({ item }) => item);
    logger.info(`Next Up built for ${userUUID}: ${found.length} of ${rows.length} candidates (${own.length} own, ${snapshot.nextUp.length} tracker), ${skipped} skipped, in ${Date.now() - t0}ms (snapshot ${lap.snapshot}, resumable ${lap.resumable}, own rows ${lap.own}, meta ${lap.meta}, episodes ${lap.episodes}, state ${lap.state}, summed over ${shelfConcurrency()} lanes)`);
    return found;
  };

  // A new season of a show the user follows, and a watchlist film not out yet.
  router.get('/Shows/Upcoming', async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const config = await loadConfig(req);
    const startIndex = Math.max(0, qInt(req, 'StartIndex', 0));
    const limit = Math.min(Math.max(1, qInt(req, 'Limit', 20)), 100);

    if (!config) {
      res.json(itemList([], 0, startIndex));
      return;
    }

    const digest = (await watchedSnapshot(userUUID, config)).fingerprint;
    const memoKey = `${userUUID}:${profileKey(config)}:upcoming:${upcomingMode(config)}:${digest}`;
    const holdMs = upcomingHoldMs();
    const ordered = await memoNextUp(userUUID, memoKey, () => buildUpcoming(userUUID, config), (items) =>
      items
        .map((item) => Date.parse(item?.PremiereDate || ''))
        .map((at) => (at > Date.now() ? at : at + holdMs))
        .filter((at) => at > Date.now())
        .sort((a, b) => a - b)[0] ?? null
    );
    res.json(itemList(ordered.slice(startIndex, startIndex + limit), ordered.length, startIndex));
  });

  // Tracker-followed shows are all checked; watchlisted and locally known ones are capped.
  const showsInView = async (userUUID: string, config: any, days: number) => {
    const watchlistLimit = envInt('JELLYFIN_UPCOMING_WATCHLIST_LIMIT', 100, 1);
    const [snapshot, resume, own, caughtUp, listed] = await Promise.all([
      watchedSnapshot(userUUID, config),
      resumeSnapshot(userUUID, config),
      ownNextUpRows(userUUID, profileKey(config)),
      upcomingFollowed(config, days),
      watchlistEntries(userUUID, config, watchlistLimit).catch(() => ({ entries: [] as any[] })),
    ]);
    const shows = new Map<string, string>();
    for (const row of [...caughtUp, ...snapshot.following]) {
      if (!shows.has(row.metaId)) shows.set(row.metaId, row.mediaType);
    }
    const watchlisted = listed.entries
      .filter((entry: any) => entryItemType(entry) === 'Series' && !snapshot.dropped.has(entry.metaId))
      .slice(0, watchlistLimit);
    for (const entry of watchlisted) {
      if (!shows.has(entry.metaId)) shows.set(entry.metaId, entry.mediaType);
    }
    let local = 0;
    const localCap = envInt('JELLYFIN_UPCOMING_LOCAL_SHOWS', 60, 0);
    for (const row of [...own, ...snapshot.nextUp, ...resume.filter((r) => r.kind === 'episode')].filter((r) => !snapshot.dropped.has(r.metaId))) {
      if (shows.has(row.metaId)) continue;
      if (local >= localCap) break;
      shows.set(row.metaId, row.mediaType);
      local += 1;
    }
    const followed = [...shows.entries()].filter(([metaId]) => !keepsAnimeOnly(config) || isAnimeTitle(metaId, 'series'));
    const sequels = (await animeSequels(snapshot)).upcoming.filter((row) => !shows.has(row.metaId));
    return { snapshot, caughtUp, followed, sequels };
  };

  const onePerEpisode = async (episodes: any[], config: any): Promise<any[]> => {
    const { videoIdAliases } = require('./aliases');
    const { stremioIdFor } = require('./idsCodec');
    const { perEntryAnime } = require('./watchlistSources');
    const keepsAnime = perEntryAnime(config);
    const spelled = await Promise.all(episodes.map(async (episode) => {
      const descriptor = await decodeJellyfinId(String(episode.Id));
      const videoId = descriptor ? stremioIdFor(descriptor) : null;
      return { episode, anime: descriptor?.k === 'episode' && descriptor.t === 'anime', spellings: videoId ? [videoId, ...(await videoIdAliases(videoId))] : [String(episode.Id)] };
    }));
    const kept: typeof spelled = [];
    for (const entry of spelled) {
      const held = kept.findIndex((other) => other.spellings.some((spelling) => entry.spellings.includes(spelling)));
      if (held === -1) kept.push(entry);
      else if (kept[held].anime !== entry.anime && entry.anime === keepsAnime) kept[held] = entry;
    }
    return kept.map((entry) => entry.episode);
  };

  const sequelPremieres = async (userUUID: string, rows: UpcomingRow[], keep: (at: number) => boolean, seen: Set<string>): Promise<any[]> => {
    const serverId = serverIdFor(userUUID);
    const out: any[] = [];
    await mapWithConcurrency(rows.filter((row) => row.airsAt && keep(row.airsAt)), shelfConcurrency(), async (row) => {
      const meta = await seriesIndex(userUUID, row.metaId);
      if (!meta) return;
      const identity = meta._tmdbId ? `tmdb:${meta._tmdbId}` : meta._imdbId ? `imdb:${meta._imdbId}` : String(meta.id);
      if (seen.has(identity)) return;
      seen.add(identity);
      const premiere = new Date(row.airsAt as number).toISOString();
      const seriesId = encodeJellyfinId({ k: 'series', t: row.mediaType, i: String(meta.id) });
      const episodes = buildEpisodes(meta, row.mediaType, seriesId, serverId, null);
      const episode = (row.videoId ? await locateEpisode(episodes, row.videoId, row.mediaType, String(meta.id)) : episodes.find((e: any) => e.IndexNumber === row.episode))
        ?? episodeFromDate(meta, row, premiere, seriesId, serverId);
      episode.PremiereDate = premiere;
      out.push(episode);
    });
    return out;
  };

  const serverWatchlistItems = async (userUUID: string, config: any, serverId: string, wanted: Set<string> | null): Promise<any[] | null> => {
    if (require('./watchlistSources').watchlistPicks(config).size) return null;
    const { isServerWatchlistCatalog, serverWatchlistMediaType } = require('../serverWatchlist');
    const shelves = (await getCatalogs(userUUID, config)).filter((catalog: any) => {
      const mediaType = isServerWatchlistCatalog(catalog.id) ? serverWatchlistMediaType(catalog.id) : undefined;
      if (!mediaType || !wanted) return Boolean(mediaType);
      return mediaType === 'all' || mediaType === 'anime' ? wanted.has('Movie') || wanted.has('Series') : wanted.has(mediaType === 'movie' ? 'Movie' : 'Series');
    });
    if (!shelves.length) return null;
    const cap = envInt('SERVER_WATCHLIST_MAX_ITEMS', 500, 1);
    const { viewerProfile } = require('./viewer');
    const listed: any[] = await database.listWatchlist(userUUID, viewerProfile()).catch(() => []);
    const addedAt = new Map(listed.filter((row) => Number(row.listed)).map((row) => [String(row.meta_id), Number(row.updated_at) || 0]));
    const items: any[] = [];
    const seen = new Set<string>();
    for (const catalog of shelves) {
      const window = await fetchWindow(userUUID, catalog, 0, cap, {}, undefined, profileTags(config)).catch(() => ({ items: [] as any[] }));
      for (const meta of window.items) {
        const item = metaToBaseItem(meta, serverWatchlistMediaType(catalog.id), serverId, null);
        if (seen.has(String(meta.id)) || (wanted && !wanted.has(item.Type))) continue;
        seen.add(String(meta.id));
        item.UserData = { ...item.UserData, IsFavorite: true, ...(clientHasOwnWatchlist() ? { Likes: true } : {}) };
        const at = addedAt.get(String(meta.id));
        if (at) item.DateCreated = new Date(at).toISOString();
        items.push(item);
      }
    }
    return items.filter(keepsUnderProfileCap(config));
  };

  /** Watchlisted films, from every watchlist, whose release date passes `keep`. */
  const watchlistFilms = async (userUUID: string, config: any, keep: (at: number) => boolean, seen: Set<string> = new Set()): Promise<any[]> => {
    const serverId = serverIdFor(userUUID);
    const filmLimit = envInt('JELLYFIN_UPCOMING_WATCHLIST_LIMIT', 100, 1);
    const films: any[] = [];
    const addFilm = (meta: any, type: string) => {
      const item = metaToBaseItem(meta, type, serverId, null);
      if (item.Type !== 'Movie' || !keep(Date.parse(item?.PremiereDate || '')) || seen.has(item.Id)) return;
      if (keepsAnimeOnly(config) && !isAnimeTitle(String(meta.id), 'movie')) return;
      seen.add(item.Id);
      films.push(item);
    };
    const watchlists = (await getCatalogs(userUUID, config)).filter(
      (catalog: any) => /\.watchlist\b/.test(catalog.id) && (collectionTypeFor(catalog.type) === 'movies' || catalog.type === 'all')
    );
    await mapWithConcurrency(watchlists, 2, async (catalog: any) => {
      const window = await fetchWindow(userUUID, catalog, 0, filmLimit, {}, undefined, profileTags(config))
        .catch(() => ({ items: [] as any[], hasMore: false }));
      for (const meta of window.items) {
        if (catalog.type !== 'all') addFilm(meta, catalog.type);
        else if (meta?.type === 'movie') addFilm(meta, 'movie');
      }
    });
    const listed = (await watchlistEntries(userUUID, config, filmLimit).catch(() => ({ entries: [] as any[] }))).entries
      .filter((entry: any) => entryItemType(entry) === 'Movie')
      .slice(0, filmLimit);
    await mapWithConcurrency(listed, shelfConcurrency(), async (entry: any) => {
      const meta = await fetchMeta(userUUID, 'movie', entry.metaId).catch(() => null);
      if (meta) addFilm(meta, 'movie');
    });
    return films;
  };

  const heldCalendar = async (userUUID: string, config: any, from: number, to: number, withFilms = false): Promise<any[]> => {
    const digest = (await watchedSnapshot(userUUID, config)).fingerprint;
    const memoKey = `${userUUID}:${profileKey(config)}:calendar:${from}:${to}:${digest}${withFilms ? ':films' : ''}`;
    return memoNextUp(userUUID, memoKey, () => buildCalendar(userUUID, config, from, to, withFilms), (built) =>
      built.length === 0 ? Date.now() + envInt('JELLYFIN_CALENDAR_EMPTY_TTL', 30, 1) * 1000 : null);
  };
  calendarReader = heldCalendar;

  const buildCalendar = async (userUUID: string, config: any, from: number, to: number, withFilms = false): Promise<any[]> => {
    const serverId = serverIdFor(userUUID);
    const profile = profileKey(config);
    const premiereAt = (item: any): number => Date.parse(item?.PremiereDate || '');
    const { snapshot, caughtUp, followed, sequels } = await showsInView(userUUID, config, envInt('JELLYFIN_UPCOMING_DAYS', 90, 1));
    const timed = new Map<string, Array<{ videoId?: string | null; season: number | null; episode: number; airsAt: number }>>();
    for (const row of [...snapshot.nextUp, ...caughtUp]) {
      if (!row.airsAt) continue;
      const list = timed.get(row.metaId) || [];
      list.push({ videoId: row.videoId, season: row.season ?? null, episode: row.episode, airsAt: row.airsAt });
      timed.set(row.metaId, list);
    }

    const seenShows = new Set<string>();
    const seenEpisodes = new Set<string>();
    const dated: any[] = [];
    await warmSeriesIndex(userUUID, followed.map(([metaId]) => metaId));
    await mapWithConcurrency(followed, shelfConcurrency(), async ([metaId, mediaType]) => {
      const meta = await seriesIndex(userUUID, metaId);
      if (!meta) return;
      const identity = meta._tmdbId ? `tmdb:${meta._tmdbId}` : meta._imdbId ? `imdb:${meta._imdbId}` : String(meta.id);
      if (seenShows.has(identity)) return;
      seenShows.add(identity);
      const seriesId = encodeJellyfinId({ k: 'series', t: mediaType, i: String(meta.id) });
      const episodes = buildEpisodes(meta, mediaType, seriesId, serverId, null)
        .filter((episode: any) => episode.ParentIndexNumber !== 0);
      for (const row of timed.get(metaId) || []) {
        const episode = row.videoId
          ? await locateEpisode(episodes, row.videoId, mediaType, String(meta.id))
          : episodes.find((e: any) => e.IndexNumber === row.episode && (row.season === null || e.ParentIndexNumber === row.season));
        if (episode) episode.PremiereDate = new Date(row.airsAt).toISOString();
      }
      for (const episode of episodes) {
        const at = premiereAt(episode);
        if (!Number.isFinite(at) || at < from || at > to || seenEpisodes.has(episode.Id)) continue;
        seenEpisodes.add(episode.Id);
        dated.push(episode);
      }
    });
    for (const episode of await sequelPremieres(userUUID, sequels, (at) => at >= from && at <= to, seenShows)) {
      if (seenEpisodes.has(episode.Id)) continue;
      seenEpisodes.add(episode.Id);
      dated.push(episode);
    }
    if (withFilms) dated.push(...(await watchlistFilms(userUUID, config, (at) => Number.isFinite(at) && at >= from && at <= to)));

    await applyWatchedState(dated, snapshot, userUUID, profile);
    return dated
      .filter(keepsUnderProfileCap(config))
      .sort((a, b) => premiereAt(a) - premiereAt(b));
  };

  const upcomingHoldMs = (): number => envInt('JELLYFIN_UPCOMING_HOLD_HOURS', 12, 0) * 60 * 60 * 1000;

  const upcomingMode = (config: any): 'caught-up' | 'airing' => {
    const mode = String(require('../settingsService').getSetting('JELLYFIN_UPCOMING_MODE') || 'user');
    if (mode === 'caught-up' || mode === 'airing') return mode;
    return config?.jellyfinUpcomingMode === 'airing' ? 'airing' : 'caught-up';
  };

  const buildUpcoming = async (userUUID: string, config: any): Promise<any[]> => {
    const now = Date.now();
    const days = envInt('JELLYFIN_UPCOMING_DAYS', 90, 1);
    const horizon = now + days * 24 * 60 * 60 * 1000;
    const serverId = serverIdFor(userUUID);
    const profile = profileKey(config);
    const premiereAt = (item: any): number => Date.parse(item?.PremiereDate || '');
    const within = (at: number): boolean => Number.isFinite(at) && at > now && at <= horizon;
    const holdMs = upcomingHoldMs();
    const lately = (at: number): boolean => Number.isFinite(at) && at <= now && at > now - holdMs;
    const airing = upcomingMode(config) === 'airing';

    const { snapshot, caughtUp, followed, sequels } = await showsInView(userUUID, config, days);

    let nextUpShows: Promise<Set<string>> | null = null;
    const inNextUp = async (metaId: string): Promise<boolean> => {
      nextUpShows ??= (async () => {
        let firstPending: number | null = null;
        const notePending = (at: number) => {
          if (firstPending === null || at < firstPending) firstPending = at;
        };
        const items = await memoNextUp(
          userUUID,
          `${userUUID}:${profile}:${snapshot.fingerprint}:::`,
          () => buildNextUp({ query: {} }, userUUID, config, notePending),
          () => firstPending
        );
        const shows = new Set<string>();
        for (const item of items) {
          const series = item?.SeriesId ? await decodeJellyfinId(String(item.SeriesId)) : null;
          if (series?.k === 'series') shows.add(await showIdentity(String(series.i), config));
        }
        return shows;
      })();
      return (await nextUpShows).has(await showIdentity(metaId, config));
    };
    const named = new Map<string, NextUpRow>();
    for (const row of snapshot.nextUp) if (row.airsAt || row.aired) named.set(row.metaId, row);
    // MDBList names each followed show's next episode and when it airs, in progress or not,
    // so its time is used only once the show passes the caught-up check below.
    const timed = new Map<string, (typeof caughtUp)[number]>();
    for (const row of caughtUp) if (row.airsAt) timed.set(row.metaId, row);

    const seen = new Set<string>();
    const premieres: any[] = [];
    await warmSeriesIndex(userUUID, followed.map(([metaId]) => metaId));
    await mapWithConcurrency(followed, shelfConcurrency(), async ([metaId, mediaType]) => {
      const meta = await seriesIndex(userUUID, metaId);
      if (!meta) return;
      const identity = meta._tmdbId ? `tmdb:${meta._tmdbId}` : meta._imdbId ? `imdb:${meta._imdbId}` : String(meta.id);
      if (seen.has(identity)) return;
      seen.add(identity);
      const seriesId = encodeJellyfinId({ k: 'series', t: mediaType, i: String(meta.id) });
      const episodes = buildEpisodes(meta, mediaType, seriesId, serverId, null)
        .filter((episode: any) => episode.ParentIndexNumber !== 0);
      const row = named.get(metaId);
      if (row) {
        const episode = row.videoId
          ? await locateEpisode(episodes, row.videoId, mediaType, String(meta.id))
          : episodes.find((e: any) => e.IndexNumber === row.episode && (row.season === null || e.ParentIndexNumber === row.season));
        if (row.airsAt && within(row.airsAt)) {
          if (episode) {
            episode.PremiereDate = new Date(row.airsAt as number).toISOString();
            premieres.push(episode);
          }
          return;
        }
        // Aired and, by the tracker, unwatched: Next Up's business unless the table says it was played.
        if (episode) await applyWatchedState([episode], snapshot, userUUID, profile);
        if (episode && episode.UserData?.Played !== true && row.airsAt && lately(row.airsAt) && !(await inNextUp(metaId))) {
          episode.PremiereDate = new Date(row.airsAt as number).toISOString();
          premieres.push(episode);
          return;
        }
        if (!airing && (!episode || episode.UserData?.Played !== true)) return;
      }
      const stillDue = async (episode: any): Promise<boolean> => {
        await applyWatchedState([episode], snapshot, userUUID, profile);
        return episode.UserData?.Played !== true && !(airing && (await inNextUp(metaId)));
      };
      // The episode the tracker names, at the time it gives, before the metadata's guess:
      // the metadata often has only a day, or no date yet.
      let next: any;
      const timedRow = timed.get(metaId);
      if (timedRow) {
        const named = timedRow.videoId
          ? await locateEpisode(episodes, timedRow.videoId, mediaType, String(meta.id))
          : episodes.find((e: any) => e.IndexNumber === timedRow.episode && (timedRow.season === null || e.ParentIndexNumber === timedRow.season));
        if (named) named.PremiereDate = new Date(timedRow.airsAt as number).toISOString();
        if (named && within(timedRow.airsAt as number)) next = named;
        else if (named && lately(timedRow.airsAt as number) && (await stillDue(named))) next = named;
      }
      if (!next) {
        const candidates = episodes
          .filter((episode: any) => within(premiereAt(episode)) || lately(premiereAt(episode)))
          .sort((a: any, b: any) => premiereAt(a) - premiereAt(b));
        for (const candidate of candidates) {
          if (within(premiereAt(candidate))) {
            next = candidate;
            break;
          }
          if (await stillDue(candidate)) {
            next = candidate;
            break;
          }
        }
      }
      if (!next) return;
      const nextAt = premiereAt(next);
      const nextAired = nextAt <= now;
      // Only a show the user is caught up on: an aired episode still unwatched
      // is Next Up's business. The snapshot answers for most; the table is
      // asked only about aired episodes it does not hold.
      const aired = airing ? [] : episodes.filter((episode: any) => {
        const at = premiereAt(episode);
        return Number.isFinite(at) && at <= now && (!nextAired || (episode !== next && at < nextAt));
      });
      const { stremioIdFor } = require('./idsCodec');
      const unknown: any[] = [];
      const held: string[] = [];
      const airedIds = new Map<any, string | null>();
      for (const episode of aired) {
        const d = await decodeJellyfinId(String(episode.Id));
        airedIds.set(episode, d ? stremioIdFor(d) : null);
      }
      const onTracker = await watchedAmong(snapshot, [...airedIds.values()].filter(Boolean) as string[]);
      for (const [episode, videoId] of airedIds) {
        if (!videoId || !onTracker.has(videoId)) unknown.push(episode);
        else held.push(videoId);
      }
      if (unknown.length) {
        await applyWatchedState(unknown, snapshot, userUUID, profile);
        if (unknown.some((episode: any) => episode.UserData?.Played !== true)) return;
      }
      // A watch the tracker holds that the table unmarked by hand still counts as unplayed.
      if (held.length) {
        const database: any = require('../database');
        const rows: Map<string, any> = await database.getPlaystates(userUUID, held, profile);
        for (const row of rows.values()) if (row && !row.played) return;
      }
      await applyWatchedState([next], snapshot, userUUID, profile);
      if (next.UserData?.Played === true) return;
      if (nextAired && (await inNextUp(metaId))) return;
      premieres.push(next);
    });

    premieres.push(...(await sequelPremieres(userUUID, sequels, within, seen)));
    const films = await watchlistFilms(userUUID, config, within, seen);

    return [...(await onePerEpisode(premieres, config)), ...films]
      .filter(keepsUnderProfileCap(config))
      .sort((a, b) => premiereAt(a) - premiereAt(b));
  };

  router.get(['/Items/:itemId/Similar', '/Movies/:itemId/Similar', '/Shows/:itemId/Similar'], async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const limit = Math.min(Math.max(1, qInt(req, 'Limit', 12)), 40);
    const config = await loadConfig(req);
    const descriptor = await decodeJellyfinId(String(req.params.itemId));
    if (!config || !descriptor || (descriptor.k !== 'movie' && descriptor.k !== 'series')) {
      res.json(itemList([], 0, 0));
      return;
    }

    const meta = await fetchMeta(userUUID, descriptor.k, descriptor.i);
    if (!meta) {
      res.json(itemList([], 0, 0));
      return;
    }

    const serverId = serverIdFor(userUUID);
    const rows = await similarTitles(config, meta, descriptor.k);
    const capped = hasAgeRatingCap(config);
    const picked = capped ? rows : rows.slice(0, limit);
    const cards = await titleCards(config, userUUID, picked);
    const items = cards.map((card: any, i: number) => metaToBaseItem(card, picked[i].type, serverId, null))
      .filter(keepsUnderProfileCap(config))
      .slice(0, limit);
    await applyWatchedState(items, await watchedSnapshot(userUUID, config), userUUID, profileKey(config), config);
    res.json(itemList(items, items.length, 0));
  });

  // Skip markers, from the sources the user turned on, in their order.
  const episodeRuntimeMs = (meta: any, descriptor: any): number | null => {
    const video = descriptor.k === 'episode'
      ? (meta.videos || []).find((v: any) => v?.season === descriptor.s && v?.episode === descriptor.e)
      : null;
    const ticks = runtimeTicksFrom(video?.runtime ? video : meta);
    return ticks ? Math.round(ticks / 10000) : null;
  };

  router.get('/MediaSegments/:itemId', async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const itemId = normaliseJellyfinId(String(req.params.itemId));
    const config = await loadConfig(req);
    const descriptor = await decodeJellyfinId(itemId);
    if (!config || !descriptor || (descriptor.k !== 'movie' && descriptor.k !== 'episode')) {
      res.json(itemList([], 0, 0));
      return;
    }

    const meta = await fetchMeta(userUUID, descriptor.k === 'movie' ? 'movie' : 'series', descriptor.i);
    if (!meta) {
      res.json(itemList([], 0, 0));
      return;
    }

    const wanted = String(req.query.includeSegmentTypes ?? req.query.IncludeSegmentTypes ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const segments = await segmentsFor(config, {
      imdbId: meta._imdbId || meta.imdb_id || null,
      tmdbId: meta._tmdbId || null,
      kind: descriptor.k,
      season: descriptor.k === 'episode' ? descriptor.s ?? null : null,
      episode: descriptor.k === 'episode' ? descriptor.e ?? null : null,
      ...(descriptor.k === 'episode' ? await malEpisodeFor(stremioIdFor(descriptor)) : null),
      runtimeMs: (await recallDuration(itemId)) ?? episodeRuntimeMs(meta, descriptor),
    });

    const items = segments
      .filter((segment) => !wanted.length || wanted.includes(segment.type))
      .map((segment) => ({
        Id: segmentId(itemId, segment.type as SegmentType),
        ItemId: itemId,
        Type: segment.type,
        StartTicks: Math.round(segment.startMs * 10000),
        EndTicks: Math.round(segment.endMs * 10000),
      }));
    res.json(itemList(items, items.length, 0));
  });

  router.post(['/Collections', '/Collections/:collectionId/Items'], (_req: any, res: any) => {
    res.status(403).json({ Message: 'Collections are edited in the AIOMetadata configuration' });
  });
  router.delete('/Collections/:collectionId/Items', (_req: any, res: any) => {
    res.status(403).json({ Message: 'Collections are edited in the AIOMetadata configuration' });
  });

  router.get('/Items/Counts', (_req: any, res: any) => {
    res.json({
      MovieCount: 0,
      SeriesCount: 0,
      EpisodeCount: 0,
      ArtistCount: 0,
      ProgramCount: 0,
      TrailerCount: 0,
      SongCount: 0,
      AlbumCount: 0,
      MusicVideoCount: 0,
      BoxSetCount: 0,
      BookCount: 0,
      ItemCount: 0,
    });
  });

  async function singleItemHandler(req: any, res: any): Promise<void> {
    const userUUID = req.params.userUUID;
    const descriptor = await decodeJellyfinId(req.params.itemId);
    if (!descriptor) {
      res.status(404).json({ Message: 'Item not found' });
      return;
    }

    if (descriptor.k === 'marker') {
      const forged = Object.create(req, {
        params: { value: { ...req.params, itemId: descriptor.i, forceSources: true }, enumerable: true },
        query: { value: req.query, enumerable: true },
      });
      await singleItemHandler(forged, res);
      return;
    }

    if (descriptor.k === 'person') {
      const config = await loadConfig(req);
      const person = config ? await resolvePerson(config, descriptor) : null;
      res.json(personItem(String(req.params.itemId), serverIdFor(userUUID), descriptor.n, person));
      return;
    }

    if (descriptor.k === 'episode') {
      const found = await seriesForEpisode(userUUID, await loadConfig(req), descriptor);
      if (!found) {
        res.status(404).json({ Message: 'Item not found' });
        return;
      }
      const { meta, seriesId } = found;
      // Numbering can differ between the series meta and the one an episode's
      // own id resolves to, so the guid is matched rather than the index.
      const episodes = buildEpisodes(meta, descriptor.t, seriesId, serverIdFor(userUUID), null);
      const wanted = normaliseJellyfinId(String(req.params.itemId));
      const episode =
        episodes.find((e: any) => e.Id === wanted) ??
        episodes.find((e: any) => e.IndexNumber === descriptor.e && e.ParentIndexNumber === descriptor.s);
      if (!episode) {
        res.status(404).json({ Message: 'Item not found' });
        return;
      }

      await attachSourcesInTime(req, episode, descriptor, String(req.params.itemId));

      const episodeConfig = await loadConfig(req);
      if (episodeConfig) {
        await applyWatchedState([episode], await watchedSnapshot(userUUID, episodeConfig), userUUID, profileKey(episodeConfig), episodeConfig);
      }

      res.json(episode);
      return;
    }

    // A season is an item a client opens directly, and answering 404 leaves it
    // waiting on a page it will never get.
    if (descriptor.k === 'season') {
      const meta = await fetchMeta(userUUID, 'series', descriptor.i);
      if (!meta) {
        res.status(404).json({ Message: 'Item not found' });
        return;
      }

      const serverId = serverIdFor(userUUID);
      const seriesId = encodeSeriesId(descriptor);
      const season = buildSeasons(meta, descriptor.t, seriesId, serverId)
        .find((entry: any) => entry.IndexNumber === descriptor.s);

      if (!season) {
        res.status(404).json({ Message: 'Item not found' });
        return;
      }
      await withSeasonAnimeIds(meta, [season]);

      const seasonConfig = await loadConfig(req);
      if (seasonConfig) {
        await applyWatchedState([season], await watchedSnapshot(userUUID, seasonConfig), userUUID, profileKey(seasonConfig), seasonConfig, {
          seriesVideos: seriesVideosOf(meta),
        });
      }

      res.json(season);
      return;
    }

    if (descriptor.k === 'movie' || descriptor.k === 'series') {
      const stremioType = descriptor.k === 'movie' ? 'movie' : 'series';
      const meta = await fetchMeta(userUUID, stremioType, descriptor.i);
      if (!meta) {
        res.status(404).json({ Message: 'Item not found' });
        return;
      }
      const item = metaToBaseItem(meta, descriptor.t, serverIdFor(userUUID), null);

      // A meta can resolve to another id than the one it was opened by; the client keys on the one it asked for.
      const requestedId = normaliseJellyfinId(String(req.params.itemId));
      if (item.Id !== requestedId) {
        rememberImages(serverIdFor(userUUID), requestedId, {
          primary: meta.poster || undefined,
          backdrop: meta.background || undefined,
          logo: meta.logo || undefined,
          thumb: meta.landscapePoster || undefined,
        });
        item.Id = requestedId;
        item.Etag = requestedId;
        item.UserData = { ...item.UserData, Key: requestedId, ItemId: requestedId };
      }

      if (descriptor.k === 'movie' && item.Type === 'Movie') {
        await attachSourcesInTime(req, item, descriptor, String(req.params.itemId));
      }

      if (descriptor.k === 'series') {
        const seasons = buildSeasons(meta, descriptor.t, item.Id, serverIdFor(userUUID));
        item.ChildCount = seasons.length;
        item.RecursiveItemCount = (Array.isArray(meta.videos) ? meta.videos : []).length;
      }

      const itemConfig = await loadConfig(req);
      if (itemConfig) {
        await applyWatchedState([item], await watchedSnapshot(userUUID, itemConfig), userUUID, profileKey(itemConfig), itemConfig);
      }

      res.json(item);
      return;
    }

    if (descriptor.k === 'collection' || descriptor.k === 'boxset') {
      const config = await loadConfig(req);
      const collection = config ? collectionById(config, descriptor.c) : null;
      const sets = collection ? await boxSetsDeep(userUUID, config, serverIdFor(userUUID), collection) : [];
      const item = descriptor.k === 'collection'
        ? (collection && sets.length ? collectionView(serverIdFor(userUUID), collection, sets.filter((set: any) => set.ParentId === normaliseJellyfinId(String(req.params.itemId))).length) : null)
        : sets.find((set: any) => set.Id === normaliseJellyfinId(String(req.params.itemId))) ?? null;
      if (!item) {
        res.status(404).json({ Message: 'Item not found' });
        return;
      }
      res.json(item);
      return;
    }

    if (descriptor.k === 'view') {
      const config = await loadConfig(req);
      const catalog = config
        ? await findCatalogByViewId(userUUID, config, descriptor.t, descriptor.c)
        : null;
      if (!catalog) {
        res.status(404).json({ Message: 'Item not found' });
        return;
      }
      res.json(catalogView(catalog, serverIdFor(userUUID), rowFor(config, catalog)));
      return;
    }

    res.status(404).json({ Message: 'Item not found' });
  }
  // Ahead of the item route, which would take /Items/Suggestions for an item id.
  registerStubs(router);
  router.get(['/Items/:itemId', '/Users/:userId/Items/:itemId'], singleItemHandler);

  router.get('/Sessions', async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const serverId = serverIdFor(userUUID);
    const config = await database.getUserConfig(userUUID);
    const profile = sessionProfile(req, config);
    const scoped = await loadConfig(req);
    const sessions = [sessionInfo(profile.userId, serverId, profile.name, clientInfo(req))];
    if (scoped) await withNowPlaying(userUUID, scoped, serverId, sessions);
    res.json(sessions);
  });

  router.post(['/Sessions/Capabilities', '/Sessions/Capabilities/Full'], (_req: any, res: any) => {
    res.status(204).end();
  });

  // Home rows, sort choices and the like live here per user and client.
  const prefsClient = (req: any): string => String(req.query.client ?? req.query.Client ?? '');
  const prefsScope = async (req: any): Promise<[string, string]> => {
    const config = await loadConfig(req);
    return [req.params.userUUID, typeof config?.jellyfinProfileId === 'string' ? config.jellyfinProfileId : ''];
  };

  router.get('/DisplayPreferences/:id', async (req: any, res: any) => {
    const [userUUID, profile] = await prefsScope(req);
    const stored = await database.getPreferences(userUUID, profile, String(req.params.id), prefsClient(req)).catch(() => null);
    res.json({
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      RememberIndexing: false,
      RememberSorting: false,
      PrimaryImageHeight: 250,
      PrimaryImageWidth: 250,
      ScrollDirection: 'Horizontal',
      ShowBackdrop: true,
      ShowSidebar: false,
      Client: prefsClient(req) || 'emby',
      CustomPrefs: {},
      ...(stored || {}),
      Id: req.params.id,
    });
  });

  router.post('/DisplayPreferences/:id', async (req: any, res: any) => {
    const [userUUID, profile] = await prefsScope(req);
    if (req.body && typeof req.body === 'object') {
      await database.savePreferences(userUUID, profile, String(req.params.id), prefsClient(req), req.body).catch((error: any) =>
        logger.debug(`Preferences save failed: ${error?.message || error}`)
      );
    }
    res.status(204).end();
  });

  router.get('/Localization/Options', (_req: any, res: any) => {
    res.json([{ Name: 'English', Value: 'en-US' }]);
  });

  router.get(['/Localization/Cultures', '/Localization/Countries', '/Localization/ParentalRatings'], (_req: any, res: any) => {
    res.json([]);
  });

  // A client reports its own playback to the server it is signed into, which is
  // this one, so the events the hand-off exists to relay arrive here directly.
  // Answering must never block playback, so each is acknowledged and acted on
  // after the response.
  const ack = (res: any) => res.status(204).end();

  router.post(['/Sessions/Playing', '/PlayingItems/:itemId'], (req: any, res: any) => {
    ack(res);
    recordPlaying(req, req.body).catch((error: any) =>
      logger.debug(`Playing report failed: ${error.message}`)
    );
  });

  router.post(['/Sessions/Playing/Progress', '/PlayingItems/:itemId/Progress'], (req: any, res: any) => {
    ack(res);
    recordProgress(req, req.body).catch((error: any) =>
      logger.debug(`Progress report failed: ${error.message}`)
    );
  });

  router.post('/Sessions/Playing/Stopped', (req: any, res: any) => {
    ack(res);
    recordStopped(req, req.body).catch((error: any) =>
      logger.debug(`Stopped report failed: ${error.message}`)
    );
  });

  router.delete('/PlayingItems/:itemId', (req: any, res: any) => {
    ack(res);
    recordStopped(req, req.body || {}).catch((error: any) =>
      logger.debug(`Stopped report failed: ${error.message}`)
    );
  });

  router.post('/Sessions/Playing/Ping', async (req: any, res: any) => {
    ack(res);
    const userUUID = req.params?.userUUID;
    if (!userUUID || !sessionTouchDue(userUUID)) return;
    touchSessions(userUUID, profileKey(await loadConfig(req))).catch((error: any) =>
      logger.debug(`Ping keepalive failed: ${error?.message || error}`)
    );
  });

  // A client reads the new state back out of the response here rather than
  // trusting a bare acknowledgement, and reports the server as not supporting
  // the operation when the body is empty.
  const playedState = (itemId: string, played: boolean): any => {
    const id = normaliseJellyfinId(itemId);
    return {
      ...EMPTY_USER_DATA,
      Key: id,
      ItemId: id,
      Played: played,
      PlayCount: played ? 1 : 0,
      PlaybackPositionTicks: 0,
      PlayedPercentage: played ? 100 : 0,
      LastPlayedDate: played ? new Date().toISOString() : null,
    };
  };

  // Answered once the table holds the mark: the client reads the item back
  // straight after and would otherwise see the state from before.
  router.post(['/Users/:userId/PlayedItems/:itemId', '/UserPlayedItems/:itemId'], async (req: any, res: any) => {
    await recordPlayed(req, { ItemId: req.params.itemId }).catch((error: any) =>
      logger.debug(`Played report failed: ${error.message}`)
    );
    res.json(playedState(String(req.params.itemId), true));
  });

  router.post('/AIOStreams/PlayedUpTo/:itemId', async (req: any, res: any) => {
    const descriptor = await decodeJellyfinId(String(req.params.itemId));
    if (descriptor?.k !== 'episode') {
      res.status(404).json({ Message: 'Episode not found' });
      return;
    }
    await recordPlayedUpTo(req, String(req.params.itemId)).catch((error: any) =>
      logger.debug(`Played up to report failed: ${error.message}`)
    );
    res.status(204).end();
  });

  router.delete(['/Users/:userId/PlayedItems/:itemId', '/UserPlayedItems/:itemId'], async (req: any, res: any) => {
    await recordUnplayed(req, { ItemId: req.params.itemId }).catch((error: any) =>
      logger.debug(`Unplayed report failed: ${error.message}`)
    );
    res.json(playedState(String(req.params.itemId), false));
  });

  const userDataOf = async (req: any, itemId: string): Promise<any | null> => {
    const captured: any[] = [];
    const forged = Object.create(req, {
      params: { value: { ...req.params, itemId, listed: true }, enumerable: true },
      query: { value: req.query, enumerable: true },
    });
    await singleItemHandler(
      forged,
      { json: (body: any) => captured.push(body), status: () => ({ json: () => undefined, end: () => undefined }) }
    );
    return captured[0]?.UserData ?? null;
  };

  const announceTitle = (req: any, config: any, itemId: string): void => {
    const userUUID = req.params.userUUID;
    const profile = profileKey(config);
    (async () => {
      const { hasListeners, pushUserData } = require('./socket');
      if (!(await hasListeners(userUUID, profile))) return;
      const userData = await userDataOf(req, itemId);
      if (!userData) return;
      const { Likes, ...rest } = userData;
      const id = dashedGuid(normaliseJellyfinId(itemId));
      pushUserData(userUUID, profile, [{ ...rest, ...(Likes === false || !clientHasOwnWatchlist() ? { Likes } : {}), Key: id, ItemId: id }]);
    })().catch((error: any) => logger.debug(`User data push failed for ${itemId}: ${error?.message || error}`));
  };

  router.get(['/UserItems/:itemId/UserData', '/Users/:userId/Items/:itemId/UserData'], async (req: any, res: any) => {
    const userData = await userDataOf(req, String(req.params.itemId));
    if (!userData) {
      res.status(404).json({ Message: 'Item not found' });
      return;
    }
    res.json(userData);
  });

  router.post(['/UserItems/:itemId/UserData', '/Users/:userId/Items/:itemId/UserData'], async (req: any, res: any) => {
    try {
      const state = await recordUserData(req, req.body || {});
      if (!state) {
        res.status(400).end();
        return;
      }
      const id = normaliseJellyfinId(String(req.params.itemId));
      res.json({
        ...playedState(id, state.played),
        PlaybackPositionTicks: Math.round(state.positionMs * 10000),
        PlayedPercentage: state.played ? 100 : 0,
        ...(state.rating !== undefined ? { Rating: state.rating } : {}),
      });
    } catch (error: any) {
      logger.debug(`User data update failed: ${error.message}`);
      res.status(500).end();
    }
  });

  const favouriteHandler = (listed: boolean) => async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const itemId = String(req.params.itemId);
    const config = await loadConfig(req);
    const descriptor = await decodeJellyfinId(itemId);
    if (!config || !descriptor) {
      res.status(404).json({ Message: 'Item not found' });
      return;
    }
    const changed = await setWatchlisted(userUUID, config, descriptor, listed);
    res.json({ ...EMPTY_USER_DATA, Key: itemId, ItemId: itemId, IsFavorite: changed && listed });
    if (changed) announceTitle(req, config, itemId);
  };
  const ratingHandler = (clear: boolean) => async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const itemId = String(req.params.itemId);
    const config = await loadConfig(req);
    const descriptor = await decodeJellyfinId(itemId);
    if (!config || !descriptor) {
      res.status(404).json({ Message: 'Item not found' });
      return;
    }
    const asked = String(req.query.likes ?? req.query.Likes ?? '').toLowerCase();
    const likes = clear ? null : asked === 'true' ? true : asked === 'false' ? false : null;
    const { rateSeries } = require('./dropped');
    const undropped = await rateSeries(userUUID, config, descriptor, likes).catch((error: any) => {
      logger.warn(`Rating failed for ${itemId}: ${error?.message || error}`);
      return false;
    });
    if (clear && (await userDataOf(req, itemId).catch(() => null))?.Rating != null) {
      const { rateItem } = require('./ratings');
      await rateItem(userUUID, config, descriptor, null).catch((error: any) =>
        logger.warn(`Clearing the rating failed for ${itemId}: ${error?.message || error}`)
      );
    }
    // A like puts the title on the watchlist and a cleared rating takes it off, for a
    // client that keeps one; a dislike stays a drop, and clearing one only undrops.
    if (clientHasOwnWatchlist() && likes !== false && !(likes === null && undropped)) {
      await setWatchlisted(userUUID, config, descriptor, likes === true).catch((error: any) =>
        logger.warn(`Watchlist change failed for ${itemId}: ${error?.message || error}`)
      );
    }
    res.json({ ...EMPTY_USER_DATA, Key: itemId, ItemId: itemId, Likes: likes });
    announceTitle(req, config, itemId);
  };

  router.post(['/UserItems/:itemId/Rating', '/Users/:userId/Items/:itemId/Rating'], ratingHandler(false));
  router.delete(['/UserItems/:itemId/Rating', '/Users/:userId/Items/:itemId/Rating'], ratingHandler(true));

  router.post(['/Users/:userId/FavoriteItems/:itemId', '/UserFavoriteItems/:itemId'], favouriteHandler(true));
  router.delete(['/Users/:userId/FavoriteItems/:itemId', '/UserFavoriteItems/:itemId'], favouriteHandler(false));

  router.use((req: any, res: any) => {
    logger.debug(`Unsupported endpoint: ${req.method} ${req.path}`);
    res.status(404).json({ Message: `Unsupported Jellyfin endpoint: ${req.method} ${req.path}` });
  });

  return router;
}

export function register(addon: any, options: { loginRateLimit?: any; enabled?: () => boolean } = {}): void {
  const enabled = options.enabled || (() => false);

  const gate = (req: any, res: any, next: any) => {
    if (!enabled()) {
      res.status(404).json({ Message: 'Jellyfin API is disabled' });
      return;
    }
    next();
  };

  addon.use('/jellyfin/:userUUID', gate, createJellyfinRouter({ loginRateLimit: options.loginRateLimit }));

  // Approved from the configuration page, by session or configuration password.
  const approveRateLimit = options.loginRateLimit || ((_req: any, _res: any, next: any) => next());
  addon.post('/api/jellyfin/:userUUID/quick-connect/approve', gate, approveRateLimit, async (req: any, res: any) => {
    const userUUID = String(req.params.userUUID);
    const password = req.body?.password;

    const accountId = req.session?.accountId;
    const owns = Boolean(accountId) && (await database.ownsConfig(accountId, userUUID));
    const verified = !owns && password ? await database.verifyUserAndGetConfig(userUUID, String(password)) : null;
    if (!owns && !verified) {
      res.status(401).json({ error: 'Sign in or enter the configuration password to approve a device' });
      return;
    }

    const config = verified ?? (await database.getUserConfig(userUUID).catch(() => null));
    const profile = profileById(config, userUUID, typeof req.body?.profile === 'string' ? req.body.profile : null);
    const request = await authorizeQuickConnect(userUUID, String(req.body?.code ?? ''), profile.id);
    if (!request) {
      res.status(404).json({ error: 'No device is waiting with that code. Codes expire after a few minutes.' });
      return;
    }

    res.json({ approved: true, device: request.deviceName, app: request.appName, profile: profile.name });
  });

  addon.post('/api/jellyfin/:userUUID/played-thresholds', gate, approveRateLimit, async (req: any, res: any) => {
    const userUUID = String(req.params.userUUID);
    const password = req.body?.password;

    const accountId = req.session?.accountId;
    const owns = Boolean(accountId) && (await database.ownsConfig(accountId, userUUID));
    const verified = !owns && password ? await database.verifyUserAndGetConfig(userUUID, String(password)) : null;
    if (!owns && !verified) {
      res.status(401).json({ error: 'Sign in or enter the configuration password to read the watched points' });
      return;
    }

    const config = verified ?? (await database.getUserConfig(userUUID).catch(() => null));
    const { serverPlayedThreshold, storedPlayedThreshold } = require('./playstate');
    const profiles = await Promise.all(listProfiles(config, userUUID).map(async (profile) => ({
      profile: profile.id,
      percent: await storedPlayedThreshold(userUUID, profile.id),
    })));
    res.json({ serverDefault: serverPlayedThreshold(), profiles });
  });

  addon.post('/api/jellyfin/:userUUID/played-threshold', gate, approveRateLimit, async (req: any, res: any) => {
    const userUUID = String(req.params.userUUID);
    const password = req.body?.password;

    const accountId = req.session?.accountId;
    const owns = Boolean(accountId) && (await database.ownsConfig(accountId, userUUID));
    const verified = !owns && password ? await database.verifyUserAndGetConfig(userUUID, String(password)) : null;
    if (!owns && !verified) {
      res.status(401).json({ error: 'Sign in or enter the configuration password to change the watched point' });
      return;
    }

    const { savePlayedThreshold, validPlayedThreshold } = require('./playstate');
    const requested = req.body?.percent ?? null;
    const percent = requested === null ? null : validPlayedThreshold(requested);
    if (requested !== null && percent === null) {
      res.status(400).json({ error: 'The watched point is a percentage from 50 to 100' });
      return;
    }
    const config = verified ?? (await database.getUserConfig(userUUID).catch(() => null));
    const wanted = typeof req.body?.profile === 'string' && req.body.profile ? req.body.profile : null;
    const profile = profileById(config, userUUID, wanted);
    if (wanted && profile.id !== wanted) {
      res.status(404).json({ error: 'Save the configuration first, so this user exists on the server' });
      return;
    }
    await savePlayedThreshold(userUUID, profile.id, percent);
    res.json({ profile: profile.id, percent });
  });

  addon.post('/api/jellyfin/:userUUID/forget-imported', gate, approveRateLimit, async (req: any, res: any) => {
    const userUUID = String(req.params.userUUID);
    const password = req.body?.password;

    const accountId = req.session?.accountId;
    const owns = Boolean(accountId) && (await database.ownsConfig(accountId, userUUID));
    const verified = !owns && password ? await database.verifyUserAndGetConfig(userUUID, String(password)) : null;
    if (!owns && !verified) {
      res.status(401).json({ error: 'Sign in or enter the configuration password to forget imported history' });
      return;
    }

    const config = verified ?? (await database.getUserConfig(userUUID).catch(() => null));
    const requested = typeof req.body?.profile === 'string' && req.body.profile ? req.body.profile : null;
    const scoped = scopeConfigToProfile(config, userUUID, requested);
    const { forgetImported } = require('./playstateSync');
    const removed = await forgetImported(userUUID, profileKey(scoped));
    res.json({ removed });
  });

  addon.post('/api/jellyfin/:userUUID/import-watchlist', gate, approveRateLimit, async (req: any, res: any) => {
    const userUUID = String(req.params.userUUID);
    const password = req.body?.password;

    const accountId = req.session?.accountId;
    const owns = Boolean(accountId) && (await database.ownsConfig(accountId, userUUID));
    const verified = !owns && password ? await database.verifyUserAndGetConfig(userUUID, String(password)) : null;
    if (!owns && !verified) {
      res.status(401).json({ error: 'Sign in or enter the configuration password to import a watchlist' });
      return;
    }

    const { WATCHLIST_SERVICES } = require('./watchlistSources');
    const services = (Array.isArray(req.body?.services) ? req.body.services : []).map(String).filter((service: string) => WATCHLIST_SERVICES.includes(service));
    if (!services.length) {
      res.status(400).json({ error: 'Pick a service to import from' });
      return;
    }
    const config = verified ?? (await database.getUserConfig(userUUID).catch(() => null));
    const requested = typeof req.body?.profile === 'string' && req.body.profile ? req.body.profile : null;
    const scoped = scopeConfigToProfile(config, userUUID, requested);
    const { importWatchlist } = require('./watchlist');
    const result = await importWatchlist(userUUID, scoped, services);
    if (!result) {
      res.status(409).json({ error: 'That service is not connected in the saved configuration. Save first, then import.' });
      return;
    }
    res.json(result);
  });
}

export { readToken };
