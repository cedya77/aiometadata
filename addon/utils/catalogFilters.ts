import consola from 'consola';
import { allowsUnrated, hasAgeRatingCap, passesAgeRating } from './ageRating';
import { trackerConfig } from '../lib/accounts';
const logger = consola.withTag('CatalogFilters');

function isHideWatchedExcluded(cleanId: string): boolean {
  return ['search', 'people_search', 'gemini.search'].includes(cleanId)
    || cleanId.includes('watchlist')
    || cleanId.includes('favorites')
    || cleanId.includes('up_next')
    || cleanId.includes('upnext')
    || cleanId.includes('completed')
    || cleanId.includes('history');
}

const UNRELEASED_STATUSES = new Set([
  'not yet aired', 'upcoming', 'not_yet_released', 'planned', 'unreleased', 'tba',
]);

function applyAgeRatingFilter(metas: any[], type: string, config: any): any[] {
  if (!hasAgeRatingCap(config)) {
    return metas;
  }

  const allowUnrated = allowsUnrated(config);
  const before = metas.length;
  const filtered = metas.filter(meta => {
    const cert = meta.app_extras?.certification || meta.certification || null;
    return passesAgeRating(cert, meta.type || type, config.ageRating, allowUnrated);
  });

  if (before !== filtered.length) {
    logger.info(`[AgeRating] Filtered out ${before - filtered.length} items (max: ${config.ageRating})`);
  }
  return filtered;
}

interface CatalogFilterOptions {
  type: string;
  config: any;
  catalogConfig: any;
  cleanId: string;
}

const WATCHED_FILTERS: [string, string][] = [
  ['traktTokenId', 'hideWatchedTrakt'],
  ['anilistTokenId', 'hideWatchedAnilist'],
  ['mdblist', 'hideWatchedMdblist'],
  ['simklTokenId', 'hideWatchedSimkl'],
];

function watchedConfig(config: any): any {
  const own = trackerConfig(config);
  return config?.jellyfinAccounts ? { ...own, apiKeys: { ...own.apiKeys, traktTokenId: undefined } } : own;
}

function catalogFiltersActive({ config, catalogConfig, cleanId }: Omit<CatalogFilterOptions, 'type'>): boolean {
  const isSearch = ['search', 'people_search', 'gemini.search'].includes(cleanId);

  if (hasAgeRatingCap(config)) return true;

  const catalogHideDigital = catalogConfig?.metadata?.hideUnreleasedDigital;
  const hideUnreleasedDigital = isSearch
    ? !!config.hideUnreleasedDigitalSearch
    : (catalogHideDigital !== undefined ? catalogHideDigital : !!config.hideUnreleasedDigital);
  if (hideUnreleasedDigital) return true;

  const catalogHideShows = catalogConfig?.metadata?.hideUnreleasedShows;
  const hideUnreleasedShows = isSearch
    ? !!config.hideUnreleasedShowsSearch
    : (catalogHideShows !== undefined ? catalogHideShows : !!config.hideUnreleasedShows);
  if (hideUnreleasedShows) return true;

  if (!isHideWatchedExcluded(cleanId)) {
    const tracked = watchedConfig(config);
    for (const [credential, flag] of WATCHED_FILTERS) {
      if (!tracked.apiKeys?.[credential]) continue;
      const catalogHide = catalogConfig?.metadata?.[flag];
      if (catalogHide !== undefined ? catalogHide : !!config[flag]) return true;
    }
  }

  return Boolean(config.exclusionKeywords || config.regexExclusionFilter || config.exclusionGenres || excludedTmdbKeywords(config).size);
}

function excludedTmdbKeywords(config: any): Set<string> {
  const list = Array.isArray(config?.exclusionTmdbKeywords) ? config.exclusionTmdbKeywords : [];
  return new Set(list.map((keyword: unknown) => String(keyword).trim().toLowerCase()).filter(Boolean));
}

async function applyCatalogFilters(metas: any[], { type, config, catalogConfig, cleanId }: CatalogFilterOptions): Promise<any[]> {
  if (!Array.isArray(metas) || metas.length === 0) return metas;

  const isSearch = ['search', 'people_search', 'gemini.search'].includes(cleanId);

  metas = applyAgeRatingFilter(metas, type, config);
  const hideWatchedExcluded = isHideWatchedExcluded(cleanId);
  // A Jellyfin user with accounts of their own hides what they watched, not what you did.
  const tracked = watchedConfig(config);

  const catalogHideDigital = catalogConfig?.metadata?.hideUnreleasedDigital;
  const hideUnreleasedDigital = isSearch
    ? !!config.hideUnreleasedDigitalSearch
    : (catalogHideDigital !== undefined ? catalogHideDigital : !!config.hideUnreleasedDigital);

  if (hideUnreleasedDigital) {
    const { isReleasedDigitally } = require('./parseProps');
    const before = metas.length;
    metas = metas.filter(meta => meta.type !== 'movie' || isReleasedDigitally(meta));
    if (before !== metas.length) {
      logger.debug(`Digital release filter: removed ${before - metas.length} unreleased movies`);
    }
  }

  const catalogHideShows = catalogConfig?.metadata?.hideUnreleasedShows;
  const hideUnreleasedShows = isSearch
    ? !!config.hideUnreleasedShowsSearch
    : (catalogHideShows !== undefined ? catalogHideShows : !!config.hideUnreleasedShows);

  if (hideUnreleasedShows) {
    const now = new Date();
    const before = metas.length;
    metas = metas.filter(meta => {
      if (meta.type !== 'series') return true;
      if (UNRELEASED_STATUSES.has(String(meta.status || '').toLowerCase())) return false;
      if (!meta.released) return true;
      return new Date(meta.released) <= now;
    });
    if (before !== metas.length) {
      logger.debug(`Unreleased shows filter: removed ${before - metas.length} unreleased series`);
    }
  }

  if (metas.length > 0 && tracked.apiKeys?.traktTokenId) {
    const globalHide = !!config.hideWatchedTrakt;
    const catalogHide = catalogConfig?.metadata?.hideWatchedTrakt;
    const shouldHide = catalogHide !== undefined ? catalogHide : globalHide;
    if (shouldHide && !hideWatchedExcluded) {
      try {
        const { getTraktWatchedIds } = require('./traktUtils');
        const watchedIds = await getTraktWatchedIds(tracked);
        if (watchedIds) {
          const actualType = catalogConfig?.type || type;
          const before = metas.length;
          metas = metas.filter(meta => {
            const metaId = meta.id || '';
            const isMovie = (meta.type || actualType) === 'movie';
            const idSet = isMovie ? watchedIds.movieImdbIds : watchedIds.showImdbIds;
            if (metaId.startsWith('tt') && idSet.has(metaId)) return false;
            if (meta.imdb_id && idSet.has(meta.imdb_id)) return false;
            return true;
          });
          if (before !== metas.length) {
            logger.debug(`Hide Trakt watched: removed ${before - metas.length} items`);
          }
        }
      } catch (err: any) {
        logger.warn(`Hide Trakt watched filter error: ${err.message}`);
      }
    }
  }

  if (metas.length > 0 && tracked.apiKeys?.anilistTokenId) {
    const globalHide = !!config.hideWatchedAnilist;
    const catalogHide = catalogConfig?.metadata?.hideWatchedAnilist;
    const shouldHide = catalogHide !== undefined ? catalogHide : globalHide;
    if (shouldHide && !hideWatchedExcluded) {
      try {
        const { getAnilistWatchedIds } = require('./anilistUtils');
        const idMapper = require('../lib/id-mapper');
        const watchedIds = await getAnilistWatchedIds(tracked);
        if (watchedIds) {
          const before = metas.length;
          metas = metas.filter(meta => {
            const metaId = meta.id || '';
            let anilistId: number | null = null;
            let malId: number | null = null;
            if (metaId.startsWith('anilist:')) {
              anilistId = parseInt(metaId.split(':')[1], 10);
            } else if (metaId.startsWith('mal:')) {
              malId = parseInt(metaId.split(':')[1], 10);
            } else if (metaId.startsWith('kitsu:')) {
              const mapping = idMapper.getMappingByKitsuId(parseInt(metaId.split(':')[1], 10));
              if (mapping) {
                anilistId = mapping.anilist_id;
                malId = mapping.mal_id;
              }
            } else if (metaId.startsWith('anidb:')) {
              const mapping = idMapper.getMappingByAnidbId(parseInt(metaId.split(':')[1], 10));
              if (mapping) {
                anilistId = mapping.anilist_id;
                malId = mapping.mal_id;
              }
            }
            if (anilistId && watchedIds.anilistIds.has(anilistId)) return false;
            if (malId && watchedIds.malIds.has(malId)) return false;
            return true;
          });
          if (before !== metas.length) {
            logger.debug(`Hide AniList watched: removed ${before - metas.length} items`);
          }
        }
      } catch (err: any) {
        logger.warn(`Hide AniList watched filter error: ${err.message}`);
      }
    }
  }

  if (metas.length > 0 && tracked.apiKeys?.mdblist) {
    const globalHide = !!config.hideWatchedMdblist;
    const catalogHide = catalogConfig?.metadata?.hideWatchedMdblist;
    const shouldHide = catalogHide !== undefined ? catalogHide : globalHide;
    if (shouldHide && !hideWatchedExcluded) {
      try {
        const { getMdblistWatchedIds } = require('./mdblistUtils');
        const watchedIds = await getMdblistWatchedIds(tracked);
        if (watchedIds) {
          const actualType = catalogConfig?.type || type;
          const before = metas.length;
          metas = metas.filter(meta => {
            const metaId = meta.id || '';
            const isMovie = (meta.type || actualType) === 'movie';
            const idSet = isMovie ? watchedIds.movieImdbIds : watchedIds.showImdbIds;
            if (metaId.startsWith('tt') && idSet.has(metaId)) return false;
            if (meta.imdb_id && idSet.has(meta.imdb_id)) return false;
            return true;
          });
          if (before !== metas.length) {
            logger.debug(`Hide MDBList watched: removed ${before - metas.length} items`);
          }
        }
      } catch (err: any) {
        logger.warn(`Hide MDBList watched filter error: ${err.message}`);
      }
    }
  }

  if (metas.length > 0 && tracked.apiKeys?.simklTokenId) {
    const globalHide = !!config.hideWatchedSimkl;
    const catalogHide = catalogConfig?.metadata?.hideWatchedSimkl;
    const shouldHide = catalogHide !== undefined ? catalogHide : globalHide;
    if (shouldHide && !hideWatchedExcluded) {
      try {
        const { getSimklWatchedIds } = require('./simklUtils');
        const idMapper = require('../lib/id-mapper');
        const watchedIds = await getSimklWatchedIds(tracked);
        if (watchedIds) {
          const actualType = catalogConfig?.type || type;
          const before = metas.length;
          metas = metas.filter(meta => {
            const metaId = meta.id || '';
            const isMovie = (meta.type || actualType) === 'movie';
            const idSet = isMovie ? watchedIds.movieImdbIds : watchedIds.showImdbIds;
            if (metaId.startsWith('tt') && idSet.has(metaId)) return false;
            if (meta.imdb_id && idSet.has(meta.imdb_id)) return false;

            let anilistId: number | null = null;
            let malId: number | null = null;
            if (metaId.startsWith('anilist:')) {
              anilistId = parseInt(metaId.split(':')[1], 10);
            } else if (metaId.startsWith('mal:')) {
              malId = parseInt(metaId.split(':')[1], 10);
            } else if (metaId.startsWith('kitsu:')) {
              const mapping = idMapper.getMappingByKitsuId(parseInt(metaId.split(':')[1], 10));
              if (mapping) {
                anilistId = mapping.anilist_id;
                malId = mapping.mal_id;
              }
            } else if (metaId.startsWith('anidb:')) {
              const mapping = idMapper.getMappingByAnidbId(parseInt(metaId.split(':')[1], 10));
              if (mapping) {
                anilistId = mapping.anilist_id;
                malId = mapping.mal_id;
              }
            }
            if (malId && watchedIds.malIds.has(malId)) return false;
            if (anilistId && watchedIds.anilistIds.has(anilistId)) return false;
            return true;
          });
          if (before !== metas.length) {
            logger.debug(`Hide Simkl watched: removed ${before - metas.length} items`);
          }
        }
      } catch (err: any) {
        logger.warn(`Hide Simkl watched filter error: ${err.message}`);
      }
    }
  }

  const blockedKeywords = excludedTmdbKeywords(config);
  if (blockedKeywords.size) {
    const before = metas.length;
    metas = metas.filter((meta: any) =>
      !(Array.isArray(meta?.keywords) && meta.keywords.some((keyword: unknown) => blockedKeywords.has(String(keyword).toLowerCase())))
    );
    if (before !== metas.length) {
      logger.debug(`TMDB keyword filter: removed ${before - metas.length} items`);
    }
  }

  if (config.exclusionKeywords || config.regexExclusionFilter || config.exclusionGenres) {
    const { filterMetasByRegex } = require('./regexFilter');
    const before = metas.length;
    metas = filterMetasByRegex(metas, config.exclusionKeywords || '', config.regexExclusionFilter || '', config.exclusionGenres || '');
    if (before !== metas.length) {
      logger.debug(`Content exclusion filter: removed ${before - metas.length} items`);
    }
  }

  return metas;
}

module.exports = { applyCatalogFilters, catalogFiltersActive };
