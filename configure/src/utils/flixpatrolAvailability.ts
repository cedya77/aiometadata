// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE

import type { FlixPatrolSections, FlixPatrolVariant } from './catalogUtils';

export interface AvailabilityIndex {
  schema_version?: number;
  generated_at?: string;
  variantLabels?: Record<string, string>;
  // region slug -> service id -> category -> variant ids
  regions: Record<string, Record<string, Record<string, string[]>>>;
}

export interface ServiceOption { id: string; name: string; }
export interface CountryOption { id: string; name: string; slug: string; }

/** Turns a slug/id into a display name, e.g. "hulu-nippon" -> "Hulu Nippon". */
export function prettify(id: string): string {
  return id
    .split('-')
    .map(w => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Services present anywhere in the index. Known ids keep their curated display
 * name; unknown ids (services the crawler added but the static list lacks) fall
 * back to a prettified id so they still surface.
 */
export function deriveServices(
  index: AvailabilityIndex,
  known: { id: string; name: string }[]
): ServiceOption[] {
  const nameById = new Map(known.map(s => [s.id, s.name] as const));
  const ids = new Set<string>();
  for (const services of Object.values(index.regions)) {
    for (const svc of Object.keys(services)) ids.add(svc);
  }
  return [...ids]
    .map(id => ({ id, name: nameById.get(id) || prettify(id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Countries that carry the given service. */
export function deriveCountries(
  index: AvailabilityIndex,
  known: { id: string; name: string; slug: string }[],
  serviceId: string
): CountryOption[] {
  const bySlug = new Map(known.map(c => [c.slug, c] as const));
  const out: CountryOption[] = [];
  for (const [slug, services] of Object.entries(index.regions)) {
    if (!(serviceId in services)) continue;
    const c = bySlug.get(slug);
    out.push(c ? { id: c.id, name: c.name, slug: c.slug } : { id: slug, name: prettify(slug), slug });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Reconstructs the probe result (sections + variants) for a pair directly from
 * the index — a category key present means that chart exists. Returns null if
 * the pair is absent.
 */
export function sectionsFor(
  index: AvailabilityIndex,
  serviceId: string,
  regionSlug: string
): FlixPatrolSections | null {
  const entry = index.regions[regionSlug]?.[serviceId];
  if (!entry) return null;

  const variants = (cat: string): FlixPatrolVariant[] =>
    (entry[cat] || []).map(id => ({ id, label: index.variantLabels?.[id] || id }));

  const movieVariants = variants('movies');
  const seriesVariants = variants('series');
  const overallVariants = variants('overall');

  return {
    hasMovies: 'movies' in entry,
    hasShows: 'series' in entry,
    hasOverall: 'overall' in entry,
    ...(movieVariants.length ? { movieVariants } : {}),
    ...(seriesVariants.length ? { seriesVariants } : {}),
    ...(overallVariants.length ? { overallVariants } : {}),
  };
}
