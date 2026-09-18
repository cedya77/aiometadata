import express from 'express';
import consola from 'consola';
import { envInt } from '../../utils/envNumber';
import { mapWithConcurrency } from '../../utils/concurrency';
import { randomUUID, timingSafeEqual } from 'crypto';
import {
  attachJellyfinContext,
  clientInfo,
  loadConfig,
  requireAuth,
  serverIdFor,
} from './context';
import { mintToken, readToken, revokeToken } from './tokens';
import {
  collectionFolder,
  EMPTY_USER_DATA,
  itemList,
  publicSystemInfo,
  sessionInfo,
  systemInfo,
  userDto,
  SERVER_NAME,
} from './dto';
import { buildViews, collectionTypeFor, findCatalogByViewId, getCatalogs, getSearchableCatalogs, isBrowsable } from './views';
import { decodeJellyfinId } from './ids';
import { buildEpisodes, buildSeasons, fetchCatalogPage, fetchMeta, fetchWindow, filterByIncludeTypes, includeTypesFilter, knownCatalogLength, metaToBaseItem, recallImages, rememberImages, sortNameFor } from './items';
import { dashedGuid, encodeJellyfinId, normaliseJellyfinId, parseStremioId, stremioIdFor } from './ids';
import { coalesce, fetchStreams, fileFor, languageCode, languageName, mediaSourceFor, normaliseStreamBase, forgetDuration, placeholderMediaSource, recallDuration, recallFailure, recallIssued, recallStreams, rememberDuration, rememberFailure, rememberStreams, runtimeTicksFrom, streamUserAgent, toPlayable } from './streams';
import { fetchAddonSubtitles, formatOf, pickSubtitles, recallOffered, rememberOffered, subtitleBody, subtitleCodecFor, subtitleExtensionOf, subtitleFormatFor, subtitleLanguage, type SubtitleTrack } from './subtitles';
import { memoNextUp, resumeSnapshot, resumeUserData } from './resume';
import { refreshSeriesIndex, seriesIndex, warmSeriesIndex } from './episodeIndex';
import { authorizeQuickConnect, claimQuickConnect, initiateQuickConnect, quickConnectResult, readQuickConnect } from './quickConnect';
import { avatarTag, keepsUnderProfileCap, listProfiles, profileById, profileByName, profileByUserId, profileKey, profileTags, type Profile } from './profiles';
import { malEpisodeFor, segmentId, segmentsFor, type SegmentType } from './segments';
import { personByName, personCredits, similarTitles } from './people';
import { allBoxSets, boxSetMembers, boxSetsDeep, boxSetsFor, boxSetsUnder, collectionById, collectionView, folderById, folderCoverSize } from './collections';
import { setWatchlisted, watchlistEntries, watchlistItems } from './watchlist';
import { applyWatchedState, isWatched, ownNextUpRows, upcomingFollowed, watchedSnapshot, type NextUpRow } from './watched';
import { registerStubs } from './stubs';
import { recordPlayed, recordPlaying, recordProgress, recordStopped, recordUnplayed, recordUserData } from './playstate';

const database: any = require('../database');

const logger = consola.withTag('Jellyfin');

function maxMediaSources(): number {
  return envInt('JELLYFIN_MAX_MEDIA_SOURCES', 50, 1);
}

function encodeSeriesId(descriptor: any): string {
  return encodeJellyfinId({ k: 'series', t: descriptor.t, i: descriptor.i });
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
      const wanted = encodeJellyfinId(descriptor);
      if (meta && buildEpisodes(meta, descriptor.t, '', '', null).some((e: any) => e.Id === wanted)) {
        return { meta, seriesId: encodeJellyfinId({ k: 'series', t: descriptor.t, i: String(meta.id) }) };
      }
    }
  }
  const meta = await fetchMeta(userUUID, 'series', descriptor.i);
  return meta ? { meta, seriesId: encodeSeriesId(descriptor) } : null;
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

function userFor(profile: Profile, serverId: string, configuration?: any): any {
  const user = userDto(profile.userId, serverId, profile.name, avatarTag(profile));
  if (configuration && typeof configuration === 'object') user.Configuration = { ...user.Configuration, ...configuration };
  return user;
}

const USER_CONFIGURATION_ID = 'user-configuration';

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
    if (/^\/emby(\/|$)/i.test(req.url)) req.url = req.url.replace(/^\/emby/i, '') || '/';
    next();
  });

  router.use((req: any, _res: any, next: any) => {
    const query = req.originalUrl.includes('?') ? `?${req.originalUrl.split('?')[1]}` : '';
    logger.debug(`${req.method} ${req.path}${query}`);
    next();
  });

  // The official SDK parses ids as UUIDs and refuses the bare form. ServerId is
  // a plain string, but a client matches it to the Id it saw at discovery.
  const ID_FIELD = /^(Id|ItemId|ParentId|SeriesId|SeasonId|UserId|ServerId|AlbumId|ChannelId|ParentLogoItemId|ParentBackdropItemId|ParentThumbItemId|ParentPrimaryImageItemId|Key|DisplayPreferencesId|PlaylistItemId|MediaSourceId)$/;
  const BARE_GUID = /^[0-9a-f]{32}$/i;
  const dashIds = (value: any): any => {
    if (Array.isArray(value)) return value.map(dashIds);
    if (!value || typeof value !== 'object') return value;
    const out: any = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && BARE_GUID.test(v) && (ID_FIELD.test(k) || k.endsWith('Ids'))) out[k] = dashedGuid(v);
      else if (Array.isArray(v) && k.endsWith('Ids')) out[k] = v.map((x) => (typeof x === 'string' && BARE_GUID.test(x) ? dashedGuid(x) : x));
      else out[k] = dashIds(v);
    }
    return out;
  };
  // An Apple client opens the YouTube app's scheme, not a web link; the web client embeds the web link.
  const APPLE_CLIENT = /swiftfin|tvos|apple ?tv|ios|ipad|iphone/i;
  const appTrailers = (value: any): any => {
    if (Array.isArray(value)) return value.map(appTrailers);
    if (!value || typeof value !== 'object') return value;
    const out: any = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === 'RemoteTrailers' && Array.isArray(v)
        ? v.map((t: any) => (typeof t?.Url === 'string' ? { ...t, Url: t.Url.replace(/^https?:\/\/(www\.)?youtube\.com\//i, 'youtube://www.youtube.com/') } : t))
        : appTrailers(v);
    }
    return out;
  };

  const seenClients = new Set<string>();
  router.use((req: any, res: any, next: any) => {
    const json = res.json.bind(res);
    const info = clientInfo(req);
    const label = `${info.client} | ${info.device}`;
    if (!seenClients.has(label) && info.client !== 'Unknown') {
      seenClients.add(label);
      logger.info(`Client seen: ${label} (${info.version})`);
    }
    const apple = APPLE_CLIENT.test(info.client) || APPLE_CLIENT.test(info.device);
    res.json = (body: any) => json(dashIds(apple ? appTrailers(body) : body));
    next();
  });

  router.use(attachJellyfinContext);

  // --- Handshake ---

  router.get('/System/Info/Public', (req: any, res: any) => {
    res.json(publicSystemInfo(serverIdFor(req.params.userUUID), baseFor(req)));
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
  router.get(['/Users/:userId/Images/Primary', '/Users/:userId/Images/Primary/:index'], async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const config = await database.getUserConfig(userUUID).catch(() => null);
    const profile = config && profileByUserId(config, userUUID, req.params.userId);
    if (!profile) {
      res.status(404).end();
      return;
    }

    if (!profile.avatar) {
      res.status(404).end();
      return;
    }
    res.redirect(302, profile.avatar);
  });

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

  router.post('/Users/AuthenticateByName', loginRateLimit, async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const password = req.body?.Pw ?? req.body?.pw ?? req.body?.Password ?? '';

    let config = await database.verifyUserAndGetConfig(userUUID, String(password));

    // An account that signs in through a provider has no configuration password
    // to type, and a client's sign-in form cannot run that flow, so a password
    // issued for these clients is accepted here as well.
    if (!config) {
      const stored = await database.getUserConfig(userUUID).catch(() => null);
      if (stored?.jellyfinAppPassword && matchesAppPassword(stored.jellyfinAppPassword, String(password))) {
        config = stored;
      }
    }

    if (!config) {
      logger.debug(`Rejected Jellyfin login for ${userUUID}`);
      res.status(401).json({ Message: 'Invalid username or password' });
      return;
    }

    await signIn(req, res, userUUID, config, profileByName(config, userUUID, req.body?.Username ?? req.body?.username));
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

  // --- Authenticated surface ---

  router.use(requireAuth);

  router.get('/System/Info', (req: any, res: any) => {
    res.json(systemInfo(serverIdFor(req.params.userUUID), baseFor(req)));
  });

  router.post('/QuickConnect/Authorize', async (req: any, res: any) => {
    const config = await loadConfig(req);
    const asked = req.query.userId ?? req.query.UserId;
    const profile = (asked && profileByUserId(config, req.params.userUUID, asked)) || sessionProfile(req, config);
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

    const config = await loadConfig(req);
    if (!config) {
      res.json(itemList([], 0, startIndex));
      return;
    }

    const serverId = serverIdFor(userUUID);

    // The watchlist, newest first, is what a client calls favourites.
    if (filters.includes('IsFavorite')) {
      const started = Date.now();
      const wanted = includeItemTypes
        ? new Set(String(includeItemTypes).split(',').map((t) => t.trim()).filter(Boolean))
        : null;
      const entries = (await watchlistEntries(userUUID, config)).filter((entry) =>
        !wanted || wanted.has(entry.mediaType === 'movie' ? 'Movie' : 'Series')
      );
      const listed = Date.now() - started;
      const page = entries.slice(startIndex, startIndex + limit);
      const items = await watchlistItems(userUUID, config, serverId, page, shelfConcurrency());
      await applyWatchedState(items, await watchedSnapshot(userUUID, config), userUUID, profileKey(config));
      logger.debug(`Favourites for ${userUUID}: ${items.length} of ${entries.length} in ${Date.now() - started}ms (entries ${listed}ms)`);
      res.json(itemList(items, entries.length, startIndex));
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
          params: { value: { ...req.params, itemId: id, listed: true }, enumerable: true },
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
    if (searchTerm) {
      extras.search = String(searchTerm);
      extras.light = '1';
    }

    if (genreNames.length > 1) {
      logger.debug(`Only the first of ${genreNames.length} genres is filterable: ${genreNames[0]}`);
    }

    const personIds = String(req.query.PersonIds ?? req.query.personIds ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    if (personIds.length) {
      const items = await personItems(userUUID, config, serverId, personIds[0], includeItemTypes);
      res.json(itemList(items.slice(startIndex, startIndex + limit), items.length, startIndex));
      return;
    }

    if (!parentId) {
      // Clients build search rows here, one call per section: /Search/Hints is
      // a single flat list with no way to express them.
      if (searchTerm) {
        const found = await searchAcross(
          userUUID,
          config,
          serverId,
          String(searchTerm),
          startIndex + limit,
          includeItemTypes
        );
        const page = found.slice(startIndex, startIndex + limit);
        await applyWatchedState(page, await watchedSnapshot(userUUID, config), userUUID, profileKey(config), config);
        res.json(itemList(page, found.length, startIndex));
        return;
      }

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

      const pool = (await getCatalogs(userUUID, config)).filter(isBrowsable).filter((catalog: any) => {
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

        let children = wantsEpisodes
          ? buildEpisodes(meta, descriptor.t, encodeSeriesId(descriptor), serverId, descriptor.k === 'season' ? descriptor.s : null)
          : buildSeasons(meta, descriptor.t, String(parentId), serverId);
        await applyWatchedState(children, await watchedSnapshot(userUUID, config), userUUID, profileKey(config), config);

        const filters = String(req.query.Filters ?? req.query.filters ?? '').split(',').map((f) => f.trim());
        if (filters.includes('IsPlayed')) children = children.filter((c: any) => c.UserData?.Played === true);
        if (filters.includes('IsUnplayed')) children = children.filter((c: any) => c.UserData?.Played !== true);

        const sortBy = String(req.query.SortBy ?? req.query.sortBy ?? '');
        const descending = String(req.query.SortOrder ?? req.query.sortOrder ?? '').toLowerCase() === 'descending';
        if (sortBy.includes('IndexNumber')) {
          children.sort((a: any, b: any) =>
            ((a.ParentIndexNumber ?? 0) - (b.ParentIndexNumber ?? 0)) || ((a.IndexNumber ?? 0) - (b.IndexNumber ?? 0))
          );
          if (descending) children.reverse();
        }

        const page = children.slice(startIndex, startIndex + limit);
        res.json(itemList(page, children.length, startIndex));
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
        const children = !wantedTypes.length || wantedTypes.includes('BoxSet')
          ? await boxSetsUnder(userUUID, config, serverId, collection, folder)
          : [];
        const pageCap = envInt('JELLYFIN_LIST_PAGE_MAX', 50, 20);
        const folderLimit = limit > pageCap * 2 ? pageCap : limit;
        const ahead = children.slice(startIndex, startIndex + folderLimit);
        const titlesFrom = Math.max(0, startIndex - children.length);
        const room = folderLimit - ahead.length;
        const page = room > 0
          ? await boxSetMembers(userUUID, config, serverId, collection, folder, titlesFrom, room, includeItemTypes ? String(includeItemTypes) : undefined)
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

      if (!descriptor || descriptor.k !== 'view' || String(includeItemTypes ?? '') === 'BoxSet') {
        res.json(itemList([], 0, startIndex));
        return;
      }
      const found = await findCatalogByViewId(userUUID, config, descriptor.t, descriptor.c);
      if (!found) {
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

    const window = await fetchWindow(
      userUUID,
      catalog,
      startIndex,
      limit,
      extras,
      includeTypesFilter(catalog.type, includeItemTypes ? String(includeItemTypes) : undefined),
      profileTags(config)
    );
    const hasMore = window.hasMore;

    const items = window.items
      .filter((meta: any) => meta && meta.id)
      .map((meta: any) => metaToBaseItem(meta, catalog.type, serverId, String(parentId)));

    const filtered = filterByIncludeTypes(items, includeItemTypes ? String(includeItemTypes) : undefined)
      .slice(0, limit);

    // Catalogs report no total, so one page of lookahead keeps the client asking
    // and collapses to the truth once a window comes back short. This only holds
    // because fetchWindow always fills a window, making short mean finished.
    const total = hasMore && filtered.length > 0
      ? startIndex + filtered.length + limit
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

  const resolveMediaSources = async (
    req: any,
    descriptor: any,
    runtimeTicks: number | null
  ): Promise<any[]> => {
    if (!descriptor || (descriptor.k !== 'movie' && descriptor.k !== 'episode')) return [];

    const config = await loadConfig(req);
    const base = normaliseStreamBase(config?.jellyfinStreamUrl || '');
    if (!base) {
      logger.debug(`No stream addon configured for ${req.params.userUUID}`);
      return [];
    }

    const stremioId = stremioIdFor(descriptor);
    if (!stremioId) return [];

    const stremioType = descriptor.k === 'movie' ? 'movie' : 'series';
    const cacheKey = `${req.params.userUUID}:${stremioType}:${stremioId}`;

    const streams =
      recallStreams(cacheKey) ??
      (await coalesce(cacheKey, async () => {
        const fetched = await fetchStreams(base, stremioType, stremioId);
        if (fetched.streams.length) rememberStreams(cacheKey, fetched.streams);
        if (fetched.failure) rememberFailure(cacheKey, fetched.failure);
        return fetched.streams;
      }));

    const seen = new Set<string>();
    const sources: any[] = [];
    for (const stream of streams) {
      const playable = toPlayable(stream);
      if (!playable || seen.has(playable.id)) continue;
      seen.add(playable.id);
      sources.push(mediaSourceFor(playable, runtimeTicks));
    }

    logger.debug(`Streams ${stremioType}/${stremioId}: ${streams.length} offered, ${sources.length} playable`);
    if (streams.length && !sources.length) rememberFailure(cacheKey, 'No playable stream for this title');
    return sources.slice(0, maxMediaSources());
  };

  // What the picker says when a resolve leaves nothing to list.
  const streamFailure = (req: any, descriptor: any): string => {
    const stremioId = stremioIdFor(descriptor);
    const stremioType = descriptor.k === 'movie' ? 'movie' : 'series';
    return recallFailure(`${req.params.userUUID}:${stremioType}:${stremioId}`) ?? 'No streams found for this title';
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

  // Instance rule first; on means the full resolve, bounded by the stream request.
  const resolveOnOpen = async (req: any): Promise<boolean> => {
    const mode = String(require('../settingsService').getSetting('JELLYFIN_RESOLVE_ON_OPEN') || 'user');
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    return (await loadConfig(req))?.jellyfinResolveOnOpen === true;
  };

  const attachSourcesInTime = async (req: any, item: any, descriptor: any, itemId: string): Promise<void> => {
    if (req.params?.listed) return;
    if (!req.params?.forceSources && !asksForSources(req) && !(await resolveOnOpen(req))) return;
    await attachSources(req, item, descriptor, itemId).catch((error: any) =>
      logger.debug(`Sources for ${itemId} unavailable: ${error?.message || error}`)
    );
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
      : parsed.idType === 'mal' ? idMapper.getMappingByMalId(numeric)
      : parsed.idType === 'anilist' ? idMapper.getMappingByAnilistId(numeric)
      : null;
    const imdb = mapping?.imdb_id || (mapping?.mal_id ? idMapper.getTraktAnimeMovieByMalId?.(mapping.mal_id)?.externals?.imdb : null);
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
      const reason = placeholderMediaSource(item.MediaSources[0].Id, streamFailure(req, descriptor));
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
    if (!sources.length) return sources;
    const id = normaliseJellyfinId(itemId);
    // A play report then names the item, not the hash the duration sits under.
    const ms = await recallDuration(sources[0].Id).catch(() => null);
    if (ms) rememberDuration(id, ms);
    else forgetDuration(id);
    return sources.map((source, index) =>
      index === 0 ? { ...source, Id: id, ETag: id } : source
    );
  };

  const unwrapMarker = async (itemId: string): Promise<{ itemId: string; descriptor: any }> => {
    const descriptor = await decodeJellyfinId(itemId);
    if (descriptor?.k === 'marker') return { itemId: descriptor.i, descriptor: await decodeJellyfinId(descriptor.i) };
    return { itemId, descriptor };
  };

  const playbackHandler = async (req: any, res: any) => {
    const { itemId, descriptor } = await unwrapMarker(String(req.params.itemId));

    if (!descriptor || (descriptor.k !== 'movie' && descriptor.k !== 'episode')) {
      res.status(404).json({ MediaSources: [], PlaySessionId: '', ErrorCode: 'NotAllowed' });
      return;
    }

    const requested = req.query.MediaSourceId ?? req.body?.MediaSourceId;
    const all = await resolveMediaSources(req, descriptor, null);
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

    const sources = await withDefaultSourceId(await resolveMediaSources(req, descriptor, null), itemId);
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

    const requested = req.query.MediaSourceId ?? req.query.mediaSourceId;
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
    if (!descriptor || descriptor.k !== 'view') return { catalog: null, genres: [] };

    const catalog = await findCatalogByViewId(req.params.userUUID, config, descriptor.t, descriptor.c);
    if (!catalog) return { catalog: null, genres: [] };

    const extra = (catalog.extra ?? []).find((e: any) => e?.name === 'genre');
    const options = Array.isArray(extra?.options) ? extra.options : [];
    return {
      catalog,
      genres: options.filter((g: any) => typeof g === 'string' && g && g !== 'None'),
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
      ImageTags: person?.photo ? { Primary: 'p' } : {},
      BackdropImageTags: [],
      UserData: { ...EMPTY_USER_DATA, Key: bare, ItemId: bare },
    };
  };

  const personItems = async (userUUID: string, config: any, serverId: string, personId: string, includeItemTypes: any): Promise<any[]> => {
    const descriptor = await decodeJellyfinId(personId);
    if (!descriptor || descriptor.k !== 'person') return [];
    const person = await personByName(config, descriptor.n);
    if (!person) return [];
    const metas = await personCredits(config, person.id);
    const items = metas.map((meta: any) => metaToBaseItem(meta, meta.type, serverId, null));
    return filterByIncludeTypes(items, includeItemTypes ? String(includeItemTypes) : undefined).filter(keepsUnderProfileCap(config));
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
        // The same title reaches us from more than one catalog under different
        // ids, so identity alone cannot spot the repeat. Only the leading year
        // is compared: one catalog says '2023-' where another says '2023-2024'.
        const year = String(meta.year ?? meta.releaseInfo ?? '').slice(0, 4);
        const title = `${String(meta.name || '').toLowerCase()}|${year}|${meta.type}`;
        if (seen.has(String(meta.id)) || (meta.name && seen.has(title))) continue;
        seen.add(String(meta.id));
        if (meta.name) seen.add(title);
        // An untyped catalog such as AI search would give the same film a
        // second id, and a client merging two calls then shows it twice.
        const kind = collectionTypeFor(page.catalog.type) ? page.catalog.type : meta.type === 'movie' ? 'movie' : 'series';
        items.push(metaToBaseItem(meta, kind, serverId, null));
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
    const person = await personByName(config, term).catch(() => null);
    if (!person) {
      res.json(itemList([], 0, 0));
      return;
    }
    const id = encodeJellyfinId({ k: 'person', n: person.name });
    res.json(itemList([personItem(id, serverIdFor(req.params.userUUID), person.name, person)], 1, 0));
  });

  router.get('/Search/Hints', async (req: any, res: any) => {
    const term = String(req.query.SearchTerm ?? req.query.searchTerm ?? '').trim();
    const limit = Math.min(Math.max(1, qInt(req, 'Limit', 20)), 50);
    const includeItemTypes = req.query.IncludeItemTypes ?? req.query.includeItemTypes;

    if (!term) {
      res.json({ SearchHints: [], TotalRecordCount: 0 });
      return;
    }

    const config = await loadConfig(req);
    if (!config) {
      res.json({ SearchHints: [], TotalRecordCount: 0 });
      return;
    }

    const userUUID = req.params.userUUID;
    const serverId = serverIdFor(userUUID);
    const items = await searchAcross(userUUID, config, serverId, term, limit, includeItemTypes);

    const filtered = items.slice(0, limit);

    res.json({
      SearchHints: filtered.map((item: any) => ({
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
      })),
      TotalRecordCount: filtered.length,
    });
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

  router.get(['/Items/Filters', '/Items/Filters2'], async (req: any, res: any) => {
    const parentId = req.query.ParentId ?? req.query.parentId;
    const { catalog, genres } = await genreOptionsFor(req, parentId);
    const serverId = serverIdFor(req.params.userUUID);

    res.json({
      Genres: genres,
      Tags: [],
      OfficialRatings: [],
      Years: [],
      GenreItems: catalog
        ? genres.map((genre: string) => ({
            Name: genre,
            Id: encodeJellyfinId({ k: 'genre', t: catalog.type, c: catalog.id, g: genre }),
            ServerId: serverId,
          }))
        : [],
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
      const seriesId = encodeSeriesId(descriptor);
      buildEpisodes(meta, descriptor.t, seriesId, scope, null);
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
      const wanted = normaliseJellyfinId(String(req.params.itemId));
      const episode = buildEpisodes(meta, descriptor.t, found.seriesId, serverId, null).find((e: any) => e.Id === wanted);
      const number = episode?.ParentIndexNumber ?? descriptor.s;
      const season = number === null || number === undefined
        ? null
        : buildSeasons(meta, descriptor.t, series.Id, serverId).find((entry: any) => entry.IndexNumber === number);
      if (season) chain.push(season);
    }

    chain.push(series);
    res.json(chain);
  });

  router.get(['/Items/:itemId/Images/:imageType', '/Items/:itemId/Images/:imageType/:index'], async (req: any, res: any) => {
    const images = await imagesFor(req, String(req.params.itemId));
    if (!images) {
      res.status(404).end();
      return;
    }
    const kind = String(req.params.imageType).toLowerCase();
    let url =
      kind === 'primary' ? images.primary
      : kind === 'backdrop' ? images.backdrop
      : kind === 'logo' ? images.logo
      : kind === 'thumb' ? images.thumb
      : undefined;

    if (!url) {
      res.status(404).end();
      return;
    }
    url = tmdbSized(url, kind, qInt(req, 'MaxWidth', 0));

    // A folder cover is cropped to its tile's shape rather than letterboxed by the client.
    if (kind === 'primary') {
      const descriptor = await decodeJellyfinId(String(req.params.itemId));
      if (descriptor?.k === 'boxset') {
        const config = await loadConfig(req);
        const size = folderCoverSize(config, descriptor.c, descriptor.f);
        await streamCropped(res, url, size.width, size.height);
        return;
      }
    }

    const cached = throughPosterCache(url, kind);
    if (cached) {
      const local = builtinPosterCachePath(cached);
      if (local) {
        await serveFromPosterCache(req, res, local, cached);
        return;
      }
      res.set('Cache-Control', 'public, max-age=86400');
      res.redirect(302, cached);
      return;
    }
    if (kind === 'primary') {
      await streamShaped(res, url);
      return;
    }
    await streamImage(res, url);
  });

  const TMDB_ORIGINAL = 'https://image.tmdb.org/t/p/original/';
  const TMDB_WIDTHS: Record<string, number[]> = {
    logo: [92, 154, 185, 300, 500],
    poster: [92, 154, 185, 342, 500, 780],
    backdrop: [300, 780, 1280],
  };
  const tmdbSized = (url: string, kind: string, maxWidth: number): string => {
    if (!url.includes(TMDB_ORIGINAL)) return url;
    const bucket = kind === 'logo' ? 'logo' : kind === 'backdrop' || kind === 'thumb' ? 'backdrop' : 'poster';
    const widths = TMDB_WIDTHS[bucket];
    const wanted = maxWidth > 0 ? maxWidth : bucket === 'backdrop' ? 1280 : bucket === 'logo' ? 500 : 780;
    const width = widths.find((w) => w >= wanted);
    return width ? url.replace(TMDB_ORIGINAL, `https://image.tmdb.org/t/p/w${width}/`) : url;
  };

  const builtinPosterCachePath = (url: string): string | null => {
    const posterCache = require('../posterCache/config');
    if (!posterCache.isBuiltinPosterCacheEnabled?.()) return null;
    const origin: string = posterCache.getSelfOrigin?.() || '';
    const route: string = posterCache.POSTER_CACHE_ROUTE;
    if (!origin || !url.startsWith(`${origin}${route}/`)) return null;
    return url.slice(origin.length);
  };

  const serveFromPosterCache = (req: any, res: any, path: string, fallback: string): Promise<void> =>
    new Promise((resolve) => {
      const inner = Object.create(req, {
        url: { value: path, writable: true },
        originalUrl: { value: path, writable: true },
        baseUrl: { value: '', writable: true },
        method: { value: 'GET' },
      });
      res.once('finish', resolve);
      res.once('close', resolve);
      req.app.handle(inner, res, () => {
        if (!res.headersSent) res.redirect(302, fallback);
        resolve();
      });
    });

  // Without a cache the bytes pass through here anyway, so a poster is shaped on the way out.
  const streamShaped = async (res: any, url: string): Promise<void> => {
    try {
      const { openImageStream } = require('../posterCache/upstream');
      const { shapePoster } = require('../posterCache/shape');
      const upstream = await openImageStream(url);
      if (upstream.notModified) {
        res.status(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of upstream.response.data) chunks.push(Buffer.from(chunk));
      const shaped = await shapePoster(Buffer.concat(chunks), upstream.contentType);
      res.set('Content-Type', shaped.contentType);
      res.set('Cache-Control', 'public, max-age=86400');
      res.end(shaped.body);
    } catch (error: any) {
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
    const imageClass = kind === 'backdrop' ? 'background' : kind === 'logo' ? 'logo' : kind === 'thumb' ? 'landscape' : 'poster';
    return posterCache.buildCachedUrl(prefix, imageClass, url);
  };

  const streamCropped = async (res: any, url: string, width: number, height: number): Promise<void> => {
    try {
      const { openImageStream } = require('../posterCache/upstream');
      const sharp = require('sharp');
      const upstream = await openImageStream(url);
      if (upstream.notModified) {
        res.status(404).end();
        return;
      }
      const transformer = sharp({ sequentialRead: true, limitInputPixels: 10000 * 10000 })
        .resize(width, height, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 90 });
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      transformer.on('error', (error: any) => {
        logger.debug(`Cover crop failed for ${url}: ${error?.message || error}`);
        res.end();
      });
      upstream.response.data.on('error', () => res.end());
      upstream.response.data.pipe(transformer).pipe(res);
    } catch (error: any) {
      logger.debug(`Cover fetch failed for ${url}: ${error?.message || error}`);
      res.status(404).end();
    }
  };

  const streamImage = async (res: any, url: string): Promise<void> => {
    try {
      const { openImageStream } = require('../posterCache/upstream');
      const upstream = await openImageStream(url);
      if (upstream.notModified) {
        res.status(404).end();
        return;
      }
      res.set('Content-Type', upstream.contentType);
      res.set('Cache-Control', 'public, max-age=86400');
      upstream.response.data.on('error', () => res.end());
      upstream.response.data.pipe(res);
    } catch (error: any) {
      logger.debug(`Image stream failed for ${url}: ${error?.message || error}`);
      res.status(404).end();
    }
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
    if (!config) {
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
    if (!catalog) {
      res.json([]);
      return;
    }

    const serverId = serverIdFor(userUUID);
    const window = await fetchWindow(userUUID, catalog, 0, limit, {}, undefined, profileTags(config));
    const items = window.items
      .filter((meta: any) => meta && meta.id)
      .map((meta: any) => metaToBaseItem(meta, catalog.type, serverId, String(parentId)));

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
    const rows = await resumeSnapshot(userUUID, config);
    if (!rows.length) {
      res.json(itemList([], 0, startIndex));
      return;
    }

    const serverId = serverIdFor(userUUID);
    const window = rows.slice(startIndex, startIndex + limit);
    const watched = await watchedSnapshot(userUUID, config);

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
        item.UserData = resumeUserData(item.Id, row, item.RunTimeTicks ?? null, isWatched(watched, row.videoId));
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

      target.UserData = resumeUserData(target.Id, row, target.RunTimeTicks ?? null, isWatched(watched, row.videoId));
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
    const meta = await fetchMeta(req.params.userUUID, 'series', descriptor.i);
    return meta ? { descriptor, meta } : null;
  };

  router.get('/Shows/:seriesId/Seasons', async (req: any, res: any) => {
    const found = await seriesMetaFor(req);
    if (!found) {
      res.json(itemList([], 0, 0));
      return;
    }
    const seasons = buildSeasons(found.meta, found.descriptor.t, String(req.params.seriesId), serverIdFor(req.params.userUUID));
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
    const startIndex = from + Math.max(0, qInt(req, 'StartIndex', 0));
    const limit = Math.max(1, qInt(req, 'Limit', episodes.length || 1));
    const page = episodes.slice(startIndex, startIndex + limit);

    const episodesConfig = await loadConfig(req);
    if (episodesConfig) {
      await applyWatchedState(page, await watchedSnapshot(req.params.userUUID, episodesConfig), req.params.userUUID, profileKey(episodesConfig));
    }
    res.json(itemList(page, episodes.length - from, startIndex - from));
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
    const memoKey = `${userUUID}:${profileKey(config)}:${digest}:${q('EnableResumable')}:${q('EnableRewatching')}:${q('SeriesId') || q('ParentId')}`;
    const found = await memoNextUp(userUUID, memoKey, () => buildNextUp(req, userUUID, config));
    const page = found.slice(startIndex, startIndex + limit);
    res.json(itemList(page, found.length, startIndex));
    warmSeriesMetas(req, userUUID, page);
  });

  const buildNextUp = async (req: any, userUUID: string, config: any): Promise<any[]> => {
    const t0 = Date.now();
    const lap = { snapshot: 0, resumable: 0, own: 0, meta: 0, episodes: 0, state: 0 };
    const snapshot = await watchedSnapshot(userUUID, config);
    lap.snapshot = Date.now() - t0;

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
        for (const alias of await videoIdAliases(row.videoId)) {
          const parsed = parseStremioId(alias);
          if (parsed) resumable.add(parsed.base);
        }
      }
    }

    lap.resumable = Date.now() - t1;
    // The table first; a tracker adds the shows it knows that the table does not.
    const t2 = Date.now();
    const own = (await ownNextUpRows(userUUID, profileKey(config))).filter((row) => !snapshot.dropped.has(row.metaId));
    lap.own = Date.now() - t2;
    const known = new Set(own.map((row) => row.metaId));
    const merged = [...own, ...snapshot.nextUp.filter((row) => !known.has(row.metaId))]
      .sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);

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

    const rows = scoped.filter((row) => {
      if (resumable && resumable.has(row.metaId)) return false;
      if (!includeRewatching && !seriesParam) {
        const counts = snapshot.series.get(row.metaId);
        if (counts && counts.total > 0 && counts.watched >= counts.total) return false;
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
    let skipped = 0;
    await warmSeriesIndex(userUUID, rows.map((row) => row.metaId));
    await mapWithConcurrency(rows, shelfConcurrency(), async (row, index) => {
      const locate = async (episodes: any[], metaId: string): Promise<any | undefined> =>
        row.videoId
          ? locateEpisode(episodes, row.videoId, row.mediaType, metaId)
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

      // The table and a tracker can name one show in different id spaces.
      identity[index] = meta._tmdbId ? `tmdb:${meta._tmdbId}` : meta._imdbId ? `imdb:${meta._imdbId}` : String(meta.id);

      if (!target) {
        skipped += 1;
        logger.debug(`Next Up skipped ${row.metaId}: ${row.videoId ?? `S${row.season ?? '?'}E${row.episode}`} is not among its ${episodes.length} episodes`);
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
      const airedAt = next === target && row.airsAt ? row.airsAt : Date.parse(next?.PremiereDate || '');
      if (!next) {
        skipped += 1;
        logger.debug(`Next Up skipped ${row.metaId}: every episode from ${target.Name} on is played`);
        return;
      }
      if (Number.isFinite(airedAt) && airedAt > nowMs) {
        skipped += 1;
        logger.debug(`Next Up skipped ${row.metaId}: ${next.Name} airs ${next.PremiereDate}`);
        return;
      }
      items[index] = next;
    });

    const shown = new Set<string>();
    const found = items
      .filter((item, index) => {
        if (!item || shown.has(identity[index])) return false;
        shown.add(identity[index]);
        return true;
      })
      .filter(keepsUnderProfileCap(config));
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
    const memoKey = `${userUUID}:${profileKey(config)}:upcoming:${digest}`;
    const ordered = await memoNextUp(userUUID, memoKey, () => buildUpcoming(userUUID, config), (items) =>
      items.map((item) => Date.parse(item?.PremiereDate || '')).filter((at) => at > Date.now()).sort((a, b) => a - b)[0] ?? null
    );
    res.json(itemList(ordered.slice(startIndex, startIndex + limit), ordered.length, startIndex));
  });

  const buildUpcoming = async (userUUID: string, config: any): Promise<any[]> => {
    const now = Date.now();
    const days = envInt('JELLYFIN_UPCOMING_DAYS', 90, 1);
    const horizon = now + days * 24 * 60 * 60 * 1000;
    const serverId = serverIdFor(userUUID);
    const profile = profileKey(config);
    const premiereAt = (item: any): number => Date.parse(item?.PremiereDate || '');
    const within = (at: number): boolean => Number.isFinite(at) && at > now && at <= horizon;

    const [snapshot, resume, own, caughtUp] = await Promise.all([
      watchedSnapshot(userUUID, config),
      resumeSnapshot(userUUID, config),
      ownNextUpRows(userUUID, profile),
      upcomingFollowed(config, days),
    ]);
    // Tracker-followed shows are all checked; locally known ones are capped.
    const shows = new Map<string, string>();
    for (const row of [...caughtUp, ...snapshot.following]) {
      if (!shows.has(row.metaId)) shows.set(row.metaId, row.mediaType);
    }
    let local = 0;
    const localCap = envInt('JELLYFIN_UPCOMING_LOCAL_SHOWS', 60, 0);
    for (const row of [...own.filter((r) => !snapshot.dropped.has(r.metaId)), ...snapshot.nextUp, ...resume.filter((r) => r.kind === 'episode')]) {
      if (shows.has(row.metaId)) continue;
      if (local >= localCap) break;
      shows.set(row.metaId, row.mediaType);
      local += 1;
    }
    const followed = [...shows.entries()];
    const named = new Map<string, NextUpRow>();
    for (const row of snapshot.nextUp) if (row.airsAt) named.set(row.metaId, row);

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
        if (within(row.airsAt as number)) {
          if (episode) {
            episode.PremiereDate = new Date(row.airsAt as number).toISOString();
            premieres.push(episode);
          }
          return;
        }
        // Aired and, by the tracker, unwatched: Next Up's business unless the table says it was played.
        if (episode) await applyWatchedState([episode], snapshot, userUUID, profile);
        if (!episode || episode.UserData?.Played !== true) return;
      }
      const next = episodes
        .filter((episode: any) => within(premiereAt(episode)))
        .sort((a: any, b: any) => premiereAt(a) - premiereAt(b))[0];
      if (!next) return;
      // Only a show the user is caught up on: an aired episode still unwatched
      // is Next Up's business. The snapshot answers for most; the table is
      // asked only about aired episodes it does not hold.
      const aired = episodes.filter((episode: any) => {
        const at = premiereAt(episode);
        return Number.isFinite(at) && at <= now;
      });
      const { stremioIdFor } = require('./idsCodec');
      const unknown: any[] = [];
      const held: string[] = [];
      for (const episode of aired) {
        const d = await decodeJellyfinId(String(episode.Id));
        const videoId = d ? stremioIdFor(d) : null;
        if (!videoId || !isWatched(snapshot, videoId)) unknown.push(episode);
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
      if (next.UserData?.Played !== true) premieres.push(next);
    });

    const watchlists = (await getCatalogs(userUUID, config)).filter(
      (catalog: any) => /\.watchlist\b/.test(catalog.id) && collectionTypeFor(catalog.type) === 'movies'
    );
    const films: any[] = [];
    await mapWithConcurrency(watchlists, 2, async (catalog: any) => {
      const window = await fetchWindow(userUUID, catalog, 0, envInt('JELLYFIN_UPCOMING_WATCHLIST_LIMIT', 100, 1), {}, undefined, profileTags(config))
        .catch(() => ({ items: [] as any[], hasMore: false }));
      for (const meta of window.items) {
        const item = metaToBaseItem(meta, catalog.type, serverId, null);
        if (item.Type === 'Movie' && within(premiereAt(item)) && !seen.has(item.Id)) {
          seen.add(item.Id);
          films.push(item);
        }
      }
    });

    return [...premieres, ...films]
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
    if (!meta?._tmdbId) {
      res.json(itemList([], 0, 0));
      return;
    }

    const serverId = serverIdFor(userUUID);
    const metas = await similarTitles(config, String(meta._tmdbId), descriptor.k);
    const items = metas
      .map((m: any) => metaToBaseItem(m, m.type, serverId, null))
      .filter(keepsUnderProfileCap(config))
      .slice(0, limit);
    res.json(itemList(items, items.length, 0));
  });

  // Skip markers, from PublicMetaDB when the user has a key, AniSkip for anime, IntroDB otherwise.
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
      const person = config ? await personByName(config, descriptor.n) : null;
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
        await applyWatchedState([episode], await watchedSnapshot(userUUID, episodeConfig), userUUID, profileKey(episodeConfig));
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

      const seasonConfig = await loadConfig(req);
      if (seasonConfig) {
        await applyWatchedState([season], await watchedSnapshot(userUUID, seasonConfig), userUUID, profileKey(seasonConfig));
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

      if (descriptor.k === 'movie') {
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
      res.json(
        collectionFolder(
          req.params.itemId,
          serverIdFor(userUUID),
          catalog.name,
          collectionTypeFor(catalog.type),
          null
        )
      );
      return;
    }

    res.status(404).json({ Message: 'Item not found' });
  }
  router.get(['/Items/:itemId', '/Users/:userId/Items/:itemId'], singleItemHandler);

  router.get('/Sessions', async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const serverId = serverIdFor(userUUID);
    const config = await database.getUserConfig(userUUID);
    const profile = sessionProfile(req, config);
    res.json([sessionInfo(profile.userId, serverId, profile.name, clientInfo(req))]);
  });

  router.post(['/Sessions/Capabilities', '/Sessions/Capabilities/Full'], (_req: any, res: any) => {
    res.status(204).end();
  });

  // Home rows, sort choices and the like live here per user and client.
  const prefsClient = (req: any): string => String(req.query.client ?? req.query.Client ?? '');
  const prefsScope = async (req: any): Promise<[string, string]> => [req.params.userUUID, profileKey(await loadConfig(req))];

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

  router.post('/Sessions/Playing/Ping', (_req: any, res: any) => ack(res));

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

  router.delete(['/Users/:userId/PlayedItems/:itemId', '/UserPlayedItems/:itemId'], async (req: any, res: any) => {
    await recordUnplayed(req, { ItemId: req.params.itemId }).catch((error: any) =>
      logger.debug(`Unplayed report failed: ${error.message}`)
    );
    res.json(playedState(String(req.params.itemId), false));
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
        PlaybackPositionTicks: state.positionMs * 10000,
        PlayedPercentage: state.played ? 100 : 0,
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
  };
  router.post(['/Users/:userId/FavoriteItems/:itemId', '/UserFavoriteItems/:itemId'], favouriteHandler(true));
  router.delete(['/Users/:userId/FavoriteItems/:itemId', '/UserFavoriteItems/:itemId'], favouriteHandler(false));

  registerStubs(router);

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
}

export { readToken };
