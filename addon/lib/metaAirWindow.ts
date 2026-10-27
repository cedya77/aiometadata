export {};

const { getSetting }: any = require('./settingsService');

/**
 * A series cached midweek holds its episode list for the full meta TTL, so an
 * episode airing inside that window keeps the thumbnail, title and overview the
 * provider published before it aired. Every meta write for a title with an
 * upcoming episode is therefore held to expire once that episode has aired.
 *
 * The clamp only ever shortens: a title with nothing due inside the window keeps
 * the TTL it was given.
 *
 * Episode timestamps are only as precise as the provider gives them.
 * resolveReleaseTimestamp falls back to 20:00 in the origin timezone, and to noon
 * UTC where there is no timezone at all, either of which can sit most of a day
 * from the real airing. The lag absorbs that gap. Refreshing late costs a few
 * stale hours; refreshing early rebuilds from the same pre-air data and then
 * holds it for another full TTL.
 */

const MIN_TTL_SECONDS = 300;
const DEFAULT_LAG_SECONDS = 24 * 60 * 60;
const DEFAULT_JITTER_SECONDS = 60 * 60;
const DEFAULT_STALE_STATUS_SECONDS = 6 * 60 * 60;
const DEFAULT_STALE_STATUS_DAYS = 30;
const PRE_RELEASE_STATUSES = new Set([
  'not yet aired', 'upcoming', 'unreleased', 'tba', 'planned', 'rumored',
  'in production', 'post production', 'in development', 'to be determined',
]);

function readSetting(key: string): string {
  try {
    return getSetting(key) || '';
  } catch {
    return '';
  }
}

function positiveSeconds(key: string, fallback: number): number {
  const parsed = Number.parseInt(readSetting(key), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function timeOf(value: any): number | null {
  if (!value) return null;
  const at = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}

function firstAiredAt(meta: any): number | null {
  const times = [meta?.released, ...(Array.isArray(meta?.videos) ? meta.videos.map((video: any) => video?.released) : [])]
    .map(timeOf)
    .filter((at): at is number => at !== null);
  return times.length ? Math.min(...times) : null;
}

function statusBehindRelease(meta: any, now: number): boolean {
  if (!PRE_RELEASE_STATUSES.has(String(meta?.status ?? '').trim().toLowerCase())) return false;
  const first = firstAiredAt(meta);
  const days = positiveSeconds('META_TTL_STALE_STATUS_DAYS', DEFAULT_STALE_STATUS_DAYS);
  return first !== null && first <= now && now - first <= days * 24 * 60 * 60 * 1000;
}

function nextAirAt(meta: any, now: number): number | null {
  const videos = meta?.videos;
  if (!Array.isArray(videos) || videos.length === 0) return null;

  let next: number | null = null;
  for (const video of videos) {
    if (!video || !video.released) continue;
    const at = video.released instanceof Date
      ? video.released.getTime()
      : new Date(video.released).getTime();
    if (!Number.isFinite(at) || at <= now) continue;
    if (next === null || at < next) next = at;
  }
  return next;
}

function clampMetaTtlToAirWindow(meta: any, ttl: number, now: number = Date.now()): number {
  if (!Number.isFinite(ttl) || ttl <= 0) return ttl;
  if (statusBehindRelease(meta, now)) {
    ttl = Math.min(ttl, Math.max(MIN_TTL_SECONDS, positiveSeconds('META_TTL_STALE_STATUS_SECONDS', DEFAULT_STALE_STATUS_SECONDS)));
  }
  if (!meta || meta.type === 'movie') return ttl;

  const next = nextAirAt(meta, now);
  if (next === null) return ttl;

  // Every copy of a title derives the same air time, and air times cluster, so
  // without a spread they all lapse together and rebuild together.
  const spread = Math.floor(Math.random() * (positiveSeconds('META_TTL_AIR_JITTER_SECONDS', DEFAULT_JITTER_SECONDS) + 1));
  const budget = Math.floor((next - now) / 1000)
    + positiveSeconds('META_TTL_AIR_LAG_SECONDS', DEFAULT_LAG_SECONDS)
    + spread;
  if (budget >= ttl) return ttl;

  return Math.max(MIN_TTL_SECONDS, budget);
}

module.exports = {
  clampMetaTtlToAirWindow,
};
