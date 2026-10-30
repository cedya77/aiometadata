import type { Mark, Tracker } from './types';
import type { MarkItem, MarkSide } from './marks';

async function listOn(side: MarkSide): Promise<Map<string, any>> {
  const { mirrorRows } = require('../jellyfin/trackerMirror');
  const out = new Map<string, any>();
  for (const { key, data } of (await mirrorRows(side.service, side.credential)) as Array<{ key: string; data: any }>) {
    if (!key.startsWith('entry:')) continue;
    if (data?.anilist) out.set(`anilist:${data.anilist}`, data);
    if (data?.mal) out.set(`mal:${data.mal}`, data);
  }
  return out;
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

const held = (what: Mark, data: any) => what === 'watchlist' || (what === 'ratings' && data?.score > 0) || (what === 'dropped' && data?.status === 'dropped');

export function animeList(id: 'anilist' | 'mal', name: string, load: () => any, resolve: (media: any) => Promise<{ id: number; episode: any } | null>): Pick<Tracker, 'heldMarks' | 'markContext' | 'prepareMark' | 'refuseMark' | 'checkSignIn' | 'animeEntry'> {
  return {
    animeEntry: resolve,
    async heldMarks(what, side) {
      const keys = new Set<string>();
      for (const [key, data] of await listOn(side)) if (held(what, data)) keys.add(key);
      return keys;
    },
    markContext: (_what, side) => listOn(side),
    prepareMark: withAnimeIds,
    refuseMark(what, entry, context) {
      if (!entry.ids[id]) return 'not anime';
      const listed = (context as Map<string, any> | null)?.get(`${id}:${entry.ids[id]}`);
      if (what === 'ratings' && (entry.kind === 'season' || entry.kind === 'episode')) return 'not rated there';
      if (what === 'ratings' && !listed) return 'not on list';
      if (what === 'dropped' && listed?.status === 'completed') return 'finished there';
      return null;
    },
    async checkSignIn(credential) {
      if (!(await load().getAccessTokenById(credential).catch(() => null))) throw new Error(`The ${name} sign-in has expired; sign in again`);
    },
  };
}

export async function animeToken(id: 'anilist' | 'mal', name: string, load: () => any, side: MarkSide, userUUID: string): Promise<string> {
  const { ownTokenId } = require('../accounts');
  const token = await load().getValidAccessToken(userUUID, ownTokenId(side.scoped, id));
  if (!token) throw new Error(`${name} token unavailable`);
  return token;
}
