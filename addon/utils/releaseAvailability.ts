const RELEASE_AVAILABILITY_FIELD = '_releaseAvailability';

interface TmdbReleaseDate {
  release_date?: string | null;
  type?: number | string | null;
  [key: string]: any;
}

interface TmdbReleaseCountry {
  release_dates?: TmdbReleaseDate[] | null;
  [key: string]: any;
}

interface TmdbReleaseDates {
  results?: TmdbReleaseCountry[] | null;
  [key: string]: any;
}

interface ReleaseAvailability {
  schema: 1;
  source: 'tmdb_release_dates';
  hasReleaseDateData: true;
  earliestAnyReleaseDate: string | null;
  earliestHomeReleaseDate: string | null;
  // Only present when the item was built from a TMDB response that carried watch/providers.
  hasWatchProviders?: boolean;
}

interface TmdbWatchProviders {
  results?: Record<string, Record<string, any> | null> | null;
  [key: string]: any;
}

interface MetaWithReleaseAvailability {
  app_extras?: {
    releaseDates?: TmdbReleaseDates;
    hasWatchProviders?: boolean;
    [key: string]: any;
  };
  [RELEASE_AVAILABILITY_FIELD]?: ReleaseAvailability;
  [key: string]: any;
}

interface PayloadWithMetas {
  meta?: MetaWithReleaseAvailability | null;
  metas?: MetaWithReleaseAvailability[] | null;
  [key: string]: any;
}

function parseDateMs(value: unknown): number | null {
  if (!value) return null;
  const ms = new Date(value as string).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function toIsoDate(value: unknown): string | null {
  const ms = parseDateMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function minIsoDate(current: string | null, candidate: unknown): string | null {
  const candidateIso = toIsoDate(candidate);
  if (!candidateIso) return current || null;
  if (!current) return candidateIso;
  return parseDateMs(candidateIso)! < parseDateMs(current)! ? candidateIso : current;
}

function summarizeTmdbReleaseDates(releaseDates: TmdbReleaseDates | null | undefined): ReleaseAvailability | null {
  const results = releaseDates?.results;
  if (!Array.isArray(results)) return null;

  let earliestAnyReleaseDate: string | null = null;
  let earliestHomeReleaseDate: string | null = null;

  for (const country of results) {
    const dates = country?.release_dates;
    if (!Array.isArray(dates)) continue;

    for (const release of dates) {
      const releaseDate = release?.release_date;
      earliestAnyReleaseDate = minIsoDate(earliestAnyReleaseDate, releaseDate);

      const releaseType = Number(release?.type);
      if (releaseType >= 4 && releaseType <= 6) {
        earliestHomeReleaseDate = minIsoDate(earliestHomeReleaseDate, releaseDate);
      }
    }
  }

  return {
    schema: 1,
    source: 'tmdb_release_dates',
    hasReleaseDateData: true,
    earliestAnyReleaseDate,
    earliestHomeReleaseDate,
  };
}

// TMDB keys each region by monetization type (flatrate, rent, buy, ads, free) next to a `link`.
function hasTmdbWatchProviders(watchProviders: TmdbWatchProviders | null | undefined): boolean | undefined {
  const results = watchProviders?.results;
  if (!results || typeof results !== 'object') return undefined;

  return Object.values(results).some(region =>
    !!region && Object.values(region).some(offers => Array.isArray(offers) && offers.length > 0)
  );
}

function isEmptyPlainObject(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

function normalizeMetaReleaseAvailability<T extends MetaWithReleaseAvailability | null | undefined>(meta: T): T {
  if (!meta || typeof meta !== 'object') return meta;

  const rawReleaseDates = meta.app_extras?.releaseDates;
  if (rawReleaseDates && !meta[RELEASE_AVAILABILITY_FIELD]) {
    const summary = summarizeTmdbReleaseDates(rawReleaseDates);
    if (summary) {
      meta[RELEASE_AVAILABILITY_FIELD] = summary;
    }
  }

  const hasWatchProviders = meta.app_extras?.hasWatchProviders;
  const summary = meta[RELEASE_AVAILABILITY_FIELD];
  if (summary && typeof hasWatchProviders === 'boolean') {
    summary.hasWatchProviders = hasWatchProviders;
  }

  if (meta.app_extras) {
    delete meta.app_extras.releaseDates;
    delete meta.app_extras.hasWatchProviders;
    if (isEmptyPlainObject(meta.app_extras)) {
      delete meta.app_extras;
    }
  }

  return meta;
}

function normalizeReleaseAvailabilityInPayload<T extends PayloadWithMetas | null | undefined>(payload: T): T {
  if (!payload || typeof payload !== 'object') return payload;

  if (payload.meta) {
    normalizeMetaReleaseAvailability(payload.meta);
  }

  if (Array.isArray(payload.metas)) {
    for (const meta of payload.metas) {
      normalizeMetaReleaseAvailability(meta);
    }
  }

  return payload;
}

function getReleaseAvailability(meta: MetaWithReleaseAvailability | null | undefined): ReleaseAvailability | null {
  if (!meta || typeof meta !== 'object') return null;

  const existing = meta[RELEASE_AVAILABILITY_FIELD];
  if (existing && existing.hasReleaseDateData === true) {
    return existing;
  }

  return summarizeTmdbReleaseDates(meta.app_extras?.releaseDates);
}

module.exports = {
  RELEASE_AVAILABILITY_FIELD,
  getReleaseAvailability,
  hasTmdbWatchProviders,
  normalizeMetaReleaseAvailability,
  normalizeReleaseAvailabilityInPayload,
  summarizeTmdbReleaseDates,
};
