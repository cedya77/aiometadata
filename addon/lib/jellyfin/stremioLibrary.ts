// A Stremio library as the dashboard sends it: each profile's `datastoreGet` records, verbatim. A saved
// `datastoreGet` result (an array, or `{ result }`) reads as one profile.

export const STREMIO_FORMAT = 'stremio-library';

export type StremioState = {
  lastWatched: number | null;
  videoId: string | null;
  timeOffset: number;
  duration: number;
  overallTimeWatched: number;
  timesWatched: number;
  flaggedWatched: boolean;
  watched: string | null;
};
export type StremioItem = { id: string; name: string; type: 'movie' | 'series'; listed: boolean; mtime: number | null; state: StremioState };
export type StremioProfile = { key: string; name: string; items: StremioItem[] };

const USABLE_ID = /^(tt\d+|(tmdb|tvdb|kitsu|mal|anilist|anidb):\d+)$/;
const ANIME_ID = /^(kitsu|mal|anilist|anidb):/;
const IMDB = /^(tt\d+)(?::|$)/;
const PRINTABLE = /^[^\u0000-\u001f\u007f]*$/;
const WATCHED_SHARE = 0.7;
const CREDITS_SHARE = 0.9;

const isRecord = (row: any): boolean =>
  Boolean(row) && typeof row === 'object' && typeof row._id === 'string' && Boolean(row.state) && typeof row.state === 'object' && (typeof row.removed === 'boolean' || typeof row.temp === 'boolean');

function bareRecords(json: any): unknown[] | null {
  const rows = Array.isArray(json) ? json : json && typeof json === 'object' && Array.isArray(json.result) ? json.result : null;
  return rows?.some(isRecord) ? rows : null;
}

const isBundle = (json: any): boolean => Boolean(json) && typeof json === 'object' && json.format === STREMIO_FORMAT && Array.isArray(json.profiles);

export const isStremioLibrary = (json: unknown): boolean => isBundle(json) || bareRecords(json) !== null;

const amount = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const epoch = (value: unknown): number | null => {
  const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at > 0 ? at : null;
};

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

function itemOf(row: any): StremioItem | null {
  if (!row || typeof row !== 'object' || typeof row._id !== 'string' || !USABLE_ID.test(row._id)) return null;
  if (row.type !== 'movie' && row.type !== 'series') return null;
  const state = row.state;
  if (!state || typeof state !== 'object') return null;
  const name = typeof row.name === 'string' ? row.name.trim().slice(0, 200) : '';
  return {
    id: row._id,
    name: name || row._id,
    type: row.type,
    listed: row.removed === false && row.temp === false,
    mtime: epoch(row._mtime),
    state: {
      lastWatched: epoch(state.lastWatched),
      videoId: text(state.video_id),
      timeOffset: amount(state.timeOffset),
      duration: amount(state.duration),
      overallTimeWatched: amount(state.overallTimeWatched),
      timesWatched: amount(state.timesWatched),
      flaggedWatched: Number(state.flaggedWatched) === 1,
      watched: text(state.watched),
    },
  };
}

function profileOf(key: unknown, name: unknown, rows: unknown): StremioProfile {
  return {
    key: typeof key === 'string' && key.length <= 64 && PRINTABLE.test(key) ? key : '',
    name: (typeof name === 'string' && PRINTABLE.test(name) ? name.trim().slice(0, 100) : '') || 'Stremio',
    items: (Array.isArray(rows) ? rows : []).map(itemOf).filter((item): item is StremioItem => item !== null),
  };
}

export function readStremioLibrary(json: unknown): StremioProfile[] {
  const bare = bareRecords(json);
  const profiles = bare ? [profileOf('', 'Stremio', bare)] : isBundle(json) ? (json as any).profiles.map((profile: any) => profileOf(profile?.key, profile?.name, profile?.items)) : [];
  return profiles.filter((profile: StremioProfile) => profile.items.length > 0);
}

export function imdbOfItem(item: StremioItem): string | null {
  for (const id of [item.id, item.state.videoId, item.state.watched]) {
    const found = id ? IMDB.exec(id) : null;
    if (found) return found[1];
  }
  return null;
}

export const isAnimeId = (id: string): boolean => ANIME_ID.test(id);

// Unwatching a film zeroes its count and leaves flaggedWatched set, so the flag alone is a viewing taken back.
export const filmWatched = (state: StremioState): boolean => state.timesWatched > 0;

export const reallyPlayed = (state: StremioState): boolean => state.duration > 0 && state.overallTimeWatched >= WATCHED_SHARE * state.duration;

// lastWatched dates the latest session; it is a finished viewing only if that session reached the watched mark
// (Stremio rewinds to 0 past the credits) rather than reopening a film watched before.
export const lastSessionFinished = (state: StremioState): boolean => state.timeOffset <= 1 || state.timeOffset >= WATCHED_SHARE * state.duration;

// Stremio rewinds a title past its credits; a position there is a film it never cleared, not one to resume.
export function resumeOf(state: StremioState): { positionMs: number; runtimeMs: number } | null {
  return state.duration > 0 && state.timeOffset > 1 && state.timeOffset < CREDITS_SHARE * state.duration ? { positionMs: state.timeOffset, runtimeMs: state.duration } : null;
}
