import { envInt } from '../../utils/envNumber';
import { MARK_KINDS, type Mark, type Tracker } from './types';
import { TITLE_KEYS, cleanIds, dateOf, iso, markItem, mirrored, notFoundCount, scoreOf, titleIds, type MarkItem, type MarkOutcome } from './marks';

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

async function writeMarks(what: Mark, items: MarkItem[], apiKey: string): Promise<MarkOutcome> {
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

export const mdblist: Tracker = {
  id: 'mdblist',
  name: 'MDBList',
  color: '#4a86d0',
  animeOnly: false,
  marks: { from: MARK_KINDS, to: MARK_KINDS },
  async readMarks(what, side) {
    const out: Array<MarkItem | null> = [];
    if (what === 'ratings') {
      const rated = await mdblistPages(side.credential, '/sync/ratings', 'MDBList ratings', ['movies', 'shows', 'seasons', 'episodes']);
      const extra = (row: any) => ({ rating: scoreOf(row?.rating_precise ?? row?.rating), at: dateOf(row?.rated_at) });
      for (const row of rated.movies) out.push(markItem('movie', cleanIds(row?.movie?.ids), extra(row)));
      for (const row of rated.shows) out.push(markItem('series', cleanIds(row?.show?.ids), extra(row)));
      for (const row of rated.seasons) {
        const season = Number(row?.season?.number ?? row?.season?.season);
        if (Number.isFinite(season)) out.push(markItem('season', cleanIds((row?.season?.show ?? row?.show)?.ids), { ...extra(row), season }));
      }
      for (const row of rated.episodes) {
        const season = Number(row?.episode?.season);
        const episode = Number(row?.episode?.number);
        if (Number.isFinite(season) && Number.isFinite(episode)) out.push(markItem('episode', cleanIds((row?.episode?.show ?? row?.show)?.ids), { ...extra(row), season, episode }));
      }
    } else if (what === 'watchlist') {
      const listed = await mdblistPages(side.credential, '/watchlist/items', 'MDBList watchlist', ['movies', 'shows']);
      for (const [array, kind] of [['movies', 'movie'], ['shows', 'series']] as const) {
        for (const row of listed[array]) out.push(markItem(kind, cleanIds({ imdb: row?.imdb_id, tmdb: row?.id, tvdb: row?.tvdb_id, ...row?.ids }), { at: dateOf(row?.watchlist_at ?? row?.added_at) }));
      }
    } else {
      const dropped = await mirrored('mdblist', side.credential, 'dropped');
      for (const row of Array.isArray(dropped?.shows) ? dropped.shows : []) out.push(markItem('series', cleanIds(row?.show?.ids), { at: dateOf(row?.dropped_at) }));
    }
    return out.filter((entry): entry is MarkItem => Boolean(entry));
  },
  refuseMark(what, entry) {
    if (what === 'ratings' && entry.later) return 'one season';
    return TITLE_KEYS.some((key) => entry.ids[key]) ? null : 'no id';
  },
  writeMarks: (what, items, side) => writeMarks(what, items, side.credential),
};
