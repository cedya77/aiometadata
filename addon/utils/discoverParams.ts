// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
// @ts-ignore
import getCountryISO3 from 'country-iso-2-to-3';
// @ts-ignore
import { loadConfigFromDatabase } from '../lib/configApi';

/**
 * The discover endpoints are called by the configure UI, which may or may not
 * have a key of its own yet. Precedence is the key on the request, then the
 * saved config of the user it names, then whatever the instance provides.
 */
interface ProviderKeySource {
  /** Field under config.apiKeys holding this provider's key. */
  configField: 'tmdb' | 'tvdb';
  /** Env vars in precedence order. */
  envVars: string[];
  /** Log tag used when a named user's config cannot be read. */
  label: string;
}

const SOURCES: Record<'tmdb' | 'tvdb', ProviderKeySource> = {
  tmdb: {
    configField: 'tmdb',
    envVars: ['TMDB_API_KEY', 'TMDB_API', 'BUILT_IN_TMDB_API_KEY'],
    label: 'TMDB Discover',
  },
  tvdb: {
    configField: 'tvdb',
    envVars: ['TVDB_API_KEY', 'BUILT_IN_TVDB_API_KEY'],
    label: 'TVDB Discover',
  },
};

async function resolveDiscoverApiKey(provider: 'tmdb' | 'tvdb', req: any): Promise<string> {
  const source = SOURCES[provider];

  const requestApiKey = typeof req.query.apikey === 'string' ? req.query.apikey.trim() : '';
  if (requestApiKey) {
    return requestApiKey;
  }

  const userUUID = typeof req.query.userUUID === 'string' ? req.query.userUUID.trim() : '';
  if (userUUID) {
    try {
      const userConfig = await loadConfigFromDatabase(userUUID);
      const userConfigKey = userConfig?.apiKeys?.[source.configField]?.trim() || '';
      if (userConfigKey) {
        return userConfigKey;
      }
    } catch (error: any) {
      consola.debug(`[${source.label}] Could not load config for user ${userUUID}: ${error.message}`);
    }
  }

  for (const name of source.envVars) {
    const value = (process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

export function resolveTmdbDiscoverApiKey(req: any): Promise<string> {
  return resolveDiscoverApiKey('tmdb', req);
}

export function resolveTvdbDiscoverApiKey(req: any): Promise<string> {
  return resolveDiscoverApiKey('tvdb', req);
}

export function normalizeTmdbDiscoverType(type: string): 'tv' | 'movie' {
  return type === 'tv' ? 'tv' : 'movie';
}

export function normalizeTvdbDiscoverType(type: string): 'series' | 'movies' {
  return type === 'series' ? 'series' : 'movies';
}

/** TVDB filters by three-letter country, so a two-letter region has to be widened. */
export function toTvdbCountryCode(regionCode: unknown): string {
  const normalized = typeof regionCode === 'string' ? regionCode.trim().toUpperCase() : '';
  if (!normalized) return 'usa';
  const countryData = getCountryISO3(normalized);
  if (!countryData) return 'usa';
  return String(countryData).toLowerCase();
}
