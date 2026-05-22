import consola from 'consola';
import type { AICatalogOutput, ResolveContext, ResolveResult } from './ai-catalog-schema';
import { parseTmdbKeywordNames } from '../lib/tmdb-keyword-index';

const logger = consola.withTag('AICatalog');

function pickBestMatch(results: any[], queryName: string): any | null {
  if (!results.length) return null;
  const nameLower = queryName.toLowerCase();
  const exactMatches = results.filter((r: any) => (r.name || r.title || '').toLowerCase() === nameLower);
  if (exactMatches.length) {
    exactMatches.sort((a: any, b: any) => a.id - b.id);
    return exactMatches[0];
  }
  return results[0];
}

function normalizeSearchName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function watchProviderCandidates(name: string): string[] {
  const normalized = normalizeSearchName(name);
  const aliases: Record<string, string[]> = {
    'amazon prime': ['amazon prime video'],
    'prime': ['amazon prime video'],
    'prime video': ['amazon prime video'],
    'apple tv': ['apple tv plus'],
    'apple tv plus': ['apple tv plus'],
    'disney': ['disney plus'],
    'disney plus': ['disney plus'],
    'hbo max': ['max', 'hbo max'],
    'max': ['max', 'hbo max'],
    'paramount': ['paramount plus'],
    'paramount plus': ['paramount plus'],
    'showtime': ['paramount plus showtime'],
  };
  return Array.from(new Set([normalized, ...(aliases[normalized] || [])]));
}

function pickWatchProviderMatch(providers: any[], name: string): any | null {
  const candidates = new Set(watchProviderCandidates(name));
  const exact = providers.find((provider: any) => candidates.has(normalizeSearchName(provider.provider_name || '')));
  if (exact) return exact;

  return providers.find((provider: any) => {
    const providerName = normalizeSearchName(provider.provider_name || '');
    return Array.from(candidates).some((candidate) => providerName.includes(candidate) || candidate.includes(providerName));
  }) || null;
}

export async function resolveEntities(catalog: AICatalogOutput, ctx: ResolveContext): Promise<ResolveResult> {
  const resolved: Record<string, string> = {};
  const warnings: string[] = [];
  const resolve = catalog.resolve;
  if (!resolve) return { resolved, warnings };

  const moviedb = require('../lib/getTmdb');
  const { httpGet } = require('./httpClient');

  if (catalog.source === 'tmdb') {
    if (!ctx.tmdbApiKey) {
      logger.warn('[AI Catalog] No TMDB API key available for entity resolution');
      return { resolved, warnings };
    }
    const config = { apiKeys: { tmdb: ctx.tmdbApiKey } };

    if (resolve.companies?.length) {
      logger.info(`[AI Catalog] Resolving TMDB companies: ${resolve.companies.join(', ')}`);
      const items = await resolveNamedEntities(resolve.companies, 'TMDB company', async (name) => {
        const data = await moviedb.makeTmdbRequest('/search/company', ctx.tmdbApiKey, { query: name, page: 1 }, 'GET', null, config);
        const results = (data?.results || []).filter((r: any) => r?.id);
        const best = pickBestMatch(results, name);
        if (!best) return null;
        logger.debug(`[AI Catalog] Company "${name}" -> ID ${best.id} (${best.name})`);
        return { id: best.id, label: best.name || name };
      });
      if (items.length) resolved.with_companies = items.map(i => i.id).join('|');
      if (items.length) resolved._formState_withCompanies = JSON.stringify(items);
    }

    const keywordIndex = require('../lib/tmdb-keyword-index');
    const includeKeywordNames = parseTmdbKeywordNames(resolve.keywords || []);
    const excludeKeywordNamesList = parseTmdbKeywordNames(resolve.excludeKeywords || []);
    const keywordRequests = [
      ...includeKeywordNames.map(input => ({ input, exclude: false })),
      ...excludeKeywordNamesList.map(input => ({ input, exclude: true })),
    ];

    if (keywordRequests.length) {
      logger.info(`[AI Catalog] Resolving TMDB keywords: ${keywordRequests.map(item => item.input).join(', ')}`);
      const items = await resolveNamedEntities(keywordRequests, 'TMDB keyword', async ({ input, exclude }) => {
        const local = await keywordIndex.resolveTmdbKeywordByName(input);
        if (!local?.id) return null;
        logger.debug(`[AI Catalog] Keyword "${input}" -> ID ${local.id} (${local.label})`);
        return { id: local.id, label: local.label || input, _exclude: exclude };
      });
      const includeItems = items.filter((i: any) => !i._exclude);
      const excludeItems = items.filter((i: any) => i._exclude);
      if (includeItems.length) {
        resolved.with_keywords = includeItems.map(i => i.id).join('|');
        resolved._formState_withKeywords = JSON.stringify(includeItems.map(i => ({ id: i.id, label: i.label })));
      }
      if (excludeItems.length) {
        resolved.without_keywords = excludeItems.map(i => i.id).join('|');
        resolved._formState_withoutKeywords = JSON.stringify(excludeItems.map(i => ({ id: i.id, label: i.label })));
      }
    }

    const resolveTmdbPeople = async (names: string[], label: string, singularLabel: string) => {
      logger.info(`[AI Catalog] Resolving TMDB ${label}: ${names.join(', ')}`);
      return resolveNamedEntities(names, `TMDB ${singularLabel}`, async (name) => {
        const data = await moviedb.makeTmdbRequest('/search/person', ctx.tmdbApiKey, { query: name, page: 1, include_adult: false }, 'GET', null, config);
        const results = (data?.results || []).filter((r: any) => r?.id);
        const best = pickBestMatch(results, name);
        if (!best) return null;
        logger.debug(`[AI Catalog] ${singularLabel} "${name}" -> ID ${best.id} (${best.name})`);
        return { id: best.id, label: best.name || name };
      });
    };

    if (resolve.cast?.length) {
      const items = await resolveTmdbPeople(resolve.cast, 'cast', 'cast member');
      if (items.length) resolved.with_cast = items.map(i => i.id).join('|');
      if (items.length) resolved._formState_selectedPeople = JSON.stringify(items);
    }

    if (resolve.people?.length) {
      const items = await resolveTmdbPeople(resolve.people, 'people', 'person');
      if (items.length) resolved.with_people = items.map(i => i.id).join('|');
      if (items.length) resolved._formState_selectedPeople = JSON.stringify(items);
    }

    if (catalog.catalogType === 'series' && resolve.networks?.length) {
      const { resolveTmdbNetworkByName } = require('../lib/tmdb-network-index');
      logger.info(`[AI Catalog] Resolving TMDB networks: ${resolve.networks.join(', ')}`);
      const items = await resolveNamedEntities(resolve.networks, 'TMDB network', async (name) => {
        const network = await resolveTmdbNetworkByName(name);
        if (!network) return null;
        logger.debug(`[AI Catalog] Network "${name}" -> ID ${network.id} (${network.label})`);
        return network;
      });
      if (items.length) {
        resolved.with_networks = items.map(i => i.id).join('|');
        resolved._formState_withNetworks = JSON.stringify(items);
      }
    }

    if (resolve.watchProviders?.length) {
      const mediaType = catalog.mediaType === 'tv' ? 'tv' : 'movie';
      const region = String(catalog.params.watch_region || 'US').toUpperCase();
      if (!catalog.params.watch_region) catalog.params.watch_region = region;
      const providersData = await moviedb.getTmdbWatchProvidersForRegion(mediaType, region, config);
      const allProviders = providersData?.providers || [];
      const items: Array<{ id: number; label: string }> = [];
      for (const name of resolve.watchProviders) {
        const match = pickWatchProviderMatch(allProviders, name);
        if (match?.provider_id) {
          logger.debug(`[AI Catalog] Watch provider "${name}" -> ID ${match.provider_id} (${match.provider_name})`);
          items.push({ id: match.provider_id, label: match.provider_name || name });
        } else {
          const warning = `Could not resolve TMDB watch provider "${name}" for ${mediaType} in ${region}`;
          logger.warn(`[AI Catalog] ${warning}`);
          warnings.push(warning);
        }
      }
      if (items.length) {
        resolved.with_watch_providers = items.map(i => i.id).join('|');
        resolved.with_watch_monetization_types = 'flatrate|free|ads|rent|buy';
        resolved._formState_watchProviders = JSON.stringify(items);
      }
    }
  }

  if (catalog.source === 'anilist' && resolve.studios?.length) {
    const anilist = require('../lib/anilist');
    const items: Array<{ id: number; label: string }> = [];
    for (const name of resolve.studios) {
      try {
        const results = await anilist.searchStudios(name);
        logger.info(`[AI Catalog] AniList studio search "${name}": ${results?.length ?? 0} results${results?.[0] ? ` (top: ${results[0].name}, id: ${results[0].id})` : ''}`);
        if (results?.[0]?.id) items.push({ id: results[0].id, label: results[0].name || name });
      } catch (e: any) {
        logger.warn(`[AI Catalog] Failed to resolve AniList studio "${name}": ${e.message}`);
      }
    }
    if (items.length) {
      resolved.studios = items.map(i => i.id).join(',');
      resolved._formState_anilistSelectedStudios = JSON.stringify(items);
    }
  }

  if (catalog.source === 'mal' && resolve.producers?.length) {
    const JIKAN_API_BASE = process.env.JIKAN_API_BASE || 'https://api.jikan.moe/v4';
    const items: Array<{ id: number; label: string }> = [];
    for (const name of resolve.producers) {
      try {
        const url = `${JIKAN_API_BASE}/producers?q=${encodeURIComponent(name)}&limit=5&order_by=favorites&sort=desc`;
        const response = await httpGet(url, { timeout: 15000 });
        const firstResult = response.data?.data?.[0];
        if (firstResult?.mal_id) {
          const defaultTitle = firstResult.titles?.find((t: any) => t.type === 'Default');
          items.push({ id: firstResult.mal_id, label: defaultTitle?.title || firstResult.name || name });
        }
      } catch (e: any) {
        logger.warn(`Failed to resolve MAL producer "${name}": ${e.message}`);
      }
    }
    if (items.length) {
      resolved.producers = items.map(i => i.id).join(',');
      resolved._formState_malProducers = JSON.stringify(items);
    }
  }

  if (catalog.source === 'tvdb' && ctx.tvdbApiKey) {
    const tvdbApi = require('../lib/tvdb');
    const tvdbConfig = { apiKeys: { tvdb: ctx.tvdbApiKey }, ...(ctx.userUUID ? { userUUID: ctx.userUUID } : {}) };

    if (resolve.company?.length) {
      try {
        const searchData = await tvdbApi.searchCompanies(resolve.company[0], tvdbConfig);
        const results = Array.isArray(searchData) ? searchData : [];
        if (results[0]?.id) {
          resolved.company = String(results[0].id);
          resolved._formState_withCompanies = JSON.stringify([{ id: results[0].id, label: results[0].name || resolve.company[0] }]);
        }
      } catch (e: any) {
        logger.warn(`Failed to resolve TVDB company "${resolve.company[0]}": ${e.message}`);
      }
    }

    if (resolve.genre?.length) {
      try {
        const genres = await tvdbApi.getAllGenres(tvdbConfig);
        const val = resolve.genre[0];
        const asNum = Number(val);
        const match = Number.isFinite(asNum)
          ? genres.find((g: any) => g.id === asNum)
          : genres.find((g: any) => g.name?.toLowerCase() === val.toLowerCase());
        if (match?.id) {
          resolved.genre = String(match.id);
          resolved._formState_includeGenres = JSON.stringify([{ id: match.id, label: match.name }]);
        } else {
          logger.warn(`[AI Catalog] TVDB genre "${val}" not found`);
          warnings.push(`Could not resolve genre "${resolve.genre[0]}"`);
        }
      } catch (e: any) {
        logger.warn(`Failed to resolve TVDB genre "${resolve.genre[0]}": ${e.message}`);
      }
    }

    if (resolve.status?.length) {
      try {
        const tvdbType = catalog.catalogType === 'movie' ? 'movies' : 'series';
        const statuses = await tvdbApi.getStatuses(tvdbType, tvdbConfig);
        const val = resolve.status[0];
        const asNum = Number(val);
        const match = Number.isFinite(asNum)
          ? statuses.find((s: any) => s.id === asNum)
          : statuses.find((s: any) => s.name?.toLowerCase() === val.toLowerCase());
        if (match?.id != null) {
          resolved.status = String(match.id);
          resolved._formState_tvdbStatus = String(match.id);
        } else {
          logger.warn(`[AI Catalog] TVDB status "${val}" not found`);
          warnings.push(`Could not resolve status "${resolve.status[0]}"`);
        }
      } catch (e: any) {
        logger.warn(`Failed to resolve TVDB status "${resolve.status[0]}": ${e.message}`);
      }
    }

    if (resolve.contentRating?.length) {
      try {
        const ratings = await tvdbApi.getAllContentRatings(tvdbConfig);
        const val = resolve.contentRating[0];
        const asNum = Number(val);
        const match = Number.isFinite(asNum)
          ? ratings.find((r: any) => r.id === asNum)
          : ratings.find((r: any) => r.name?.toLowerCase() === val.toLowerCase());
        if (match?.id != null) {
          resolved.contentRating = String(match.id);
          resolved._formState_certificationValue = String(match.id);
        } else {
          logger.warn(`[AI Catalog] TVDB content rating "${val}" not found`);
          warnings.push(`Could not resolve content rating "${resolve.contentRating[0]}"`);
        }
      } catch (e: any) {
        logger.warn(`Failed to resolve TVDB content rating "${resolve.contentRating[0]}": ${e.message}`);
      }
    }
  }

  return { resolved, warnings };
}

async function resolveNamedEntities<T extends { id: number; label: string }>(
  names: any[],
  label: string,
  resolver: (name: any) => Promise<T | null>
): Promise<T[]> {
  const items: T[] = [];
  for (const name of names) {
    const displayName = typeof name === 'string' ? name : name?.name || name?.input || String(name);
    try {
      const result = await resolver(name);
      if (result) {
        items.push(result);
      } else {
        logger.warn(`[AI Catalog] Could not resolve ${label} "${displayName}" - no results`);
      }
    } catch (e: any) {
      logger.error(`[AI Catalog] Failed to resolve ${label} "${displayName}": ${e.message}`);
    }
  }
  return items;
}
