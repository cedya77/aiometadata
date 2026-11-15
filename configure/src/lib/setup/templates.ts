// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { resolveAnimeProfile } from './animeProfiles';
import { listLineupOptions, type LineupOption, type LineupSources } from './lineups';
import type { AnimeSource, ConfigTemplate, ContentChoice, RequiredKeyId } from './types';

export interface BuiltInTemplate extends ConfigTemplate {
  lineupOption: LineupOption;
}

export function listBuiltInTemplates(content: ContentChoice, sources: LineupSources): BuiltInTemplate[] {
  return listLineupOptions(content, sources).map(option => ({
    id: `builtin.${option.kind}`,
    name: option.name,
    tagline: option.tagline,
    lineup: option.kind,
    source: { kind: 'builtin' as const },
    lineupOption: option,
  }));
}

/** Art providers are either a bare string or a poster/background/logo triple. */
export function requiredKeysFor(content: ContentChoice, animeSource: AnimeSource): RequiredKeyId[] {
  const profile = resolveAnimeProfile(content, animeSource);
  const used = new Set<string>();

  const add = (value: unknown) => {
    if (typeof value === 'string') used.add(value.toLowerCase());
  };

  Object.values(profile.providers ?? {}).forEach(add);
  Object.values(profile.search?.providers ?? {}).forEach(add);

  Object.values(profile.artProviders ?? {}).forEach(value => {
    if (typeof value === 'boolean' || value == null) return;
    if (typeof value === 'string') return add(value);
    Object.values(value).forEach(add);
  });

  const usesVendor = (vendor: string) =>
    Array.from(used).some(provider => provider === vendor || provider.startsWith(`${vendor}.`));

  const keys: RequiredKeyId[] = [];
  if (usesVendor('tmdb')) keys.push('tmdb');
  if (usesVendor('tvdb')) keys.push('tvdb');
  return keys;
}

export interface KeyAvailability {
  hasBuiltInTmdb: boolean;
  hasBuiltInTvdb: boolean;
  stored: Partial<Record<RequiredKeyId, string | undefined>>;
  entered: Partial<Record<RequiredKeyId, string | undefined>>;
}

export function isKeySatisfied(key: RequiredKeyId, availability: KeyAvailability): boolean {
  if (key === 'tmdb' && availability.hasBuiltInTmdb) return true;
  if (key === 'tvdb' && availability.hasBuiltInTvdb) return true;
  return !!(availability.entered[key]?.trim() || availability.stored[key]?.trim());
}

export function missingKeysFor(
  content: ContentChoice,
  animeSource: AnimeSource,
  availability: KeyAvailability
): RequiredKeyId[] {
  return requiredKeysFor(content, animeSource).filter(key => !isKeySatisfied(key, availability));
}
