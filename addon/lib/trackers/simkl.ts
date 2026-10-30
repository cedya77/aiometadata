import { MARK_KINDS, type Mark, type Tracker } from './types';
import { cleanIds, dateOf, iso, keysOf, markItem, markKeys, notFoundCount, scoreOf, type MarkItem, type MarkOutcome } from './marks';
import { sharesId, targetsFor, type CopyItem, type CopyTarget, type WatchOutcome } from './watches';
import type { SimklMissed } from '../../utils/simklUtils';
import type { MatchCandidate, TargetSeason } from './match';
import { SAME_PLAY_MS, nothingToMove, playTime, type Redate } from './redate';

async function simklEntries(credential: string): Promise<Array<{ type: string; data: any }>> {
  const { mirrorRows } = require('../jellyfin/trackerMirror');
  const rows: Array<{ key: string; data: any }> = await mirrorRows('simkl', credential);
  return rows.map((row) => ({ type: row.key.split(':')[0], data: row.data })).filter((row) => ['movies', 'shows', 'anime'].includes(row.type));
}

function simklItem(type: string, data: any, extra: Partial<MarkItem> = {}): MarkItem | null {
  const film = type === 'movies' || data?.anime_type === 'movie';
  const ids = cleanIds((data?.movie ?? data?.show)?.ids);
  const seasons = Array.isArray(data?.mapped_tvdb_seasons) ? data.mapped_tvdb_seasons.map(Number) : [];
  return markItem(film ? 'movie' : 'series', ids, { anime: type === 'anime', ...(type === 'anime' && !film && seasons.length && !seasons.includes(1) ? { later: true } : {}), ...extra });
}

async function library(credential: string): Promise<Set<string>> {
  const entries = (await simklEntries(credential)).map(({ type, data }) => simklItem(type, data));
  return keysOf(entries.filter((entry): entry is MarkItem => Boolean(entry)));
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

async function writeMarks(what: Mark, items: MarkItem[], tokenId: string): Promise<MarkOutcome> {
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

const SIMKL_KEYS = ['simkl', 'imdb', 'tmdb', 'tvdb', 'mal', 'anidb', 'kitsu', 'anilist'];

async function watchesHeld(credential: string): Promise<Set<string>> {
  const { mirrorRows } = require('../jellyfin/trackerMirror');
  const rows: Array<{ key: string; data: any }> = await mirrorRows('simkl', credential);
  const out = new Set<string>();
  for (const { key, data } of rows) {
    const media = data?.movie ?? data?.show;
    const ids = Object.entries(media?.ids ?? {}).filter(([name, value]) => SIMKL_KEYS.includes(name) && value);
    if (key.startsWith('movies:') || data?.anime_type === 'movie') {
      for (const [name, value] of ids) out.add(`movie:${name}:${value}`);
      continue;
    }
    const mapped = Array.isArray(data?.mapped_tvdb_seasons) ? data.mapped_tvdb_seasons.map(Number) : [];
    const ownNumbers = key.startsWith('anime:') && mapped.length && !mapped.includes(1)
      ? ids.filter(([name]) => !['imdb', 'tmdb', 'tvdb'].includes(name))
      : ids;
    for (const season of Array.isArray(data?.seasons) ? data.seasons : []) {
      for (const episode of Array.isArray(season?.episodes) ? season.episodes : []) {
        for (const [name, value] of ownNumbers) out.add(`${name}:${value}:${season.number}:${episode.number}`);
        if (episode?.tvdb?.season != null && media?.ids?.tvdb) out.add(`tvdb:${media.ids.tvdb}:${episode.tvdb.season}:${episode.tvdb.episode}`);
        if (episode?.tvdb?.season != null && media?.ids?.imdb) out.add(`imdb:${media.ids.imdb}:${episode.tvdb.season}:${episode.tvdb.episode}`);
      }
    }
  }
  return out;
}

function heldKeys(target: CopyTarget, kind: 'movie' | 'episode'): string[] {
  const keys: string[] = [];
  for (const one of [target, target.fallback].filter(Boolean) as Array<{ ids: Record<string, any>; season?: number; episode?: number }>) {
    for (const [name, value] of Object.entries(one.ids)) {
      if (!SIMKL_KEYS.includes(name) || !value) continue;
      keys.push(kind === 'movie' ? `movie:${name}:${value}` : `${name}:${value}:${one.season ?? 1}:${one.episode}`);
    }
  }
  return keys;
}

async function writeWatches(items: CopyItem[], tokenId: string, config: any, rewatch = false): Promise<WatchOutcome> {
  const { getSimklToken, getSimklQuota, addHistoryBatch } = require('../../utils/simklUtils');
  const accessToken = (await getSimklToken(tokenId))?.access_token;
  if (!accessToken) throw new Error('No Simkl token');
  const quota = await getSimklQuota(accessToken).catch(() => null);
  if (quota && quota.remaining <= Math.max(25, quota.limit / 5)) return { done: 0, sent: 0, failed: 0, wait: quota.resetsAt - Date.now(), error: 'Waiting for the Simkl allowance to reset' };
  const { writes, from, lost } = await targetsFor(simkl, items, config);
  const failed = lost.length;
  if (writes.length) {
    try {
      const first = await addHistoryBatch(writes.map(({ fallback, ...write }) => write), accessToken, rewatch);
      const kindOf = (write: any) => write.season == null && write.episode == null;
      // A film and a show can carry the same ids, so a miss stands only for writes of its own kind.
      const ownKind = (entry: SimklMissed, write: any) => entry.movie === null || entry.movie === kindOf(write);
      const exactly = (write: any) => first.missed.some((entry: SimklMissed) => ownKind(entry, write) && JSON.stringify(entry.ids) === JSON.stringify(write.ids));
      const firstMissed = (write: any) => exactly(write) || first.missed.some((entry: SimklMissed) => ownKind(entry, write) && sharesId(entry.ids, write.ids));
      const retry = writes.filter((write) => write.fallback && exactly(write));
      if (!retry.length) {
        for (const [w, write] of writes.entries()) if (firstMissed(write)) lost.push(from[w]);
        return { done: items.length, sent: writes.length - first.notFound, failed: failed + first.notFound, lost };
      }
      const second = await addHistoryBatch(retry.map((write) => ({ ...write.fallback, watchedAt: write.watchedAt })), accessToken, rewatch);
      const recovered = retry.length - second.notFound;
      for (const [w, write] of writes.entries()) {
        if (firstMissed(write) && (!write.fallback || second.missed.some((entry: SimklMissed) => (entry.movie === null || entry.movie === kindOf(write.fallback)) && sharesId(entry.ids, write.fallback.ids)))) lost.push(from[w]);
      }
      return { done: items.length, sent: writes.length - first.notFound + recovered, failed: failed + first.notFound - recovered, lost };
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
  return { done: items.length, sent: 0, failed, lost };
}

const poster = (path: unknown): string | null => (path ? `https://wsrv.nl/?url=https://simkl.in/posters/${path}_m.webp&q=90` : null);

async function token(credential: string): Promise<string | null> {
  const { getSimklToken } = require('../../utils/simklUtils');
  return (await getSimklToken(credential).catch(() => null))?.access_token ?? null;
}

async function redate({ config, ids, mediaType, season, episode, change, fallback }: Redate): Promise<void> {
  if (mediaType === 'movie' || season == null || episode == null || change.latest == null) return;
  const simklUtils = require('../../utils/simklUtils');
  const tokenId = config.apiKeys?.simklTokenId;
  const access = tokenId ? (await simklUtils.getSimklToken(tokenId))?.access_token : null;
  if (!access) return;
  let target = { ids, season, episode };
  let held = await simklUtils.episodeWatchedAt(ids, access, season, episode);
  const status = require('../../utils/trackerCalls').lastTrackerCall()?.status ?? 200;
  if (!held && fallback && status >= 200 && status < 300) {
    const again = await simklUtils.episodeWatchedAt(fallback.ids, access, fallback.season, fallback.episode);
    if (again) {
      target = fallback;
      held = again;
    }
  }
  if (held === undefined) return nothingToMove('https://api.simkl.com/sync/watched', 'not found on Simkl');
  const heldAt = playTime(held);
  if (heldAt !== null && Math.abs(heldAt - change.latest) < SAME_PLAY_MS) return;
  if (held !== null && !(await simklUtils.removeFromHistory(target.ids, access, target.season, target.episode))) return;
  await simklUtils.addToHistory(target.ids, access, target.season, target.episode, undefined, new Date(change.latest).toISOString());
}

export const simkl: Tracker = {
  id: 'simkl',
  name: 'Simkl',
  color: '#0d0d0f',
  account: { key: 'simklTokenId', master: 'simklWatchTracking', fields: ['simklUser'] },
  ownList: (id) => /^simkl\.(watchlist\..+|upnext(\.anime)?)$/.test(id),
  resumeRank: 2,
  animeOnly: false,
  rewatch: {
    separate: true,
    async kept(credential) {
      const { getSimklToken, simklKeepsRewatches } = require('../../utils/simklUtils');
      const access = (await getSimklToken(credential).catch(() => null))?.access_token;
      return access ? simklKeepsRewatches(access) : false;
    },
  },
  datedHistory: true,
  wholeRatings: true,
  marks: { from: MARK_KINDS, to: MARK_KINDS },
  notes: {
    watchlist: 'Titles anywhere in your Simkl library are skipped too.',
    redate: 'Simkl keeps its own date for movies, since changing it there clears your rating.',
  },
  async readMarks(what, side) {
    const out: Array<MarkItem | null> = [];
    for (const { type, data } of await simklEntries(side.credential)) {
      if (what === 'ratings' && scoreOf(data?.user_rating)) out.push(simklItem(type, data, { rating: scoreOf(data.user_rating), at: dateOf(data.user_rated_at) }));
      if (what === 'watchlist' && data?.status === 'plantowatch') out.push(simklItem(type, data, { at: dateOf(data.added_to_watchlist_at) }));
      if (what === 'dropped' && data?.status === 'dropped') out.push(simklItem(type, data, { at: dateOf(data.last_watched_at) }));
    }
    return out.filter((entry): entry is MarkItem => Boolean(entry));
  },
  async heldMarks(what, side) {
    return what === 'watchlist' ? library(side.credential) : keysOf(await simkl.readMarks!(what, side));
  },
  async markContext(what, side) {
    return what === 'ratings' ? library(side.credential) : null;
  },
  refuseMark(what, entry, context) {
    if (what === 'ratings' && (entry.kind === 'season' || entry.kind === 'episode')) return 'not rated there';
    if (what === 'ratings' && !markKeys(entry).some((key) => (context as Set<string> | null)?.has(key))) return 'not in library';
    return null;
  },
  writeMarks: (what, items, side) => writeMarks(what, items, side.credential),
  watchesHeld: { read: watchesHeld, keys: heldKeys },
  writeWatches: { url: 'https://api.simkl.com/sync/history', write: writeWatches },
  redate: { scope: 'episodes', run: redate },
  match: {
    async search(credential, query, kind) {
      const { fetchSimklSearchItems } = require('../../utils/simklUtils');
      const access = await token(credential);
      const types: Array<'movie' | 'tv' | 'anime'> = kind === 'movie' ? ['movie', 'anime'] : ['tv', 'anime'];
      const found = (await Promise.all(types.map((type) => fetchSimklSearchItems(type, query, 10, 1, access).catch(() => [])))).flat();
      return found
        .filter((item: any) => item?.ids?.simkl_id ?? item?.ids?.simkl)
        .map((item: any): MatchCandidate => ({
          ids: { simkl: Number(item.ids.simkl_id ?? item.ids.simkl), ...(item.ids.tmdb ? { tmdb: Number(item.ids.tmdb) } : {}) },
          title: String(item.title_en || item.title || ''),
          year: Number(item.year) || null,
          posterUrl: poster(item.poster),
          kind: item.endpoint_type === 'anime' ? 'anime' : item.endpoint_type === 'movies' ? 'movie' : 'tv',
          episodes: Number(item.ep_count) || null,
        }));
    },
    async detail(credential, candidate) {
      const { fetchSimklItemDetail, makeAuthenticatedSimklRequest } = require('../../utils/simklUtils');
      const access = await token(credential);
      const id = Number(candidate.ids.simkl);
      const segment = candidate.kind === 'anime' ? 'anime' : candidate.kind === 'movie' ? 'movie' : 'tv';
      const detail = await fetchSimklItemDetail(segment, id, access).catch(() => null);
      const ids: Record<string, string | number> = { simkl: id };
      if (detail?.ids?.imdb) ids.imdb = String(detail.ids.imdb);
      if (detail?.ids?.tvdb) ids.tvdb = Number(detail.ids.tvdb);
      if (detail?.ids?.tmdb ?? candidate.ids.tmdb) ids.tmdb = Number(detail?.ids?.tmdb ?? candidate.ids.tmdb);
      if (candidate.kind === 'movie') return { ids, seasons: [] };
      const response = await makeAuthenticatedSimklRequest(`https://api.simkl.com/${segment === 'anime' ? 'anime' : 'tv'}/episodes/${id}`, access, `Simkl episodes (${id})`, 'GET', undefined, 15000);
      if (!response) throw new Error('Simkl did not list the episodes');
      const seasons = new Map<number, TargetSeason>();
      for (const entry of Array.isArray(response?.data) ? response.data : []) {
        if (entry?.type !== 'episode' || !Number.isFinite(Number(entry.episode))) continue;
        const number = segment === 'anime' ? 1 : Number(entry.season);
        if (!Number.isFinite(number)) continue;
        const season = seasons.get(number) ?? { number, episodes: [] };
        season.episodes.push({ number: Number(entry.episode), title: entry.title ? String(entry.title) : null, airedAt: Date.parse(entry.date ?? '') || null });
        seasons.set(number, season);
      }
      return { ids, seasons: [...seasons.values()].sort((a, b) => a.number - b.number) };
    },
  },
};
