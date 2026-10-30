import { envInt } from '../../utils/envNumber';
import { MARK_KINDS, type Tracker } from './types';
import { dateOf, markItem, mirrored, ratingKeys, type MarkItem, type MarkSide } from './marks';
import { copyTarget, isoAt, type TmdbWatch } from './watches';
import { tmdbSeasons, type MatchCandidate } from './match';
import { SAME_PLAY_MS, nearestPlay, nothingToMove, playTime, type Redate } from './redate';

const pmdbItem = (row: any, extra: Partial<MarkItem> = {}) => {
  const tmdb = Number(row?.tmdb_id);
  return tmdb > 0 ? markItem(row?.media_type === 'movie' ? 'movie' : 'series', { tmdb }, extra) : null;
};

async function watchlistId(side: MarkSide): Promise<string | null> {
  const { publicMetaDBListId, WATCHLIST_CATALOG_ID } = require('../../utils/publicmetadbUtils');
  return publicMetaDBListId(side.scoped, WATCHLIST_CATALOG_ID).catch(() => null);
}

async function watchlist(side: MarkSide): Promise<any[]> {
  const listId = await watchlistId(side);
  if (!listId) return [];
  const { fetchListItems } = require('../../utils/publicmetadbUtils');
  const { readToEnd } = require('../../utils/readToEnd');
  return readToEnd('PublicMetaDB watchlist', async (page: number) => {
    const data = await fetchListItems(side.credential, listId, page + 1, 500);
    return { items: Array.isArray(data?.items) ? data.items : [], more: page + 1 < (Number(data?.totalPages) || 1) };
  }, (row: any) => String(row?.id ?? `${row?.media_type}:${row?.tmdb_id}`));
}

const selves = new Map<string, string>();

async function ratingsOn(side: MarkSide, kind: MarkItem['kind'], tmdb: number, season: number | null, episode: number | null): Promise<any[]> {
  const pmdb = require('../../utils/publicmetadbUtils');
  return kind === 'episode'
    ? pmdb.fetchEpisodeRatings(side.credential, tmdb, Number(season), Number(episode))
    : pmdb.fetchTitleRatings(side.credential, tmdb, kind === 'movie' ? 'movie' : 'tv');
}

async function self(side: MarkSide, userUUID: string): Promise<string | null> {
  const held = selves.get(side.credential);
  if (held) return held;
  const database: any = require('../database');
  for (const row of await database.listRemoteRatings(userUUID, 5).catch(() => [])) {
    const parts = String(row.meta_id).split(':').map(Number);
    const kind = parts.length === 4 ? 'episode' : row.meta_type === 'movie' ? 'movie' : parts.length === 2 ? 'series' : null;
    if (!kind) continue;
    const own = (await ratingsOn(side, kind, parts[1], parts[2] ?? null, parts[3] ?? null).catch(() => [])).find((rating: any) => String(rating?.id) === String(row.pmdb_id));
    if (own?.contributor) {
      selves.set(side.credential, String(own.contributor));
      return String(own.contributor);
    }
  }
  return null;
}

async function redate({ config, ids, mediaType, season, episode, change, within }: Redate): Promise<void> {
  const apiKey = config.apiKeys?.publicmetadb;
  if (!apiKey) return;
  const { tmdbIdFrom, fetchWatched, setWatchedDate, removePlay } = require('../../utils/publicmetadbUtils');
  const tmdbId = await tmdbIdFrom(ids, mediaType);
  if (!tmdbId) return nothingToMove('https://publicmetadb.com/api/watched', 'no TMDB id for the title');
  const kind = mediaType === 'movie' ? 'movie' : 'tv';
  const isTitle = (play: any) => Number(play?.tmdb_id) === Number(tmdbId) && play?.media_type === kind
    && (kind === 'movie' || (Number(play.season) === season && Number(play.episode) === episode));
  const { sourceKeyFor } = require('../jellyfin/trackerMirror');
  const database: any = require('../database');
  const mirrorKey = sourceKeyFor('publicmetadb', apiKey);
  const group = `${kind}:${tmdbId}`;

  let plays: any[] = ((await database.listTrackerMirrorGroup(mirrorKey, group).catch(() => [])) as any[])
    .map((row) => { try { return JSON.parse(row.data); } catch { return null; } })
    .filter(isTitle);
  if (!nearestPlay(plays, change.from, (play) => play.watched_at, within)) {
    plays = [];
    const read = new Set<string>();
    for (let page = 1; ; page += 1) {
      const result = await fetchWatched(apiKey, page, 500);
      const first = String(result.items[0]?.id ?? '');
      if (first && read.has(first)) break;
      read.add(first);
      plays.push(...result.items.filter(isTitle));
      const oldest = playTime(result.items[result.items.length - 1]?.watched_at);
      if (page >= result.totalPages || !result.items.length || (oldest !== null && oldest < change.from - within)) break;
    }
  }
  // The viewing being moved is found first, so a destination near it can never stand in for it.
  const old = nearestPlay(plays, change.from, (play) => play.watched_at, within);
  if (!old?.id) return nothingToMove('https://publicmetadb.com/api/watched', 'no play near the old date');
  const placed = nearestPlay(plays.filter((play) => play !== old), change.to, (play) => play.watched_at, SAME_PLAY_MS);
  if (placed && !change.apart) {
    await removePlay(apiKey, String(old.id));
    await database.deleteTrackerMirror(mirrorKey, [`play:${old.id}`]).catch(() => undefined);
    await database.bumpTrackerSyncVersion(mirrorKey).catch(() => undefined);
    return;
  }
  const answer = await setWatchedDate(apiKey, String(old.id), new Date(change.to).toISOString());
  const moved = answer?.item ?? { ...old, watched_at: new Date(change.to).toISOString() };
  await database.upsertTrackerMirror(mirrorKey, [{ key: `play:${old.id}`, group, data: moved }]).catch(() => undefined);
  // An older play can move without changing what a read compares, so the watched state is rebuilt here.
  await database.bumpTrackerSyncVersion(mirrorKey).catch(() => undefined);
}

export const publicmetadb: Tracker = {
  id: 'publicmetadb',
  name: 'PublicMetaDB',
  color: '#ebebeb',
  account: { key: 'publicmetadb', master: 'publicmetadbWatchTracking', fields: ['publicmetadbWatchlist'] },
  ownList: (id, catalog) => {
    if (id.startsWith('publicmetadb.pick.')) return typeof catalog.metadata?.accountOwner === 'string' && catalog.metadata.accountOwner !== '';
    if (id.startsWith('publicmetadb.list.')) return catalog.metadata?.listType === 'watchlist';
    return /^publicmetadb\.(upnext|watchlist)$/.test(id);
  },
  resumeRank: 3,
  animeOnly: false,
  datedHistory: true,
  wholeRatings: false,
  marks: { from: ['watchlist', 'dropped'], to: MARK_KINDS },
  batch: 10,
  markBatch: { ratings: 1 },
  pace: () => ({ perSecond: envInt('JELLYFIN_COPY_PMDB_PER_SECOND', 4, 1), ratingsPerHour: envInt('JELLYFIN_COPY_PMDB_RATINGS_PER_HOUR', 200, 1) }),
  async readMarks(what, side) {
    const out: Array<MarkItem | null> = [];
    if (what === 'watchlist') for (const row of await watchlist(side)) out.push(pmdbItem(row, { at: dateOf(row?.created) }));
    if (what === 'dropped') {
      const dropped = await mirrored('publicmetadb', side.credential, 'dropped');
      for (const row of Array.isArray(dropped?.items) ? dropped.items : []) out.push(pmdbItem(row, { at: dateOf(row?.created) }));
    }
    return out.filter((entry): entry is MarkItem => Boolean(entry));
  },
  refuseMark(what, entry) {
    if (what === 'ratings' && entry.later) return 'one season';
    if (entry.kind === 'season') return 'not rated there';
    return entry.ids.tmdb || entry.ids.imdb ? null : 'no id';
  },
  async writeMark(what, entry, side, userUUID) {
    const pmdb = require('../../utils/publicmetadbUtils');
    const tmdb = entry.ids.tmdb ?? await pmdb.tmdbIdFrom(entry.ids, entry.kind === 'movie' ? 'movie' : 'series').catch(() => null);
    if (!tmdb) return 'failed';
    const type = entry.kind === 'movie' ? 'movie' : 'tv';
    if (what === 'ratings') {
      const me = await self(side, userUUID);
      const before = await ratingsOn(side, entry.kind, Number(tmdb), entry.season, entry.episode);
      if (me && before.some((rating: any) => rating?.contributor === me)) return 'skipped';
      const score = Math.round((entry.rating ?? 0) * 10);
      const id = entry.kind === 'episode'
        ? await pmdb.createEpisodeRating(side.credential, Number(tmdb), Number(entry.season), Number(entry.episode), score)
        : await pmdb.createRating(side.credential, Number(tmdb), type, score);
      if (id && !me) {
        const own = (await ratingsOn(side, entry.kind, Number(tmdb), entry.season, entry.episode).catch(() => [])).find((rating: any) => String(rating?.id) === String(id));
        if (own?.contributor) selves.set(side.credential, String(own.contributor));
      }
      if (!id) return 'failed';
      const keys = entry.kind === 'movie' || entry.kind === 'series' ? ratingKeys(entry) : [];
      const { profileKey } = require('../jellyfin/profiles');
      if (keys.length && !(await require('../database').setRatingRemoteId(userUUID, profileKey(side.scoped), keys, id, entry.kind === 'movie' ? 'movie' : 'series'))) {
        await pmdb.deleteRating(side.credential, id);
        return 'skipped';
      }
      return 'sent';
    }
    if (what === 'dropped') {
      await pmdb.setDropped(side.credential, tmdb, true);
      return 'sent';
    }
    const listId = await watchlistId(side);
    if (!listId) return 'failed';
    await pmdb.setListItem(side.credential, listId, tmdb, type, true);
    return 'sent';
  },
  tmdbWatches(rows) {
    const out: TmdbWatch[] = [];
    for (const { key, data } of rows) {
      if (!key.startsWith('play:')) continue;
      const kind = data?.media_type === 'movie' ? 'movie' : 'episode';
      out.push({ kind, tmdb: Number(data?.tmdb_id), imdb: null, showTvdb: null, season: kind === 'movie' ? null : Number(data?.season), episode: kind === 'movie' ? null : Number(data?.episode), tvdb: null, at: dateOf(data?.watched_at) });
    }
    return out;
  },
  async writeWatch(item, credential, config) {
    const { markWatched } = require('../../utils/publicmetadbUtils');
    const target = await copyTarget(publicmetadb, item, config);
    if (!target) return false;
    const answer = await markWatched(credential, target.ids.tmdb, item.kind === 'movie' ? 'movie' : 'tv', target.season, target.episode, isoAt(item.at));
    const created = Date.parse(String(answer?.item?.created ?? '').replace(' ', 'T'));
    return Number.isFinite(created) && Date.now() - created > 60_000;
  },
  redate: { scope: 'all', run: redate },
  match: {
    async search(_credential, query, kind, config) {
      const { searchMovie, searchTv } = require('../getTmdb');
      const found = await (kind === 'movie' ? searchMovie : searchTv)({ query, language: 'en-US' }, config).catch(() => null);
      return (Array.isArray(found?.results) ? found.results : [])
        .filter((item: any) => Number(item?.id) > 0)
        .slice(0, 20)
        .map((item: any): MatchCandidate => ({
          ids: { tmdb: Number(item.id) },
          title: String(item.title ?? item.name ?? ''),
          year: Number(String(item.release_date ?? item.first_air_date ?? '').slice(0, 4)) || null,
          posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w185${item.poster_path}` : null,
          kind: kind === 'movie' ? 'movie' : 'tv',
          episodes: null,
        }));
    },
    async detail(_credential, candidate, config) {
      const ids = { ...candidate.ids };
      if (!ids.tmdb) return { ids, seasons: [] };
      const { movieExternalIds, tvExternalIds } = require('../getTmdb');
      const movie = candidate.kind === 'movie';
      const [external, seasons] = await Promise.all([
        (movie ? movieExternalIds : tvExternalIds)(String(ids.tmdb), config).catch(() => null),
        movie ? [] : tmdbSeasons(Number(ids.tmdb), config),
      ]);
      if (/^tt\d+$/.test(String(external?.imdb_id ?? ''))) ids.imdb = String(external.imdb_id);
      if (Number(external?.tvdb_id) > 0) ids.tvdb = Number(external.tvdb_id);
      return { ids, seasons };
    },
    async spellings(ids, kind) {
      if (!ids.tmdb || ids.imdb) return [];
      const { movieExternalIds, tvExternalIds } = require('../getTmdb');
      const external = await (kind === 'movie' ? movieExternalIds : tvExternalIds)(String(ids.tmdb), {}).catch(() => null);
      const out: string[] = [];
      if (/^tt\d+$/.test(String(external?.imdb_id ?? ''))) out.push(String(external.imdb_id));
      if (!ids.tvdb && Number(external?.tvdb_id) > 0) out.push(`tvdb:${Number(external.tvdb_id)}`);
      return out;
    },
  },
};
