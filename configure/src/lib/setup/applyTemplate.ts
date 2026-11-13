// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { AppConfig, CatalogConfig } from '@/contexts/config';
import { allCatalogDefinitions } from '@/data/catalogs';
import { resolveAnimeProfile } from './animeProfiles';
import { buildLineup, isSourceAvailable, type LineupSources } from './lineups';
import type { AnimeSource, ConfigTemplate, ContentChoice, SetupExtras } from './types';

export interface SetupSelection {
  template: ConfigTemplate;
  content: ContentChoice;
  animeSource: AnimeSource;
  sources: LineupSources;
  extras?: SetupExtras;
}

function resolveTemplateCatalogs(template: ConfigTemplate, content: ContentChoice, sources: LineupSources): CatalogConfig[] {
  if (typeof template.lineup === 'string') {
    return buildLineup(template.lineup, content, sources);
  }

  const wanted = new Set(template.lineup.catalogIds);
  return allCatalogDefinitions.map(definition => {
    const enabled = (wanted.has(`${definition.id}:${definition.type}`) || wanted.has(definition.id)) && isSourceAvailable(definition, sources);
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

function applyDisplayOverrides(
  catalogs: CatalogConfig[],
  overrides: AppConfig['displayTypeOverrides']
): CatalogConfig[] {
  if (!overrides?.movie && !overrides?.series) return catalogs;

  return catalogs.map(catalog => {
    if (catalog.type === 'movie' && overrides.movie) return { ...catalog, displayType: overrides.movie };
    if (catalog.type === 'series' && overrides.series) return { ...catalog, displayType: overrides.series };
    return catalog;
  });
}

export function buildSetupCatalogs(selection: SetupSelection, previous: AppConfig): CatalogConfig[] {
  const { template, content, sources, extras } = selection;

  return applyDisplayOverrides(
    [
      ...resolveTemplateCatalogs(template, content, sources),
      ...(template.catalogs ?? []),
      ...(extras?.streamingCatalogs ?? []),
      ...(extras?.curatorCatalogs ?? []),
      ...(extras?.aiCatalogs ?? []),
    ],
    previous.displayTypeOverrides
  );
}

function enabledStreamingServices(catalogs: CatalogConfig[]): string[] {
  return [...new Set(
    catalogs
      .filter(catalog => catalog.source === 'streaming' && catalog.enabled)
      .map(catalog => catalog.id.replace('streaming.', '').replace(/ .*/, ''))
  )];
}

export function applySetup(previous: AppConfig, selection: SetupSelection): AppConfig {
  const { template, content, animeSource, extras } = selection;
  const profile = resolveAnimeProfile(content, animeSource);
  const settings = template.settings ?? {};

  const next: AppConfig = { ...previous };

  next.providers = { ...previous.providers, ...profile.providers, ...settings.providers };
  next.artProviders = { ...previous.artProviders, ...profile.artProviders, ...settings.artProviders };

  if (profile.search || settings.search) {
    next.search = {
      ...previous.search,
      ...profile.search,
      ...settings.search,
      providers: {
        ...previous.search.providers,
        ...(profile.search?.providers ?? {}),
        ...(settings.search?.providers ?? {}),
      },
      engineEnabled: {
        ...(previous.search.engineEnabled ?? {}),
        ...(profile.search?.engineEnabled ?? {}),
        ...(settings.search?.engineEnabled ?? {}),
      },
    };
  }

  if (profile.mal || settings.mal) {
    next.mal = { ...previous.mal, ...profile.mal, ...settings.mal };
  }

  next.sfw = previous.includeAdult ? false : (settings.sfw ?? profile.sfw ?? true);

  const providedKeys = extras?.apiKeys ?? {};
  next.apiKeys = { ...previous.apiKeys };
  for (const [id, value] of Object.entries(providedKeys)) {
    if (value === undefined) continue;
    next.apiKeys[id as keyof AppConfig['apiKeys']] = value.trim();
  }

  next.catalogSetupComplete = true;
  next.catalogs = buildSetupCatalogs(selection, previous);
  next.streaming = enabledStreamingServices(next.catalogs);
  next.showDisabledCatalogs = true;

  return next;
}
