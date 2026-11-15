// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { isUnratedCertification } from './ageRating';

const getCountryISO3: (iso2: string) => string | undefined = require('country-iso-2-to-3');

function newestCertification(releaseDates: any[], matches: (releaseDate: any) => boolean): string | null {
  const candidates = releaseDates
    .filter(matches)
    .sort((a, b) => new Date(b.release_date).getTime() - new Date(a.release_date).getTime());
  return candidates.length > 0 ? candidates[0].certification : null;
}

/**
 * A restoration or reissue is not resubmitted to the ratings board, so it comes back
 * unrated with a release date decades newer than the original. Taking the newest
 * release outright would let that erase the rating the film actually carries, so a
 * real rating is preferred at every step and an unrated one is only the last word.
 */
export function getTmdbMovieCertificationForCountry(certificationsData: any, country = 'US'): string | null {
  if (!certificationsData) {
    return null;
  }

  const countryData = certificationsData.results?.find((r: any) => r.iso_3166_1 === country);
  if (!countryData?.release_dates) return null;

  const theatrical = newestCertification(
    countryData.release_dates,
    rd => rd.type === 3 && !isUnratedCertification(rd.certification)
  );
  if (theatrical) return theatrical;

  const anyRelease = newestCertification(
    countryData.release_dates,
    rd => !isUnratedCertification(rd.certification)
  );
  if (anyRelease) return anyRelease;

  // Nothing here is rated. Answer with the unrated value rather than null, because a
  // caller reading a second country falls back to the first only when this is null.
  return newestCertification(
    countryData.release_dates,
    rd => typeof rd.certification === 'string' && rd.certification.trim() !== ''
  );
}

export function getTmdbTvCertificationForCountry(certificationsData: any, country = 'US'): string | null {
  if (!certificationsData) {
    return null;
  }

  const countryData = certificationsData.results?.find((r: any) => r.iso_3166_1 === country);
  if (!countryData?.rating) return null;

  return countryData.rating;
}

export function getTvdbCertification(contentRatings: any, countryCode: string | null | undefined, contentType?: string, fallbackToUsa = true): string | null {
  if (!contentRatings || !Array.isArray(contentRatings)) {
    return null;
  }

  let code = countryCode?.toLowerCase();
  if (code && code.length === 2) {
    try { code = getCountryISO3(code.toUpperCase())?.toLowerCase(); } catch {}
  }

  let certification = code ? contentRatings.find(rating =>
    rating.country?.toLowerCase() === code &&
    (!contentType || rating.contentType === contentType || rating.contentType === '')
  ) : null;

  if (!certification && fallbackToUsa) {
    certification = contentRatings.find(rating =>
      rating.country?.toLowerCase() === 'usa' &&
      (!contentType || rating.contentType === contentType || rating.contentType === '')
    );
  }

  return certification?.name || null;
}

export type CertificationMap = Record<string, string>;

export type CertificationSources = {
  tmdbMovie?: any;
  tmdbTv?: any;
  tvdbRatings?: any;
  tvdbContentType?: string;
};

// The package only looks up ISO2 to ISO3, and TVDB names countries in ISO3.
const ISO3_TO_ISO2: Record<string, string> = (() => {
  const table: Record<string, string> = {};
  for (let first = 65; first <= 90; first++) {
    for (let second = 65; second <= 90; second++) {
      const iso2 = String.fromCharCode(first, second);
      const iso3 = getCountryISO3(iso2);
      if (iso3) table[iso3.toLowerCase()] = iso2;
    }
  }
  return table;
})();

function asCountry(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function languageRegion(config: { language?: unknown } | null | undefined): string | null {
  return asCountry(typeof config?.language === 'string' ? config.language.split('-')[1] : null);
}

export function resolveRatingCountry(config: { contentRatingCountry?: unknown; language?: unknown } | null | undefined): string {
  return asCountry(config?.contentRatingCountry) || languageRegion(config) || 'US';
}

export function buildCertificationMap(sources: CertificationSources = {}): CertificationMap | null {
  const map: CertificationMap = {};

  const tmdb = sources.tmdbMovie || sources.tmdbTv;
  const readTmdb = sources.tmdbMovie ? getTmdbMovieCertificationForCountry : getTmdbTvCertificationForCountry;
  if (tmdb && Array.isArray(tmdb.results)) {
    for (const result of tmdb.results) {
      const country = result?.iso_3166_1;
      if (typeof country !== 'string' || map[country] !== undefined) continue;
      const value = readTmdb(tmdb, country);
      if (typeof value === 'string' && value !== '') map[country] = value;
    }
  }

  if (Array.isArray(sources.tvdbRatings)) {
    const contentType = sources.tvdbContentType;
    const seen = new Set<string>();
    for (const tvdbRating of sources.tvdbRatings) {
      if (contentType && tvdbRating?.contentType !== contentType && tvdbRating?.contentType !== '') continue;
      const country = ISO3_TO_ISO2[String(tvdbRating?.country || '').toLowerCase()];
      if (!country || seen.has(country)) continue;
      seen.add(country);
      const name = tvdbRating.name;
      if (map[country] === undefined && typeof name === 'string' && name !== '') map[country] = name;
    }
  }

  return Object.keys(map).length > 0 ? map : null;
}

function isCertificationMap(value: unknown): value is CertificationMap {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

// Entries without a map (cached before it, or MAL/Kitsu) keep the rating they stored.
export function applyContentRatingProjection(meta: any, config: any): any {
  const extras = meta?.app_extras;
  if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return meta;
  if (!isCertificationMap(extras.certifications)) return meta;

  extras.certificationLocal = extras.certifications[resolveRatingCountry(config)] ?? extras.certification ?? null;
  return meta;
}

export function ratingLinkNames(appExtras: any): Set<string> {
  const names = new Set<string>();
  if (!appExtras || typeof appExtras !== 'object') return names;
  const add = (value: unknown) => {
    if (typeof value === 'string' && value !== '') names.add(value);
  };
  add(appExtras.certification);
  add(appExtras.certificationLocal);
  if (isCertificationMap(appExtras.certifications)) Object.values(appExtras.certifications).forEach(add);
  return names;
}

export function stripRatingLinks(links: any, appExtras: any): any {
  const names = ratingLinkNames(appExtras);
  if (!Array.isArray(links) || names.size === 0) return links;
  return links.filter((link: any) => !(link?.category === 'Genres' && names.has(link?.name)));
}

// Swaps in a new map; links named from the old one would otherwise outlive it.
export function replaceCertifications(meta: any, map: CertificationMap | null): any {
  meta.app_extras = meta.app_extras || {};
  if (Array.isArray(meta.links)) meta.links = stripRatingLinks(meta.links, meta.app_extras);
  meta.app_extras.certifications = map;
  meta.app_extras.certification = map?.US ?? null;
  meta.app_extras.certificationLocal = null;
  return meta;
}
