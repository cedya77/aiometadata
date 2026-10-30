import { MARK_KINDS, type Mark, type Tracker } from './types';
import { cleanIds, dateOf, iso, keysOf, markItem, markKeys, notFoundCount, scoreOf, type MarkItem, type MarkOutcome } from './marks';

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

export const simkl: Tracker = {
  id: 'simkl',
  name: 'Simkl',
  color: '#0d0d0f',
  animeOnly: false,
  marks: { from: MARK_KINDS, to: MARK_KINDS },
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
};
