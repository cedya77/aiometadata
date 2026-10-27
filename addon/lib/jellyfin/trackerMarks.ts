import { envInt } from '../../utils/envNumber';
import { credentialFor } from './trackerSource';

export type Mark = 'ratings' | 'watchlist' | 'dropped';
export const MARKS = new Set<string>(['ratings', 'watchlist', 'dropped']);

export const MARK_SOURCES: Record<Mark, Set<string>> = {
  ratings: new Set(['simkl', 'mdblist']),
  watchlist: new Set(['simkl', 'mdblist', 'publicmetadb']),
  dropped: new Set(['simkl', 'mdblist', 'publicmetadb']),
};
export const MARK_TARGETS: Record<Mark, Set<string>> = {
  ratings: new Set(['simkl', 'mdblist', 'publicmetadb', 'anilist', 'mal']),
  watchlist: new Set(['simkl', 'mdblist', 'publicmetadb', 'anilist', 'mal']),
  dropped: new Set(['simkl', 'mdblist', 'publicmetadb', 'anilist', 'mal']),
};

export interface MarkItem {
  kind: 'movie' | 'series' | 'season' | 'episode';
  ids: Record<string, any>;
  season: number | null;
  episode: number | null;
  rating: number | null;
  at: number | null;
  metaId: string;
  anime: boolean;
  later?: boolean;
}

export interface MarkPlan {
  items: MarkItem[];
  excluded: number;
  reasons: Record<string, number>;
}

export interface MarkSide {
  service: string;
  credential: string;
  scoped: any;
}

type Outcome = { done: number; sent: number; failed: number; skipped?: number; wait?: number; error?: string; stalled?: boolean };

const ID_KEYS = ['imdb', 'tmdb', 'tvdb', 'mal', 'anilist', 'kitsu', 'anidb', 'simkl'];
const TYPED = new Set(['tmdb', 'tvdb', 'simkl']);
const TITLE_KEYS = ['imdb', 'tmdb', 'tvdb'];

const dateOf = (value: unknown): number | null => {
  const at = Date.parse(String(value ?? '').replace(' ', 'T'));
  return Number.isFinite(at) ? at : null;
};
const iso = (at: number | null) => (at ? new Date(at).toISOString() : undefined);

function cleanIds(raw: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of ID_KEYS) {
    const value = raw?.[key];
    if (value === null || value === undefined || value === '') continue;
    if (key === 'imdb') {
      if (/^tt\d+$/.test(String(value))) out.imdb = String(value);
    } else if (Number(value) > 0) {
      out[key] = Number(value);
    }
  }
  return out;
}

export function markKeys(item: Pick<MarkItem, 'kind' | 'ids' | 'season' | 'episode'>): string[] {
  const type = item.kind === 'movie' ? 'movie' : 'show';
  const suffix = item.kind === 'season' ? `#${item.season}` : item.kind === 'episode' ? `#${item.season}:${item.episode}` : '';
  return Object.entries(item.ids)
    .filter(([key, value]) => ID_KEYS.includes(key) && value)
    .map(([key, value]) => (TYPED.has(key) ? `${key}:${type}:${value}${suffix}` : `${key}:${value}${suffix}`));
}

function item(kind: MarkItem['kind'], ids: Record<string, any>, extra: Partial<MarkItem> = {}): MarkItem | null {
  if (!Object.keys(ids).length) return null;
  const made: MarkItem = { kind, ids, season: null, episode: null, rating: null, at: null, metaId: '', anime: Boolean(ids.mal || ids.anilist || ids.kitsu), ...extra };
  made.metaId = markKeys(made)[0];
  return made;
}

function scoreOf(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(10, Math.max(1, Math.round(number * 2) / 2)) : null;
}

async function mdblistPages(apiKey: string, path: string, label: string, arrays: string[]): Promise<Record<string, any[]>> {
  const { makeRateLimitedMDBListRequest } = require('../../utils/mdbList');
  const { readToEnd } = require('../../utils/readToEnd');
  const pageSize = envInt('JELLYFIN_WATCHED_PAGE_SIZE', 1000, 1);
  let cursor = '';
  const rows: Array<{ array: string; row: any }> = await readToEnd(label, async (page: number) => {
    const paging = cursor ? `cursor=${encodeURIComponent(cursor)}` : `offset=${page * pageSize}`;
    const response = await makeRateLimitedMDBListRequest(`https://api.mdblist.com${path}${path.includes('?') ? '&' : '?'}limit=${pageSize}&${paging}&apikey=${apiKey}`, apiKey, `${label} page ${page + 1}`);
    const body = response?.data ?? {};
    const items = arrays.flatMap((array) => (Array.isArray(body?.[array]) ? body[array] : []).map((row: any) => ({ array, row })));
    cursor = body?.pagination?.next_cursor ?? '';
    return { items, more: Boolean(cursor) || body?.pagination?.has_more === true };
  });
  const out: Record<string, any[]> = Object.fromEntries(arrays.map((array) => [array, []]));
  for (const { array, row } of rows) out[array].push(row);
  return out;
}

async function simklEntries(credential: string): Promise<Array<{ type: string; data: any }>> {
  const { mirrorRows } = require('./trackerMirror');
  const rows: Array<{ key: string; data: any }> = await mirrorRows('simkl', credential);
  return rows.map((row) => ({ type: row.key.split(':')[0], data: row.data })).filter((row) => ['movies', 'shows', 'anime'].includes(row.type));
}

function simklItem(type: string, data: any, extra: Partial<MarkItem> = {}): MarkItem | null {
  const film = type === 'movies' || data?.anime_type === 'movie';
  const ids = cleanIds((data?.movie ?? data?.show)?.ids);
  const seasons = Array.isArray(data?.mapped_tvdb_seasons) ? data.mapped_tvdb_seasons.map(Number) : [];
  return item(film ? 'movie' : 'series', ids, { anime: type === 'anime', ...(type === 'anime' && !film && seasons.length && !seasons.includes(1) ? { later: true } : {}), ...extra });
}

async function pmdbWatchlistId(side: MarkSide): Promise<string | null> {
  const { publicMetaDBListId, WATCHLIST_CATALOG_ID } = require('../../utils/publicmetadbUtils');
  return publicMetaDBListId(side.scoped, WATCHLIST_CATALOG_ID).catch(() => null);
}

async function pmdbWatchlist(side: MarkSide): Promise<any[]> {
  const listId = await pmdbWatchlistId(side);
  if (!listId) return [];
  const { fetchListItems } = require('../../utils/publicmetadbUtils');
  const { readToEnd } = require('../../utils/readToEnd');
  return readToEnd('PublicMetaDB watchlist', async (page: number) => {
    const data = await fetchListItems(side.credential, listId, page + 1, 500);
    return { items: Array.isArray(data?.items) ? data.items : [], more: page + 1 < (Number(data?.totalPages) || 1) };
  }, (row: any) => String(row?.id ?? `${row?.media_type}:${row?.tmdb_id}`));
}

async function mirrored(service: string, credential: string, key: string): Promise<any> {
  const { mirrorRows } = require('./trackerMirror');
  return ((await mirrorRows(service, credential)) as Array<{ key: string; data: any }>).find((row) => row.key === key)?.data ?? null;
}

const pmdbItem = (row: any, extra: Partial<MarkItem> = {}) => {
  const tmdb = Number(row?.tmdb_id);
  return tmdb > 0 ? item(row?.media_type === 'movie' ? 'movie' : 'series', { tmdb }, extra) : null;
};

export async function readMarks(what: Mark, side: MarkSide): Promise<MarkItem[]> {
  const out: Array<MarkItem | null> = [];
  if (side.service === 'simkl') {
    for (const { type, data } of await simklEntries(side.credential)) {
      if (what === 'ratings' && scoreOf(data?.user_rating)) out.push(simklItem(type, data, { rating: scoreOf(data.user_rating), at: dateOf(data.user_rated_at) }));
      if (what === 'watchlist' && data?.status === 'plantowatch') out.push(simklItem(type, data, { at: dateOf(data.added_to_watchlist_at) }));
      if (what === 'dropped' && data?.status === 'dropped') out.push(simklItem(type, data, { at: dateOf(data.last_watched_at) }));
    }
  } else if (side.service === 'mdblist') {
    if (what === 'ratings') {
      const rated = await mdblistPages(side.credential, '/sync/ratings', 'MDBList ratings', ['movies', 'shows', 'seasons', 'episodes']);
      const extra = (row: any) => ({ rating: scoreOf(row?.rating_precise ?? row?.rating), at: dateOf(row?.rated_at) });
      for (const row of rated.movies) out.push(item('movie', cleanIds(row?.movie?.ids), extra(row)));
      for (const row of rated.shows) out.push(item('series', cleanIds(row?.show?.ids), extra(row)));
      for (const row of rated.seasons) {
        const season = Number(row?.season?.number ?? row?.season?.season);
        if (Number.isFinite(season)) out.push(item('season', cleanIds((row?.season?.show ?? row?.show)?.ids), { ...extra(row), season }));
      }
      for (const row of rated.episodes) {
        const season = Number(row?.episode?.season);
        const episode = Number(row?.episode?.number);
        if (Number.isFinite(season) && Number.isFinite(episode)) out.push(item('episode', cleanIds((row?.episode?.show ?? row?.show)?.ids), { ...extra(row), season, episode }));
      }
    } else if (what === 'watchlist') {
      const listed = await mdblistPages(side.credential, '/watchlist/items', 'MDBList watchlist', ['movies', 'shows']);
      for (const [array, kind] of [['movies', 'movie'], ['shows', 'series']] as const) {
        for (const row of listed[array]) out.push(item(kind, cleanIds({ imdb: row?.imdb_id, tmdb: row?.id, tvdb: row?.tvdb_id, ...row?.ids }), { at: dateOf(row?.watchlist_at ?? row?.added_at) }));
      }
    } else {
      const dropped = await mirrored('mdblist', side.credential, 'dropped');
      for (const row of Array.isArray(dropped?.shows) ? dropped.shows : []) out.push(item('series', cleanIds(row?.show?.ids), { at: dateOf(row?.dropped_at) }));
    }
  } else if (side.service === 'publicmetadb') {
    if (what === 'watchlist') for (const row of await pmdbWatchlist(side)) out.push(pmdbItem(row, { at: dateOf(row?.created) }));
    if (what === 'dropped') {
      const dropped = await mirrored('publicmetadb', side.credential, 'dropped');
      for (const row of Array.isArray(dropped?.items) ? dropped.items : []) out.push(pmdbItem(row, { at: dateOf(row?.created) }));
    }
  }
  return out.filter((entry): entry is MarkItem => Boolean(entry));
}

async function animeListOn(side: MarkSide): Promise<Map<string, any>> {
  const { mirrorRows } = require('./trackerMirror');
  const out = new Map<string, any>();
  for (const { key, data } of (await mirrorRows(side.service, side.credential)) as Array<{ key: string; data: any }>) {
    if (!key.startsWith('entry:')) continue;
    if (data?.anilist) out.set(`anilist:${data.anilist}`, data);
    if (data?.mal) out.set(`mal:${data.mal}`, data);
  }
  return out;
}

async function heldOn(what: Mark, side: MarkSide): Promise<Set<string>> {
  const keys = new Set<string>();
  const add = (entries: MarkItem[]) => entries.forEach((entry) => markKeys(entry).forEach((key) => keys.add(key)));
  if (side.service === 'simkl' && what === 'watchlist') {
    for (const { type, data } of await simklEntries(side.credential)) {
      const entry = simklItem(type, data);
      if (entry) add([entry]);
    }
  } else if (side.service === 'anilist' || side.service === 'mal') {
    for (const [key, data] of await animeListOn(side)) {
      if (what === 'watchlist' || (what === 'ratings' && data?.score > 0) || (what === 'dropped' && data?.status === 'dropped')) keys.add(key);
    }
  } else if (side.service !== 'publicmetadb' || what !== 'ratings') {
    add(await readMarks(what, side));
  }
  return keys;
}

async function simklLibrary(side: MarkSide): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const { type, data } of await simklEntries(side.credential)) {
    const entry = simklItem(type, data);
    if (entry) markKeys(entry).forEach((key) => keys.add(key));
  }
  return keys;
}

function withAnimeIds(entry: MarkItem): MarkItem {
  if (entry.ids.mal && entry.ids.anilist) return entry;
  const idMapper: any = require('../id-mapper');
  const mapping = entry.ids.kitsu ? idMapper.getMappingByKitsuId(Number(entry.ids.kitsu))
    : entry.ids.mal ? idMapper.getMappingByMalId(Number(entry.ids.mal))
      : entry.kind === 'movie' ? idMapper.filmMappingFor({ imdbId: entry.ids.imdb ?? null, tmdbId: entry.ids.tmdb ?? null })
        : entry.ids.imdb ? idMapper.getMappingByImdbId(String(entry.ids.imdb))
          : entry.ids.tvdb ? idMapper.getMappingByTvdbId(Number(entry.ids.tvdb))
            : entry.ids.tmdb ? idMapper.getMappingByTmdbId(Number(entry.ids.tmdb), 'series') : null;
  if (!mapping || !idMapper.mappingIsType(mapping, entry.kind === 'movie' ? 'movie' : 'series')) return entry;
  const ids = { ...entry.ids };
  if (!ids.mal && mapping.mal_id) ids.mal = Number(mapping.mal_id);
  if (!ids.anilist && mapping.anilist_id) ids.anilist = Number(mapping.anilist_id);
  if (!ids.kitsu && mapping.kitsu_id) ids.kitsu = Number(mapping.kitsu_id);
  return { ...entry, ids, anime: true };
}

function eligible(what: Mark, to: string, entry: MarkItem, config: any, library: Set<string> | null, animeOn: Map<string, any> | null): string | null {
  const { shouldTrackServiceMediaType } = require('../watchTracking');
  if (!shouldTrackServiceMediaType(config, to, entry.kind === 'movie' ? 'movie' : 'series')) return 'turned off';
  if (what === 'dropped' && entry.kind !== 'series') return 'not a show';
  if (to === 'anilist' || to === 'mal') {
    if (!entry.ids[to]) return 'not anime';
    const listed = animeOn?.get(`${to}:${entry.ids[to]}`);
    if (what === 'ratings' && (entry.kind === 'season' || entry.kind === 'episode')) return 'not rated there';
    if (what === 'ratings' && !listed) return 'not on list';
    if (what === 'dropped' && listed?.status === 'completed') return 'finished there';
    return null;
  }
  if (what === 'ratings' && entry.later && to !== 'simkl') return 'one season';
  if (to === 'simkl') {
    if (what === 'ratings' && (entry.kind === 'season' || entry.kind === 'episode')) return 'not rated there';
    if (what === 'ratings' && !markKeys(entry).some((key) => library?.has(key))) return 'not in library';
    return null;
  }
  if (to === 'publicmetadb') {
    if (entry.kind === 'season') return 'not rated there';
    return entry.ids.tmdb || entry.ids.imdb ? null : 'no id';
  }
  return TITLE_KEYS.some((key) => entry.ids[key]) ? null : 'no id';
}

export async function planMarks(what: Mark, from: MarkSide, to: MarkSide, since: number): Promise<MarkPlan> {
  const source = (await readMarks(what, from)).filter((entry) => !since || (entry.at ?? 0) >= since);
  const held = await heldOn(what, to);
  const library = to.service === 'simkl' && what === 'ratings' ? await simklLibrary(to) : null;
  const animeOn = to.service === 'anilist' || to.service === 'mal' ? await animeListOn(to) : null;
  const reasons: Record<string, number> = {};
  const taken = new Set<string>();
  const items: MarkItem[] = [];
  const ordered = [...source].sort((a, b) => Number(Boolean(a.later)) - Number(Boolean(b.later)) || (b.at ?? 0) - (a.at ?? 0));
  for (const raw of ordered) {
    const entry = to.service === 'anilist' || to.service === 'mal' ? withAnimeIds(raw) : raw;
    const keys = markKeys(entry);
    if (keys.some((key) => held.has(key) || taken.has(key))) continue;
    const why = eligible(what, to.service, entry, to.scoped, library, animeOn);
    if (why) {
      reasons[why] = (reasons[why] ?? 0) + 1;
      continue;
    }
    keys.forEach((key) => taken.add(key));
    items.push(entry);
  }
  return { items, excluded: Object.values(reasons).reduce((sum, n) => sum + n, 0), reasons };
}

const titleIds = (entry: MarkItem) => Object.fromEntries(TITLE_KEYS.filter((key) => entry.ids[key] && !(key === 'tvdb' && entry.kind === 'movie')).map((key) => [key, entry.ids[key]]));
const notFoundCount = (missed: any) => (typeof missed === 'number' ? missed : ['movies', 'shows', 'seasons', 'episodes', 'anime'].reduce((n, key) => n + (Array.isArray(missed?.[key]) ? missed[key].length : Number(missed?.[key]) || 0), 0));

function mdblistBody(what: Mark, items: MarkItem[]): Record<string, any[]> {
  const movies: any[] = [];
  const shows: any[] = [];
  for (const entry of items) {
    const ids = titleIds(entry);
    if (what === 'watchlist') (entry.kind === 'movie' ? movies : shows).push({ ids });
    else if (what === 'dropped') shows.push({ ids, ...(entry.at ? { dropped_at: iso(entry.at) } : {}) });
    else {
      const scored = { rating: entry.rating, ...(entry.at ? { rated_at: iso(entry.at) } : {}) };
      if (entry.kind === 'movie') movies.push({ ids, ...scored });
      else if (entry.kind === 'series') shows.push({ ids, ...scored });
      else if (entry.kind === 'season') shows.push({ ids, seasons: [{ number: entry.season, ...scored }] });
      else shows.push({ ids, seasons: [{ number: entry.season, episodes: [{ number: entry.episode, ...scored }] }] });
    }
  }
  return { ...(movies.length ? { movies } : {}), ...(shows.length ? { shows } : {}) };
}

async function writeMdblist(what: Mark, items: MarkItem[], apiKey: string): Promise<Outcome> {
  const { mdblistCallsLeft, makeRateLimitedMDBListPost } = require('../../utils/mdbList');
  const { remaining, limit, resetAt } = mdblistCallsLeft(apiKey);
  if (remaining !== null && remaining <= Math.max(50, (limit ?? 0) / 5)) return { done: 0, sent: 0, failed: 0, wait: resetAt - Date.now(), error: 'Waiting for the MDBList quota to reset' };
  const path = what === 'ratings' ? '/sync/ratings' : what === 'watchlist' ? '/watchlist/items/add' : '/sync/dropped';
  try {
    const response = await makeRateLimitedMDBListPost(`https://api.mdblist.com${path}?apikey=${apiKey}`, mdblistBody(what, items), apiKey, `MDBList copy ${what} batch of ${items.length}`);
    const body = response?.data ?? response;
    const missed = Math.min(items.length, notFoundCount(body?.not_found));
    const existing = Math.min(items.length - missed, Number(body?.existing) || 0);
    return { done: items.length, sent: items.length - missed - existing, failed: missed, skipped: existing };
  } catch (error: any) {
    if (error?.code === 'MDBLIST_QUOTA_EXHAUSTED' || error?.response?.status === 429) return { done: 0, sent: 0, failed: 0, wait: mdblistCallsLeft(apiKey).resetAt - Date.now(), error: 'MDBList quota spent' };
    throw error;
  }
}

function simklBody(what: Mark, items: MarkItem[]): Record<string, any[]> {
  const movies: any[] = [];
  const shows: any[] = [];
  for (const entry of items) {
    const ids = entry.ids;
    const row = what === 'ratings'
      ? { ids, rating: Math.min(10, Math.max(1, Math.round(entry.rating ?? 0))), ...(entry.at ? { rated_at: iso(entry.at) } : {}) }
      : { ids, to: what === 'watchlist' ? 'plantowatch' : 'dropped', ...(entry.at && what === 'watchlist' ? { added_at: iso(entry.at) } : {}) };
    (entry.kind === 'movie' ? movies : shows).push(row);
  }
  return { ...(movies.length ? { movies } : {}), ...(shows.length ? { shows } : {}) };
}

async function writeSimkl(what: Mark, items: MarkItem[], tokenId: string): Promise<Outcome> {
  const { getSimklToken, getSimklQuota, makeAuthenticatedSimklRequest } = require('../../utils/simklUtils');
  const accessToken = (await getSimklToken(tokenId))?.access_token;
  if (!accessToken) throw new Error('No Simkl token');
  const quota = await getSimklQuota(accessToken).catch(() => null);
  if (quota && quota.remaining <= Math.max(25, quota.limit / 5)) return { done: 0, sent: 0, failed: 0, wait: quota.resetsAt - Date.now(), error: 'Waiting for the Simkl allowance to reset' };
  try {
    const response = await makeAuthenticatedSimklRequest(`https://api.simkl.com/sync/${what === 'ratings' ? 'ratings' : 'add-to-list'}`, accessToken, `Simkl copy ${what} batch of ${items.length}`, 'POST', simklBody(what, items), 60000);
    if (response?.status && (response.status < 200 || response.status >= 300)) {
      const error: any = new Error(`Simkl answered ${response.status}`);
      error.response = { status: response.status, data: response.data };
      throw error;
    }
    const missed = Math.min(items.length, notFoundCount(response?.data?.not_found));
    return { done: items.length, sent: items.length - missed, failed: missed };
  } catch (error: any) {
    const code = error?.response?.data?.error;
    if (error?.code === 'SIMKL_QUOTA_EXHAUSTED' || code === 'user_limit_exceeded' || code === 'app_limit_exceeded') {
      const later = await getSimklQuota(accessToken).catch(() => null);
      return { done: 0, sent: 0, failed: 0, wait: (later?.resetsAt ?? Date.now() + 6 * 60 * 60 * 1000) - Date.now(), error: 'Simkl allowance spent' };
    }
    if (code === 'rate_limit') return { done: 0, sent: 0, failed: 0, wait: 10_000, error: 'Simkl is finishing another write' };
    throw error;
  }
}

const pmdbSelves = new Map<string, string>();

async function pmdbRatingsOn(side: MarkSide, kind: MarkItem['kind'], tmdb: number, season: number | null, episode: number | null): Promise<any[]> {
  const pmdb = require('../../utils/publicmetadbUtils');
  return kind === 'episode'
    ? pmdb.fetchEpisodeRatings(side.credential, tmdb, Number(season), Number(episode))
    : pmdb.fetchTitleRatings(side.credential, tmdb, kind === 'movie' ? 'movie' : 'tv');
}

async function pmdbSelf(side: MarkSide, userUUID: string): Promise<string | null> {
  const held = pmdbSelves.get(side.credential);
  if (held) return held;
  const database: any = require('../database');
  for (const row of await database.listRemoteRatings(userUUID, 5).catch(() => [])) {
    const parts = String(row.meta_id).split(':').map(Number);
    const kind = parts.length === 4 ? 'episode' : row.meta_type === 'movie' ? 'movie' : parts.length === 2 ? 'series' : null;
    if (!kind) continue;
    const own = (await pmdbRatingsOn(side, kind, parts[1], parts[2] ?? null, parts[3] ?? null).catch(() => [])).find((rating: any) => String(rating?.id) === String(row.pmdb_id));
    if (own?.contributor) {
      pmdbSelves.set(side.credential, String(own.contributor));
      return String(own.contributor);
    }
  }
  return null;
}

async function writeOne(what: Mark, service: string, entry: MarkItem, side: MarkSide, userUUID: string): Promise<'sent' | 'skipped' | 'failed'> {
  if (service === 'publicmetadb') {
    const pmdb = require('../../utils/publicmetadbUtils');
    const tmdb = entry.ids.tmdb ?? await pmdb.tmdbIdFrom(entry.ids, entry.kind === 'movie' ? 'movie' : 'series').catch(() => null);
    if (!tmdb) return 'failed';
    const type = entry.kind === 'movie' ? 'movie' : 'tv';
    if (what === 'ratings') {
      const self = await pmdbSelf(side, userUUID);
      const before = await pmdbRatingsOn(side, entry.kind, Number(tmdb), entry.season, entry.episode);
      if (self && before.some((rating: any) => rating?.contributor === self)) return 'skipped';
      const score = Math.round((entry.rating ?? 0) * 10);
      const id = entry.kind === 'episode'
        ? await pmdb.createEpisodeRating(side.credential, Number(tmdb), Number(entry.season), Number(entry.episode), score)
        : await pmdb.createRating(side.credential, Number(tmdb), type, score);
      if (id && !self) {
        const own = (await pmdbRatingsOn(side, entry.kind, Number(tmdb), entry.season, entry.episode).catch(() => [])).find((rating: any) => String(rating?.id) === String(id));
        if (own?.contributor) pmdbSelves.set(side.credential, String(own.contributor));
      }
      return id ? 'sent' : 'failed';
    }
    if (what === 'dropped') {
      await pmdb.setDropped(side.credential, tmdb, true);
      return 'sent';
    }
    const listId = await pmdbWatchlistId(side);
    if (!listId) return 'failed';
    await pmdb.setListItem(side.credential, listId, tmdb, type, true);
    return 'sent';
  }
  const { ownTokenId } = require('../accounts');
  if (service === 'anilist') {
    const anilist = require('../anilistTracker');
    const token = await anilist.getValidAccessToken(userUUID, ownTokenId(side.scoped, 'anilist'));
    if (!token) throw new Error('AniList token unavailable');
    const done = what === 'ratings' ? await anilist.setScore(entry.ids.anilist, Math.round((entry.rating ?? 0) * 10), token)
      : what === 'dropped' ? await anilist.setDropped(entry.ids.anilist, token)
        : await anilist.setPlanning(entry.ids.anilist, true, token);
    return done ? 'sent' : 'failed';
  }
  const mal = require('../malTracker');
  const token = await mal.getValidAccessToken(userUUID, ownTokenId(side.scoped, 'mal'));
  if (!token) throw new Error('MyAnimeList token unavailable');
  const done = what === 'ratings' ? await mal.setScore(Number(entry.ids.mal), Math.round(entry.rating ?? 0), token)
    : what === 'dropped' ? await mal.setDropped(Number(entry.ids.mal), token)
      : await mal.setPlanToWatch(Number(entry.ids.mal), true, token);
  return done ? 'sent' : 'failed';
}

export function markBatchSize(what: Mark, service: string): number {
  if (service === 'publicmetadb' && what === 'ratings') return 1;
  return service === 'publicmetadb' || service === 'anilist' || service === 'mal' ? 10 : envInt('JELLYFIN_COPY_BATCH_SIZE', 100, 1);
}

export async function writeMarks(what: Mark, items: MarkItem[], side: MarkSide, userUUID: string): Promise<Outcome> {
  if (side.service === 'mdblist') return writeMdblist(what, items, side.credential);
  if (side.service === 'simkl') return writeSimkl(what, items, side.credential);
  const { recordingTrackerCalls } = require('../../utils/trackerCalls');
  const ratingGap = Math.ceil(3_600_000 / envInt('JELLYFIN_COPY_PMDB_RATINGS_PER_HOUR', 200, 1));
  const gap = side.service === 'publicmetadb' ? Math.ceil(1000 / envInt('JELLYFIN_COPY_PMDB_PER_SECOND', 4, 1)) : 1000;
  let done = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const entry of items) {
    let landed: 'sent' | 'skipped' | 'failed' = 'failed';
    const { calls, error } = await recordingTrackerCalls(async () => { landed = await writeOne(what, side.service, entry, side, userUUID); });
    const last = calls[calls.length - 1];
    const status = last ? last.status : error ? -1 : 0;
    if (calls.length && (status === 0 || status === 429 || status >= 500)) {
      return { done, sent, failed, wait: status === 429 ? (what === 'ratings' ? 15 * 60_000 : 30_000) : 60_000, error: `${side.service === 'publicmetadb' ? 'PublicMetaDB' : side.service === 'anilist' ? 'AniList' : 'MyAnimeList'} answered ${status || 'nothing'}`, stalled: status !== 429 };
    }
    done += 1;
    const outcome: string = error ? 'failed' : landed;
    if (outcome === 'sent') sent += 1;
    else if (outcome === 'skipped') skipped += 1;
    else failed += 1;
    if (what === 'ratings' && side.service === 'publicmetadb') return { done, sent, failed, skipped, wait: outcome === 'sent' ? ratingGap : gap };
    await new Promise((resolve) => setTimeout(resolve, gap));
  }
  return { done, sent, failed, skipped };
}

export function markSide(service: string, config: any): MarkSide | null {
  const credential = credentialFor(config, service as any);
  return credential ? { service, credential, scoped: config } : null;
}

export function markVideo(entry: Pick<MarkItem, 'kind' | 'ids' | 'season' | 'episode'>): string {
  const { ids } = entry;
  if (entry.kind === 'movie') return ids.imdb ?? (ids.kitsu ? `kitsu:${ids.kitsu}` : ids.mal ? `mal:${ids.mal}` : `tmdb:${ids.tmdb}`);
  const base = ids.imdb ?? (ids.kitsu ? `kitsu:${ids.kitsu}` : ids.mal ? `mal:${ids.mal}` : ids.tvdb ? `tvdb:${ids.tvdb}` : `tmdb:${ids.tmdb}`);
  return `${base}:${entry.season ?? 1}:${entry.episode ?? 1}`;
}
