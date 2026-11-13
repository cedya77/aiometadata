// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { allCatalogDefinitions, isJikanCatalog, type CatalogDefinition } from '@/data/catalogs';
import type { CatalogConfig } from '@/contexts/config';
import { includesAnime } from './animeProfiles';
import type { ContentChoice, LineupKind } from './types';

export interface LineupSpec {
  kind: LineupKind;
  name: string;
  tagline: string;
}

export const LINEUPS: LineupSpec[] = [
  { kind: 'minimal', name: 'Minimal', tagline: 'A short home screen with just the essentials.' },
  { kind: 'balanced', name: 'Balanced', tagline: 'A full home screen plus rows you can browse into.' },
  { kind: 'everything', name: 'Everything', tagline: 'Every built-in catalog turned on.' },
];

/** `showOnHomeByDefault` is a placement hint, not an enable, hence the intersection. */
const ENABLES: Record<LineupKind, (definition: CatalogDefinition) => boolean> = {
  minimal: definition => !!definition.isEnabledByDefault && !!definition.showOnHomeByDefault,
  balanced: definition => !!definition.isEnabledByDefault,
  everything: definition => definition.source !== 'streaming',
};

function isAnime(definition: CatalogDefinition): boolean {
  return definition.type === 'anime' || definition.source === 'mal';
}

export interface LineupSources {
  lumiere: boolean;
  jikan: boolean;
}

export function isSourceAvailable(definition: CatalogDefinition, sources: LineupSources): boolean {
  return (definition.source !== 'lumiere' || sources.lumiere) && (sources.jikan || !isJikanCatalog(definition));
}

/** Emits every definition, enabled or not: the Catalogs tab expects the full set. */
export function buildLineup(kind: LineupKind, content: ContentChoice, sources: LineupSources): CatalogConfig[] {
  const wantsAnime = includesAnime(content);
  const shouldEnable = ENABLES[kind];

  return allCatalogDefinitions.map(definition => {
    const enabled = shouldEnable(definition) && (wantsAnime || !isAnime(definition)) && isSourceAvailable(definition, sources);
    return {
      id: definition.id,
      name: definition.name,
      type: definition.type,
      source: definition.source as CatalogConfig['source'],
      enabled,
      showInHome: enabled && !!definition.showOnHomeByDefault,
      sort: 'default',
      order: 'asc',
    } satisfies CatalogConfig;
  });
}

export function countEnabled(catalogs: CatalogConfig[]): number {
  return catalogs.filter(catalog => catalog.enabled).length;
}

export interface LineupOption extends LineupSpec {
  catalogs: CatalogConfig[];
  enabledCount: number;
}

/** Drops a lineup whose enabled set duplicates an earlier one. */
export function listLineupOptions(content: ContentChoice, sources: LineupSources): LineupOption[] {
  const seen = new Set<string>();
  const options: LineupOption[] = [];

  for (const spec of LINEUPS) {
    const catalogs = buildLineup(spec.kind, content, sources);
    const signature = catalogs
      .filter(catalog => catalog.enabled)
      .map(catalog => `${catalog.id}:${catalog.type}`)
      .join('|');

    if (seen.has(signature)) continue;
    seen.add(signature);
    options.push({ ...spec, catalogs, enabledCount: countEnabled(catalogs) });
  }

  return options;
}
