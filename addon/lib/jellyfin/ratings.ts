import consola from 'consola';
import { credentialFor } from './trackerSource';
import { buildVideoId, stremioIdFor, type Descriptor } from './idsCodec';

const logger = consola.withTag('Jellyfin');
const database: any = require('../database');

/** Simkl takes a title's rating, MDBList a season's and an episode's too; an anime season is its own entry. */
const RATES: Record<'simkl' | 'mdblist' | 'publicmetadb' | 'anilist' | 'mal', ReadonlySet<string>> = {
  simkl: new Set(['movie', 'series']),
  mdblist: new Set(['movie', 'series', 'season', 'episode']),
  publicmetadb: new Set(['movie', 'series', 'episode']),
  anilist: new Set(['movie', 'series', 'season']),
  mal: new Set(['movie', 'series', 'season']),
};

export function seasonKey(base: string, season: number): string {
  return `${base}#s${season}`;
}

export function ratingKeyFor(descriptor: Descriptor): string | null {
  if (descriptor.k === 'season') return seasonKey(descriptor.i, descriptor.s);
  return descriptor.k === 'movie' || descriptor.k === 'series' || descriptor.k === 'episode' ? stremioIdFor(descriptor) : null;
}
const ANIME_ONLY = new Set(['anilist', 'mal']);

/** A client's 0 to 10 as the trackers' whole 1 to 10; nothing, or 0, clears it. */
export function ratingFrom(value: unknown): number | null {
  const number = Number(value);
  if (value === null || value === undefined || !Number.isFinite(number) || number <= 0) return null;
  return Math.min(10, Math.max(1, Math.round(number)));
}

export function titleKeys(metaId: string, ids: Record<string, any>): string[] {
  const keys = new Set<string>([metaId]);
  if (ids.imdb) keys.add(String(ids.imdb));
  if (ids.tvdb) keys.add(`tvdb:${ids.tvdb}`);
  if (ids.tmdb) keys.add(`tmdb:${ids.tmdb}`);
  if (ids.kitsu) keys.add(`kitsu:${ids.kitsu}`);
  if (ids.mal) keys.add(`mal:${ids.mal}`);
  return [...keys];
}

/** Every id a rated movie, series, season or episode is known by, each holding its rating. */
async function keysFor(descriptor: Descriptor, ids: Record<string, any>, metaId: string): Promise<string[]> {
  if (descriptor.k === 'season') {
    return [...new Set([descriptor.i, ...titleKeys(metaId, ids)])].map((base) => seasonKey(base, descriptor.s));
  }
  if (descriptor.k !== 'episode') return titleKeys(metaId, ids);
  const { videoIdAliases } = require('./aliases');
  const keys = new Set<string>();
  for (const base of titleKeys(metaId, ids)) keys.add(buildVideoId(base, descriptor.s, descriptor.e));
  const own = stremioIdFor(descriptor);
  if (own) {
    keys.add(own);
    for (const alias of await videoIdAliases(own)) keys.add(alias);
  }
  return [...keys];
}

/** Saves a rating here, or clears it with null, and sends it to the trackers that take it. */
export async function rateItem(userUUID: string, config: any, descriptor: Descriptor, rating: number | null): Promise<boolean> {
  if (descriptor.k !== 'movie' && descriptor.k !== 'series' && descriptor.k !== 'season' && descriptor.k !== 'episode') return false;
  const { fetchMeta } = require('./items');
  const { idsFor } = require('./watchlist');
  const { profileKey, writesTrackers } = require('./profiles');

  const stremioType = descriptor.k === 'movie' ? 'movie' : 'series';
  const meta = await fetchMeta(userUUID, stremioType, descriptor.i);
  if (!meta) return false;
  const ids = idsFor(meta, stremioType);
  const keys = await keysFor(descriptor, ids, String(meta.id));
  const profile = profileKey(config);
  const held: any[] = await database.listRatings(userUUID, profile, keys).catch(() => []);
  const previous = held.find((row) => row.pmdb_id)?.pmdb_id ?? null;
  await database.setRating(userUUID, profile, keys, rating, stremioType);

  if (writesTrackers(config)) {
    const { enqueueTrackerWrites } = require('../trackerOutbox');
    const { shouldTrackServiceMediaType } = require('../watchTracking');
    const anime = Boolean(ids.mal || ids.kitsu);
    const services = (['simkl', 'mdblist', 'publicmetadb', 'anilist', 'mal'] as const).filter(
      (service) =>
        RATES[service].has(descriptor.k) &&
        (anime || !ANIME_ONLY.has(service)) &&
        credentialFor(config, service) &&
        shouldTrackServiceMediaType(config, service, stremioType)
    );
    const item =
      descriptor.k === 'episode' ? `${meta.id}:${descriptor.s}:${descriptor.e}`
      : descriptor.k === 'season' ? seasonKey(String(meta.id), descriptor.s)
      : String(meta.id);
    await enqueueTrackerWrites(userUUID, config, services.map((service) => ({
      service,
      op: 'rate',
      item,
      coalesce: `rate:${item}`,
      payload: {
        kind: descriptor.k,
        ids,
        season: descriptor.k === 'episode' || descriptor.k === 'season' ? descriptor.s : null,
        episode: descriptor.k === 'episode' ? descriptor.e : null,
        rating,
        ...(descriptor.k === 'episode' ? { video: stremioIdFor(descriptor) } : {}),
        ...(descriptor.k === 'season' ? { video: buildVideoId(descriptor.i, descriptor.s, 1) } : {}),
        ...(service === 'publicmetadb' ? { previous, keys, profile } : {}),
      },
    })));
  }
  const part = descriptor.k === 'episode' ? ` S${descriptor.s}E${descriptor.e}` : descriptor.k === 'season' ? ` S${descriptor.s}` : '';
  logger.info(`${rating === null ? 'Cleared the rating of' : `Rated ${rating}/10:`} ${meta.name || meta.id}${part} for ${userUUID}`);
  return true;
}

/** The ratings held for these ids, keyed by the id asked for. */
export async function ratingsAmong(userUUID: string, profile: string, ids: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, number>();
  if (!unique.length) return out;
  const rows: any[] = await database.listRatings(userUUID, profile, unique).catch(() => []);
  for (const row of rows) out.set(String(row.meta_id), Number(row.rating));
  return out;
}

/** An episode as TMDB numbers it, which MDBList and PublicMetaDB both go by and a show laid out by TVDB may not. */
async function tmdbEpisode(config: any, video: string | null | undefined): Promise<{ tmdbId: number; season: number; episode: number } | null> {
  if (!video) return null;
  const { parseMediaId, resolveSeriesIds } = require('../subtitleHandler');
  const { tmdbIdFrom } = require('../../utils/publicmetadbUtils');
  const parsed = parseMediaId(video);
  const resolution = parsed ? await resolveSeriesIds(parsed, config) : null;
  const tmdbId = resolution ? await tmdbIdFrom(resolution.ids, 'series') : null;
  return tmdbId && resolution ? { tmdbId: Number(tmdbId), season: resolution.season, episode: resolution.episode } : null;
}

async function seasonEntry(ids: Record<string, any>, season: number): Promise<Record<string, string> | null> {
  const tvdb = Number(ids?.tvdb) || Number(ids?.imdb ? require('../id-mapper').getMappingByImdbId(String(ids.imdb))?.tvdb_id : 0);
  return tvdb ? require('./items').seasonAnimeEntry(tvdb, season) : null;
}

/** One rating, or its removal, on one tracker. */
export async function writeRating(config: any, payload: any, only: string, userUUID?: string): Promise<void> {
  const { kind, ids, season, episode, rating } = payload ?? {};
  const titleIds = {
    ...(ids?.imdb ? { imdb: ids.imdb } : {}),
    ...(ids?.tmdb ? { tmdb: Number(ids.tmdb) } : {}),
    ...(ids?.tvdb && kind !== 'movie' ? { tvdb: Number(ids.tvdb) } : {}),
  };
  const clearing = rating === null || rating === undefined;

  if (only === 'simkl') {
    const token = credentialFor(config, 'simkl');
    if (!token || (kind !== 'movie' && kind !== 'series')) return;
    const { getSimklToken, makeAuthenticatedSimklRequest } = require('../../utils/simklUtils');
    const access = (await getSimklToken(token))?.access_token;
    if (!access) throw new Error('Simkl token unavailable');
    const simklIds = { ...titleIds, ...(ids?.mal ? { mal: Number(ids.mal) } : {}), ...(ids?.kitsu ? { kitsu: Number(ids.kitsu) } : {}) };
    // Simkl files a rated title it does not hold as watched, so only one already in the library is rated there.
    if (!clearing) {
      const held = await makeAuthenticatedSimklRequest('https://api.simkl.com/sync/watched', access, 'Simkl library check', 'POST', [{ ids: simklIds }]);
      const entry = (Array.isArray(held?.data) ? held.data : Array.isArray(held) ? held : [])[0];
      if (!entry?.list) {
        logger.debug(`Not rating on Simkl: ${JSON.stringify(simklIds)} is not in the library`);
        return;
      }
    }
    const entry = clearing ? { ids: simklIds } : { ids: simklIds, rating };
    const body = kind === 'movie' ? { movies: [entry] } : { shows: [entry] };
    await makeAuthenticatedSimklRequest(`https://api.simkl.com/sync/ratings${clearing ? '/remove' : ''}`, access, `Simkl ${clearing ? 'unrate' : 'rate'}`, 'POST', body);
    return;
  }

  if (only === 'mdblist') {
    const key = credentialFor(config, 'mdblist');
    if (!key || !Object.keys(titleIds).length) return;
    const { makeRateLimitedMDBListPost } = require('../../utils/mdbList');
    const scored = (entry: Record<string, any>) => (clearing ? entry : { ...entry, rating });
    let body: Record<string, any>;
    if (kind === 'episode' || kind === 'season') {
      const target = await tmdbEpisode(config, payload.video);
      if (!target) return;
      const season = kind === 'season' ? scored({ number: target.season }) : { number: target.season, episodes: [scored({ number: target.episode })] };
      body = { shows: [{ ids: { ...titleIds, tmdb: target.tmdbId }, seasons: [season] }] };
    } else {
      body = kind === 'movie' ? { movies: [scored({ ids: titleIds })] } : { shows: [scored({ ids: titleIds })] };
    }
    const result = await makeRateLimitedMDBListPost(`https://api.mdblist.com/sync/ratings${clearing ? '/remove' : ''}?apikey=${key}`, body, key, `MDBList ${clearing ? 'unrate' : 'rate'}`);
    const errors = (result?.data ?? result)?.errors;
    if (Array.isArray(errors) && errors.length) logger.warn(`MDBList ${clearing ? 'unrate' : 'rate'} not applied: ${JSON.stringify(errors).slice(0, 300)}`);
    return;
  }

  if (only === 'publicmetadb') {
    const key = credentialFor(config, 'publicmetadb');
    if (!key || kind === 'season') return;
    const pmdb = require('../../utils/publicmetadbUtils');
    const episodic = kind === 'episode';
    const remove = episodic ? pmdb.deleteEpisodeRating : pmdb.deleteRating;
    if (payload.previous) {
      await remove(key, payload.previous).catch((error: any) =>
        logger.debug(`PublicMetaDB rating ${payload.previous} not deleted: ${error?.message || error}`)
      );
    }
    if (clearing) return;

    let id: string | null = null;
    if (episodic) {
      const target = await tmdbEpisode(config, payload.video);
      if (!target) return;
      id = await pmdb.createEpisodeRating(key, target.tmdbId, target.season, target.episode, rating * 10);
    } else {
      if (!ids?.tmdb) return;
      id = await pmdb.createRating(key, Number(ids.tmdb), kind === 'movie' ? 'movie' : 'tv', rating * 10);
    }
    if (!id || !userUUID) return;
    // Cleared here before this landed: the rating just made goes too.
    const stored = await database.setRatingRemoteId(userUUID, payload.profile ?? '', payload.keys ?? [], id);
    if (!stored) await remove(key, id);
    return;
  }

  if (only === 'mal' || only === 'anilist') {
    if (kind === 'episode' || !userUUID) return;
    const entry = kind === 'season' ? await seasonEntry(ids, Number(season)) : null;
    if (kind === 'season' && !entry && Number(season) !== 1) return;
    // As watch tracking resolves them; with no episode, a show's first season is its entry.
    const parsed = ids?.imdb
      ? { type: kind === 'movie' ? 'movie' : 'series', provider: 'imdb', id: String(ids.imdb) }
      : ids?.kitsu
        ? { type: kind === 'movie' ? 'movie' : 'series', provider: 'kitsu', id: String(ids.kitsu) }
        : ids?.mal
          ? { type: kind === 'movie' ? 'movie' : 'series', provider: 'mal', id: String(ids.mal) }
          : null;
    if (!parsed && !entry) return;
    const { ownTokenId } = require('../accounts');
    if (only === 'mal') {
      const mal = require('../malTracker');
      const malId = entry ? entry.MyAnimeList : (await mal.resolveMalId(parsed))?.malId ?? (ids?.mal ? Number(ids.mal) : null);
      if (!malId) return;
      const token = await mal.getValidAccessToken(userUUID, ownTokenId(config, 'mal'));
      if (!token) throw new Error('MyAnimeList token unavailable');
      if (!(await mal.setScore(Number(malId), clearing ? 0 : rating, token))) logger.debug(`Not scoring on MyAnimeList: ${malId} is not on the list`);
      return;
    }
    const anilist = require('../anilistTracker');
    const token = await anilist.getValidAccessToken(userUUID, ownTokenId(config, 'anilist'));
    if (!token) throw new Error('AniList token unavailable');
    const anilistId = entry
      ? entry.AniList ?? (entry.MyAnimeList ? await anilist.anilistIdForMal(entry.MyAnimeList, token) : null)
      : (await anilist.resolveAniListId(parsed))?.anilistId ?? (ids?.mal ? await anilist.anilistIdForMal(ids.mal, token) : null);
    if (!anilistId) return;
    if (!(await anilist.setScore(anilistId, clearing ? 0 : rating * 10, token))) logger.debug(`Not scoring on AniList: ${anilistId} is not on the list`);
  }
}
