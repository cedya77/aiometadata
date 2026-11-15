import { isAnimeId } from './stremioLibrary';

export const NUVIO_FORMAT = 'nuvio-library';

export const USABLE_VIDEO = /^(tt\d+|(tmdb|tvdb|kitsu|mal|anilist|anidb):\d+)(:\d+)*$/;

export type NuvioKind = 'movie' | 'series';
export type NuvioLibraryRow = { contentId: string; kind: NuvioKind; name: string; addedAt: number | null };
export type NuvioWatchedRow = { contentId: string; kind: NuvioKind; title: string; season: number | null; episode: number | null; watchedAt: number | null };
export type NuvioProgressRow = {
  contentId: string;
  kind: NuvioKind;
  videoId: string | null;
  season: number | null;
  episode: number | null;
  positionMs: number;
  durationMs: number;
  lastWatched: number | null;
};
export type NuvioProfile = { key: string; name: string; library: NuvioLibraryRow[]; watched: NuvioWatchedRow[]; progress: NuvioProgressRow[] };
export type EpisodeRef = { id: string; season: number | null; episode: number | null };

const USABLE_ID = /^(tt\d+|(tmdb|tvdb|kitsu|mal|anilist|anidb):\d+)$/;
const SEASONED_ID = /^(tt\d+|(tmdb|tvdb):\d+)$/;
const CREDITS_SHARE = 0.9;

export const isNuvioLibrary = (json: unknown): boolean =>
  Boolean(json) && typeof json === 'object' && (json as any).format === NUVIO_FORMAT && Array.isArray((json as any).profiles);

const numberOf = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const label = (value: unknown, fallback: string): string => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : fallback);

function titleOf(row: any): { contentId: string; kind: NuvioKind } | null {
  if (!row || typeof row !== 'object' || typeof row.content_id !== 'string' || !USABLE_ID.test(row.content_id)) return null;
  if (row.content_type !== 'movie' && row.content_type !== 'series') return null;
  return { contentId: row.content_id, kind: row.content_type };
}

const rowsOf = <T>(rows: unknown, read: (row: any) => T | null): T[] =>
  (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const found = read(row);
    return found ? [found] : [];
  });

function libraryRow(row: any): NuvioLibraryRow | null {
  const title = titleOf(row);
  return title ? { ...title, name: label(row.name, title.contentId), addedAt: numberOf(row.added_at) } : null;
}

function watchedRow(row: any): NuvioWatchedRow | null {
  const title = titleOf(row);
  if (!title) return null;
  return { ...title, title: label(row.title, title.contentId), season: numberOf(row.season), episode: numberOf(row.episode), watchedAt: numberOf(row.watched_at) };
}

function progressRow(row: any): NuvioProgressRow | null {
  const title = titleOf(row);
  if (!title) return null;
  return {
    ...title,
    videoId: typeof row.video_id === 'string' && row.video_id ? row.video_id : null,
    season: numberOf(row.season),
    episode: numberOf(row.episode),
    positionMs: numberOf(row.position) ?? 0,
    durationMs: numberOf(row.duration) ?? 0,
    lastWatched: numberOf(row.last_watched),
  };
}

export function readNuvioLibrary(json: unknown): NuvioProfile[] {
  if (!isNuvioLibrary(json)) return [];
  return ((json as any).profiles as unknown[]).flatMap((profile: any) => {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return [];
    return [{
      key: typeof profile.key === 'string' ? profile.key : '',
      name: label(profile.name, 'Nuvio'),
      library: rowsOf(profile.library, libraryRow),
      watched: rowsOf(profile.watched, watchedRow),
      progress: rowsOf(profile.progress, progressRow),
    }];
  });
}

export function episodeRefs(videos: unknown): EpisodeRef[] {
  return (Array.isArray(videos) ? videos : [])
    .filter((video: any) => video && typeof video.id === 'string')
    .map((video: any) => ({ id: video.id, season: numberOf(video.season), episode: numberOf(video.episode ?? video.number) }));
}

export function fallbackEpisodeId(contentId: string, season: number | null, episode: number | null): string | null {
  if (episode === null) return null;
  if (isAnimeId(contentId)) return season === null || season === 1 ? `${contentId}:${episode}` : null;
  if (SEASONED_ID.test(contentId)) return season === null ? null : `${contentId}:${season}:${episode}`;
  return null;
}

export function placeEpisode(contentId: string, season: number | null, episode: number | null, list: EpisodeRef[] | null): string | null {
  if (episode === null) return null;
  if (isAnimeId(contentId) && (season === null || season === 1)) {
    const own = `${contentId}:${episode}`;
    if (list?.some((ref) => ref.id === own)) return own;
  }
  const found = list?.find((ref) => ref.season === season && ref.episode === episode);
  return found ? found.id : fallbackEpisodeId(contentId, season, episode);
}

export function resumeOfProgress(row: NuvioProgressRow): { positionMs: number; runtimeMs: number } | null {
  return row.durationMs > 0 && row.positionMs > 1 && row.positionMs < CREDITS_SHARE * row.durationMs ? { positionMs: row.positionMs, runtimeMs: row.durationMs } : null;
}
