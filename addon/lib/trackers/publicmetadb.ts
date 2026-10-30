import { envInt } from '../../utils/envNumber';
import { MARK_KINDS, type Tracker } from './types';
import { dateOf, markItem, mirrored, ratingKeys, type MarkItem, type MarkSide } from './marks';

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

export const publicmetadb: Tracker = {
  id: 'publicmetadb',
  name: 'PublicMetaDB',
  color: '#ebebeb',
  animeOnly: false,
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
};
