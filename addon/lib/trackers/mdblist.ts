import { envInt } from '../../utils/envNumber';
import { MARK_KINDS, type Mark, type Tracker } from './types';
import { TITLE_KEYS, cleanIds, dateOf, iso, markItem, mirrored, notFoundCount, scoreOf, titleIds, type MarkItem, type MarkOutcome } from './marks';
import { sharesId, targetsFor, type CopyItem, type TmdbWatch, type WatchOutcome } from './watches';
import { tmdbSeasons, type MatchCandidate, type TargetSeason } from './match';
import { SAME_PLAY_MS, nearestPlay, nothingToMove, type Redate } from './redate';

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

function missed(write: any, missing: any): boolean {
  const list = (key: string): any[] => (Array.isArray(missing?.[key]) ? missing[key] : []);
  if (write.episodeIds) return list('episodes').some((entry) => sharesId(entry?.ids, write.episodeIds));
  if (write.season == null || write.episode == null) return list('movies').some((entry) => sharesId(entry?.ids, write.ids));
  if (list('shows').some((entry) => sharesId(entry?.ids, write.ids))) return true;
  return list('episodes').some((entry) => Number(entry?.season) === Number(write.season) && Number(entry?.number) === Number(write.episode) && sharesId(entry?.show?.ids, write.ids));
}

async function writeWatches(items: CopyItem[], apiKey: string, config: any): Promise<WatchOutcome> {
  const { mdblistCallsLeft, addHistoryBatch } = require('../../utils/mdbList');
  const { remaining, limit, resetAt } = mdblistCallsLeft(apiKey);
  if (remaining !== null && remaining <= Math.max(50, (limit ?? 0) / 5)) return { done: 0, sent: 0, failed: 0, wait: resetAt - Date.now(), error: 'Waiting for the MDBList quota to reset' };
  const { writes, from, lost } = await targetsFor(mdblist, items, config);
  if (!writes.length) return { done: items.length, sent: 0, failed: lost.length, lost };
  const unresolved = lost.length;
  try {
    const { missed: missing } = await addHistoryBatch(writes, apiKey);
    for (const [w, write] of writes.entries()) if (missed(write, missing)) lost.push(from[w]);
    // A show MDBList did not find is one entry for every episode written under it.
    return { done: items.length, sent: writes.length - (lost.length - unresolved), failed: lost.length, lost };
  } catch (error: any) {
    if (error?.code === 'MDBLIST_QUOTA_EXHAUSTED' || error?.response?.status === 429) return { done: 0, sent: 0, failed: 0, wait: mdblistCallsLeft(apiKey).resetAt - Date.now(), error: 'MDBList quota spent' };
    throw error;
  }
}

async function redate({ config, ids, mediaType, season, episode, change, within }: Redate): Promise<void> {
  const apiKey = config.apiKeys?.mdblist;
  const tmdbId = Number(ids.tmdb);
  if (!apiKey || !tmdbId) return nothingToMove('https://api.mdblist.com/sync/history', 'no TMDB id for the title');
  const api = require('../../utils/mdbList');
  const all = await api.historyPlays(mediaType === 'movie' ? 'movie' : 'show', tmdbId, apiKey);
  if (!all) return;
  const plays = mediaType === 'movie' ? all : all.filter((play: any) => play.season_num === season && play.episode_num === episode);
  // The viewing being moved is found first, so a destination near it can never stand in for it.
  const old = nearestPlay(plays, change.from, (play: any) => play.watched_at, within);
  const placed = nearestPlay(plays.filter((play: any) => play !== old), change.to, (play: any) => play.watched_at, SAME_PLAY_MS);
  const { lastTrackerCall, noteTrackerCall } = require('../../utils/trackerCalls');
  if (!old) {
    if (!placed && Date.now() - change.from < 15 * 60 * 1000) {
      noteTrackerCall('https://api.mdblist.com/sync/history', 429, 'play not recorded yet', null, Date.now() + 60_000);
    } else if (!placed) {
      nothingToMove('https://api.mdblist.com/sync/history', 'no play near the old date');
    }
    return;
  }
  if (placed && !change.apart) {
    await api.removePlays([old.play_id], apiKey);
    return;
  }
  if (!(await api.removePlays([old.play_id], apiKey))) return;
  if (await api.addToHistory(ids, apiKey, season, episode, undefined, new Date(change.to).toISOString())) return;
  const failed = lastTrackerCall();
  await api.addToHistory(ids, apiKey, season, episode, undefined, old.watched_at);
  noteTrackerCall('https://api.mdblist.com/sync/watched', failed && failed.status >= 300 ? failed.status : 0, failed?.body, null, failed?.retryAt);
}

export const mdblist: Tracker = {
  id: 'mdblist',
  name: 'MDBList',
  color: '#4a86d0',
  account: { key: 'mdblist', master: 'mdblistWatchTracking' },
  ownList: (id) => /^mdblist\.(watchlist(\.(movies|series))?|upnext|recommended\..+)$/.test(id),
  resumeRank: 1,
  animeOnly: false,
  rewatch: { separate: false },
  datedHistory: true,
  wholeRatings: false,
  marks: { from: MARK_KINDS, to: MARK_KINDS },
  batchGapMs: 1000,
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
  tmdbWatches(rows) {
    const out: TmdbWatch[] = [];
    for (const { key, data } of rows) {
      if (key.startsWith('movie:')) {
        const ids = data?.movie?.ids ?? {};
        out.push({ kind: 'movie', tmdb: Number(ids.tmdb), imdb: ids.imdb ?? null, showTvdb: null, season: null, episode: null, tvdb: null, at: dateOf(data?.last_watched_at) });
      } else if (key.startsWith('ep:')) {
        const show = data?.episode?.show?.ids ?? {};
        out.push({ kind: 'episode', tmdb: Number(show.tmdb), imdb: show.imdb ?? null, showTvdb: show.tvdb ?? null, season: Number(data?.episode?.season), episode: Number(data?.episode?.number), tvdb: data?.episode?.tvdb_ids ?? null, at: dateOf(data?.last_watched_at) });
      }
    }
    return out;
  },
  takesEpisodeIds: true,
  writeWatches: { url: 'https://api.mdblist.com/sync/watched', write: (items, credential, config) => writeWatches(items, credential, config) },
  redate: { scope: 'all', run: redate },
  match: {
    async search(credential, query, kind) {
      const { fetchMdbListSearchItems } = require('../../utils/mdbList');
      const found: any[] = await fetchMdbListSearchItems(query, kind === 'movie' ? 'movie' : 'show', credential).catch(() => []);
      return found.map((item: any): MatchCandidate => ({
        ids: {
          ...(item.ids?.imdbid ? { imdb: String(item.ids.imdbid) } : {}),
          ...(item.ids?.tmdbid ? { tmdb: Number(item.ids.tmdbid) } : {}),
          ...(item.ids?.tvdbid ? { tvdb: Number(item.ids.tvdbid) } : {}),
        },
        title: String(item.title ?? ''),
        year: Number(item.year) || null,
        posterUrl: /^tt\d+$/.test(String(item.ids?.imdbid ?? '')) ? `https://images.metahub.space/poster/small/${item.ids.imdbid}/img` : null,
        kind: item.type === 'movie' ? 'movie' : 'tv',
        episodes: null,
      })).filter((item) => Object.keys(item.ids).length > 0);
    },
    async detail(credential, candidate, config) {
      const ids = { ...candidate.ids };
      if (candidate.kind === 'movie' || !ids.tmdb) return { ids, seasons: [] };
      const { mdblistTvdbEpisodes } = require('../../utils/mdbList');
      const [seasons, map] = await Promise.all([
        tmdbSeasons(Number(ids.tmdb), config),
        credential ? mdblistTvdbEpisodes(Number(ids.tmdb), credential).catch(() => null) : null,
      ]);
      if (!map) return { ids, seasons };
      const known = new Map(seasons.flatMap((season) => season.episodes.map((episode) => [`${season.number}:${episode.number}`, episode] as const)));
      const tvdb = new Map<number, TargetSeason>();
      for (const entry of map.episodes) {
        if (entry.showTmdb) continue;
        const episode = known.get(`${entry.tmdbSeason}:${entry.tmdbEpisode}`);
        if (!episode) continue;
        const season = tvdb.get(entry.season) ?? { number: entry.season, episodes: [] };
        if (season.episodes.some((listed) => listed.number === entry.episode)) continue;
        season.episodes.push({ number: entry.episode, title: episode.title, airedAt: episode.airedAt, sends: { season: entry.tmdbSeason, episode: entry.tmdbEpisode } });
        tvdb.set(entry.season, season);
      }
      for (const season of tvdb.values()) season.episodes.sort((a, b) => a.number - b.number);
      const tvdbSeasons = [...tvdb.values()].sort((a, b) => (a.number === 0 ? 1 : b.number === 0 ? -1 : a.number - b.number));
      return tvdbSeasons.length ? { ids, seasons, tvdbSeasons, tvdbDefault: map.tvdbDefault } : { ids, seasons };
    },
  },
};
