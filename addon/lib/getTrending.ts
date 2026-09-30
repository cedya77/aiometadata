require("dotenv").config();
import * as moviedb from "./getTmdb.js";
import { getMeta } from './getMeta.js';
import { cacheWrapMetaSmart } from './getCache.js';
import { UserConfig } from '../types/index.js';
import { allowsUnrated, hasAgeRatingCap, isUnratedCertification, passesAgeRating } from '../utils/ageRating.js';
import { applyContentRatingDisplay, getContentRatingCountry, resolveContentRating } from '../utils/contentRating.js';
import * as Utils from '../utils/parseProps.js';
const consola = require('consola');

const logger = consola.withTag('GetTrending'); 

async function getTrending(type: string, language: string, page: number, genre: string, config: UserConfig, userUUID: string, includeVideos: boolean = false): Promise<{ metas: any[] }> {
  const startTime = performance.now();
  try {
    logger.debug(`[getTrending] Fetching trending for type=${type}, language=${language}, page=${page}, genre=${genre}`);
    const media_type = type === "series" ? "tv" : type;
    const time_window = genre && ['day', 'week'].includes(genre.toLowerCase()) ? genre.toLowerCase() : "day";
    
    const parameters = { media_type, time_window, language, page };
    
    const tmdbStartTime = performance.now();
    const res: any = await moviedb.trending(parameters, config);
    const tmdbTime = performance.now() - tmdbStartTime;
    logger.debug(`[getTrending] TMDB trending fetch took ${tmdbTime.toFixed(2)}ms`);
    
    const metasStartTime = performance.now();
    const metas = await Promise.all((res?.results || []).map(async (item: any) => {
      let stremioId = `tmdb:${item.id}`;
      const result =  await cacheWrapMetaSmart(userUUID, stremioId, async () => {
        return await getMeta(type, language, stremioId, config, userUUID, includeVideos);
      }, undefined, {enableErrorCaching: true, maxRetries: 2, config}, type as any, includeVideos);
      
      if (result && result.meta) {
        
        const meta = result.meta;
        const extras = meta.app_extras || {};
        const rating = extras.contentRating;
        const nativeAnimeRating = rating?.source === 'mal' || rating?.source === 'kitsu';
        const missingUS = isUnratedCertification(extras.certification);
        const missingLocal = getContentRatingCountry(config) !== 'US'
          && (!rating || rating.isFallback) && rating?.source !== 'tmdb';
        // The trending item supplies a TMDB id even when the metadata provider's
        // cross-provider mapping does not. Fill gaps without replacing native ratings.
        if (!nativeAnimeRating && (missingUS || missingLocal)) {
          try {
            const certifications = type === 'movie'
              ? await moviedb.getMovieCertifications({ id: item.id }, config)
              : await moviedb.getTvCertifications({ id: item.id }, config);
            const country = getContentRatingCountry(config);
            const read = type === 'movie' ? Utils.getTmdbMovieCertificationForCountry : Utils.getTmdbTvCertificationForCountry;
            const enriched = resolveContentRating(config, type, { tmdb: { us: read(certifications), local: read(certifications, country) } });
            if (missingUS && enriched.certification) extras.certification = enriched.certification;
            if (enriched.contentRating && (!rating || (rating.isFallback && !enriched.contentRating.isFallback))) {
              extras.contentRating = enriched.contentRating;
            }
            meta.app_extras = extras;
          } catch (error: any) {
            logger.debug(`[getTrending] Rating enrichment failed for TMDB ${item.id}: ${error.message}`);
          }
        }
        return applyContentRatingDisplay(meta, config);
      }
      return null;
    }));
    const metasTime = performance.now() - metasStartTime;
    const validMetas = metas.filter(meta => meta !== null);
    logger.debug(`[getTrending] ${validMetas.length} Metas processing took ${metasTime.toFixed(2)}ms`);

    const userRating = config.ageRating;
    let filteredMetas = validMetas;

    if (hasAgeRatingCap(config)) {
      const allowUnrated = allowsUnrated(config);
      const beforeCount = filteredMetas.length;
      const filterStartTime = performance.now();

      filteredMetas = validMetas.filter(meta =>
        passesAgeRating(meta.app_extras?.certification, type, userRating, allowUnrated)
      );

      const afterCount = filteredMetas.length;
      const filterTime = performance.now() - filterStartTime;
      if (beforeCount !== afterCount) {
        logger.debug(`[getTrending] Age rating filter removed ${beforeCount - afterCount} items in ${filterTime.toFixed(2)}ms`);
      }
    } else {
      logger.debug(`[getTrending] No age rating filtering applied (ageRating: ${userRating})`);
    }
    
    const totalTime = performance.now() - startTime;
    logger.debug(`[getTrending] Total function execution took ${totalTime.toFixed(2)}ms`);
    
    return { metas: filteredMetas };

  } catch (error: any) {
    console.error(`Error fetching trending for type=${type}:`, error.message);
    return { metas: [] };
  }
}

export { getTrending };
