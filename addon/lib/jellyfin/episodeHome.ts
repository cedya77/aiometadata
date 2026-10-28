import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { perEntryAnime } from './watchlistSources';

const idMapper: any = require('../id-mapper');

const ENTRY_ID = /^(kitsu|mal|anilist|anidb):/;
const ENTRY_BASE = /^(kitsu|mal|anilist|anidb):\d+$/;

export interface EpisodeHome {
  metaId: string;
  videoId: string;
  mediaType: 'anime' | 'series';
  season: number | null;
  episode: number;
}

const homes = new LRUCache<string, Promise<string | null>>({
  max: envInt('JELLYFIN_RESUME_CACHE_MAX', 500, 1),
  ttl: envInt('JELLYFIN_RESUME_TTL', 60, 1) * 1000,
});

function entryMapping(base: string): any {
  const [kind, raw] = base.split(':');
  const id = parseInt(raw, 10);
  if (!Number.isFinite(id)) return null;
  if (kind === 'kitsu') return idMapper.getMappingByKitsuId(id);
  if (kind === 'mal') return idMapper.getMappingByMalId(id);
  if (kind === 'anilist') return idMapper.getMappingByAnilistId(id);
  if (kind === 'anidb') return idMapper.getMappingByAnidbId(id);
  return null;
}

function showSpellings(base: string, mapping: any): string[] {
  const spellings = [
    base,
    mapping?.imdb_id ? String(mapping.imdb_id) : null,
    mapping?.tvdb_id ? `tvdb:${mapping.tvdb_id}` : null,
    mapping?.themoviedb_id && mapping?.themoviedb_type !== 'movie' ? `tmdb:${mapping.themoviedb_id}` : null,
    mapping?.kitsu_id ? `kitsu:${mapping.kitsu_id}` : null,
    mapping?.mal_id ? `mal:${mapping.mal_id}` : null,
    mapping?.anilist_id ? `anilist:${mapping.anilist_id}` : null,
    mapping?.anidb_id ? `anidb:${mapping.anidb_id}` : null,
  ];
  return [...new Set(spellings.filter((spelling): spelling is string => Boolean(spelling)))];
}

export function entryHomeBase(userUUID: string, config: any, base: string): Promise<string | null> {
  if (!ENTRY_BASE.test(base)) return Promise.resolve(null);
  const { profileKey } = require('./profiles');
  const profile = profileKey(config);
  const perEntry = perEntryAnime(config);
  const key = `${userUUID}:${profile}:${perEntry ? 'entry' : 'show'}:${base}`;
  const held = homes.get(key);
  if (held) return held;
  const work = (async () => {
    const { parseStremioId } = require('./ids');
    const database: any = require('../database');
    const mapping = entryMapping(base);
    const latest: { videoId: string; at: number } | null = await database.latestOwnPlayAmong(userUUID, profile, showSpellings(base, mapping)).catch(() => null);
    if (latest) {
      const { videoIdAliases } = require('./aliases');
      const group: Map<string, any> = await database.getPlaystates(userUUID, [latest.videoId, ...(await videoIdAliases(latest.videoId))], profile).catch(() => new Map());
      const lead = [...group.values()]
        .filter((row: any) => Number(row.last_played_at) === latest.at)
        .sort((a: any, b: any) => (Number(a.updated_at) - Number(b.updated_at)) || (String(a.video_id) < String(b.video_id) ? -1 : String(a.video_id) > String(b.video_id) ? 1 : 0))[0];
      const played = parseStremioId(String(lead?.video_id ?? latest.videoId))?.base;
      if (played) return String(played);
    }
    if (perEntry) return base;
    return mapping?.imdb_id ? String(mapping.imdb_id) : base;
  })();
  homes.set(key, work);
  work.catch(() => homes.delete(key));
  return work;
}

export async function episodeHome(userUUID: string, config: any, videoId: string | null | undefined): Promise<EpisodeHome | null> {
  if (!videoId || !ENTRY_ID.test(videoId)) return null;
  const { parseStremioId } = require('./ids');
  const parsed = parseStremioId(videoId);
  if (!parsed || parsed.episode === null || parsed.episode === undefined) return null;
  const home = await entryHomeBase(userUUID, config, parsed.base);
  if (!home || home === parsed.base) return null;
  const { seriesIndex } = require('./episodeIndex');
  const page = await seriesIndex(userUUID, home).catch(() => null);
  if (!page?.videos?.length) return null;
  const { videoIdAliases } = require('./aliases');
  const wanted = new Set<string>([videoId, ...(await videoIdAliases(videoId))]);
  const video = page.videos.find((candidate: any) => wanted.has(String(candidate.id)));
  if (!video) return null;
  const placed = parseStremioId(String(video.id));
  if (!placed || placed.episode === null || placed.episode === undefined) return null;
  return {
    metaId: home,
    videoId: String(video.id),
    mediaType: ENTRY_ID.test(String(video.id)) ? 'anime' : 'series',
    season: placed.season ?? null,
    episode: Number(placed.episode),
  };
}

export async function homedRow<T extends { metaId: string; videoId?: string | null; mediaType: string }>(userUUID: string, config: any, row: T): Promise<T> {
  if (row.videoId) {
    const home = await episodeHome(userUUID, config, row.videoId);
    if (!home) return row;
    const numbered = 'season' in row || 'episode' in row ? { season: home.season, episode: home.episode } : {};
    return { ...row, metaId: home.metaId, videoId: home.videoId, mediaType: home.mediaType, ...numbered };
  }
  const base = await entryHomeBase(userUUID, config, row.metaId);
  if (!base || base === row.metaId) return row;
  return { ...row, metaId: base, mediaType: ENTRY_ID.test(base) ? 'anime' : 'series' };
}

export function homedRows<T extends { metaId: string; videoId?: string | null; mediaType: string }>(userUUID: string, config: any, rows: T[]): Promise<T[]> {
  const { mapWithConcurrency } = require('../../utils/concurrency');
  return mapWithConcurrency(rows, envInt('JELLYFIN_SHELF_META_CONCURRENCY', 4, 1), (row: T) => homedRow(userUUID, config, row));
}
