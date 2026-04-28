import consola from 'consola';
const logger = consola.withTag('CatalogFilters');

function isHideWatchedExcluded(cleanId: string): boolean {
  return ['search', 'people_search', 'gemini.search'].includes(cleanId)
    || cleanId.includes('watchlist')
    || cleanId.includes('favorites')
    || cleanId.includes('up_next')
    || cleanId.includes('upnext');
}

const movieRatingHierarchy = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
const tvRatingHierarchy = ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'];
const movieToTvMap: Record<string, string> = {
  'G': 'TV-G',
  'PG': 'TV-PG',
  'PG-13': 'TV-14',
  'R': 'TV-MA',
  'NC-17': 'TV-MA'
};

function applyAgeRatingFilter(metas: any[], type: string, config: any): any[] {
  if (!config.ageRating || config.ageRating.toLowerCase() === 'none') {
    return metas;
  }

  const isTvRating = type === 'series';
  const finalUserRating = isTvRating ? (movieToTvMap[config.ageRating] || config.ageRating) : config.ageRating;
  const ratingHierarchy = isTvRating ? tvRatingHierarchy : movieRatingHierarchy;
  const userRatingIndex = ratingHierarchy.indexOf(finalUserRating);

  if (userRatingIndex === -1) return metas;

  const isUserRatingRestrictive = finalUserRating === 'PG-13' ||
    (movieRatingHierarchy.indexOf(finalUserRating) !== -1 &&
      movieRatingHierarchy.indexOf(finalUserRating) <= movieRatingHierarchy.indexOf('PG-13')) ||
    (tvRatingHierarchy.indexOf(finalUserRating) !== -1 &&
      tvRatingHierarchy.indexOf(finalUserRating) <= tvRatingHierarchy.indexOf('TV-14'));

  const before = metas.length;
  const filtered = metas.filter(meta => {
    const cert = meta.app_extras?.certification || null;

    if (!cert || cert === '' || cert.toLowerCase() === 'nr') {
      return !isUserRatingRestrictive;
    }

    const resultRatingIndex = ratingHierarchy.indexOf(cert);
    if (resultRatingIndex === -1) return true;

    return resultRatingIndex <= userRatingIndex;
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

async function applyCatalogFilters(metas: any[], { type, config, catalogConfig, cleanId }: CatalogFilterOptions): Promise<any[]> {
  if (!Array.isArray(metas) || metas.length === 0) return metas;

  metas = applyAgeRatingFilter(metas, type, config);

  const isSearch = ['search', 'people_search', 'gemini.search'].includes(cleanId);
  const hideWatchedExcluded = isHideWatchedExcluded(cleanId);

  if ((isSearch ? config.hideUnreleasedDigitalSearch : config.hideUnreleasedDigital)) {
    const { isReleasedDigitally } = require('./parseProps');
    const before = metas.length;
    metas = metas.filter(meta => meta.type !== 'movie' || isReleasedDigitally(meta));
    if (before !== metas.length) {
      logger.debug(`Digital release filter: removed ${before - metas.length} unreleased movies`);
    }
  }

  if (metas.length > 0 && config.apiKeys?.traktTokenId) {
    const globalHide = !!config.hideWatchedTrakt;
    const catalogHide = catalogConfig?.metadata?.hideWatchedTrakt;
    const shouldHide = catalogHide !== undefined ? catalogHide : globalHide;
    if (shouldHide && !hideWatchedExcluded) {
      try {
        const { getTraktWatchedIds } = require('./traktUtils');
        const watchedIds = await getTraktWatchedIds(config);
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

  if (metas.length > 0 && config.apiKeys?.anilistTokenId) {
    const globalHide = !!config.hideWatchedAnilist;
    const catalogHide = catalogConfig?.metadata?.hideWatchedAnilist;
    const shouldHide = catalogHide !== undefined ? catalogHide : globalHide;
    if (shouldHide && !hideWatchedExcluded) {
      try {
        const { getAnilistWatchedIds } = require('./anilistUtils');
        const idMapper = require('../lib/id-mapper');
        const watchedIds = await getAnilistWatchedIds(config);
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

  if (metas.length > 0 && config.apiKeys?.mdblist) {
    const globalHide = !!config.hideWatchedMdblist;
    const catalogHide = catalogConfig?.metadata?.hideWatchedMdblist;
    const shouldHide = catalogHide !== undefined ? catalogHide : globalHide;
    if (shouldHide && !hideWatchedExcluded) {
      try {
        const { getMdblistWatchedIds } = require('./mdblistUtils');
        const watchedIds = await getMdblistWatchedIds(config);
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

module.exports = { applyCatalogFilters };
