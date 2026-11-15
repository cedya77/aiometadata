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
}

interface MetaWithReleaseAvailability {
  app_extras?: {
    releaseDates?: TmdbReleaseDates;
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

  compactReleaseDatesInPlace(meta);

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

/**
 * Keeps the earliest release of each TMDB release type (1 premiere ... 4 digital,
 * 5 physical, 6 TV), with its country, in the TMDB `release_dates` shape. Clients
 * that hide titles until they can be streamed (e.g. Remux, which reads
 * `app_extras.releaseDates`) get the dates they need without the full list.
 */
function compactTmdbReleaseDates(releaseDates: TmdbReleaseDates | null | undefined): TmdbReleaseDates | null {
  const results = releaseDates?.results;
  if (!Array.isArray(results)) return null;

  const earliestByType = new Map<number, { country: string; release: TmdbReleaseDate; ms: number }>();
  for (const country of results) {
    const dates = country?.release_dates;
    if (!Array.isArray(dates)) continue;
    for (const release of dates) {
      const ms = parseDateMs(release?.release_date);
      const type = Number(release?.type);
      if (ms === null || !Number.isFinite(type)) continue;
      const current = earliestByType.get(type);
      if (!current || ms < current.ms) {
        earliestByType.set(type, { country: country.iso_3166_1, release, ms });
      }
    }
  }
  if (earliestByType.size === 0) return null;

  return {
    results: [...earliestByType.entries()]
      .sort(([a], [b]) => a - b)
      .map(([type, { country, release }]) => ({
        iso_3166_1: country,
        release_dates: [{ release_date: toIsoDate(release.release_date), type }],
      })),
  };
}

function compactReleaseDatesInPlace(meta: MetaWithReleaseAvailability): void {
  if (!meta.app_extras || !Object.prototype.hasOwnProperty.call(meta.app_extras, 'releaseDates')) return;

  const compact = compactTmdbReleaseDates(meta.app_extras.releaseDates);
  if (compact) {
    meta.app_extras.releaseDates = compact;
    return;
  }

  delete meta.app_extras.releaseDates;
  if (isEmptyPlainObject(meta.app_extras)) {
    delete meta.app_extras;
  }
}

function stripMetaReleaseAvailabilityForResponse<T extends MetaWithReleaseAvailability | null | undefined>(meta: T): T {
  if (!meta || typeof meta !== 'object') return meta;

  if (Object.prototype.hasOwnProperty.call(meta, RELEASE_AVAILABILITY_FIELD)) {
    delete meta[RELEASE_AVAILABILITY_FIELD];
  }

  compactReleaseDatesInPlace(meta);

  return meta;
}

function stripReleaseAvailabilityForResponse<T extends PayloadWithMetas | null | undefined>(payload: T): T {
  if (!payload || typeof payload !== 'object') return payload;

  if (payload.meta) {
    stripMetaReleaseAvailabilityForResponse(payload.meta);
  }

  if (Array.isArray(payload.metas)) {
    for (const meta of payload.metas) {
      stripMetaReleaseAvailabilityForResponse(meta);
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
  normalizeMetaReleaseAvailability,
  normalizeReleaseAvailabilityInPayload,
  stripReleaseAvailabilityForResponse,
  summarizeTmdbReleaseDates,
};
