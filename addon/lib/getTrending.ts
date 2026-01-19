require("dotenv").config();
import * as moviedb from "./getTmdb.js";
import * as Utils from '../utils/parseProps.js';
import { getMeta } from './getMeta.js';
import { cacheWrapMetaSmart } from './getCache.js';
import { UserConfig } from '../types/index.js';
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
    let preferredProvider;
    if (type === 'movie') {
      preferredProvider = config.providers?.movie || 'tmdb';
    } else {
      preferredProvider = config.providers?.series || 'tvdb';
    }

    const metas = await Promise.all((res?.results || []).map(async (item: any) => {
      let stremioId = `tmdb:${item.id}`;
      const result =  await cacheWrapMetaSmart(userUUID, stremioId, async () => {
        return await getMeta(type, language, stremioId, config, userUUID, includeVideos);
      }, undefined, {enableErrorCaching: true, maxRetries: 2}, type as any, includeVideos);
      
      if (result && result.meta) {
        
        const certifications: any = type === 'movie' 
            ? await moviedb.getMovieCertifications({ id: item.id }, config) 
            : await moviedb.getTvCertifications({ id: item.id }, config);
        result.meta.app_extras = result.meta.app_extras || {};
        result.meta.app_extras.certification = type === 'movie' 
            ? Utils.getTmdbMovieCertificationForCountry(certifications) 
            : Utils.getTmdbTvCertificationForCountry(certifications);
            
        return result.meta;
      }
      return null;
    }));
    const metasTime = performance.now() - metasStartTime;
    const validMetas = metas.filter(meta => meta !== null);
    logger.debug(`[getTrending] ${validMetas.length} Metas processing took ${metasTime.toFixed(2)}ms`);

    const movieRatingHierarchy = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
    const tvRatingHierarchy = ["TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA"];
    
    const movieToTvMap: { [key: string]: string } = {
      'G': 'TV-G',
      'PG': 'TV-PG', 
      'PG-13': 'TV-14',
      'R': 'TV-MA',
      'NC-17': 'TV-MA'
    };
    
    const userRating = config.ageRating;
    let filteredMetas = validMetas;
    
    if (userRating && userRating.toLowerCase() !== 'none') {
      const isTvRating = type === 'series';
      const finalUserRating = isTvRating ? (movieToTvMap[userRating] || userRating) : userRating;
      const ratingHierarchy = isTvRating ? tvRatingHierarchy : movieRatingHierarchy;
      const userRatingIndex = ratingHierarchy.indexOf(finalUserRating);

      if (userRatingIndex !== -1) {
        const beforeCount = filteredMetas.length;
        const filterStartTime = performance.now();
        
        filteredMetas = validMetas.filter(meta => {
          const cert = meta.app_extras?.certification;
          
          // If rating is PG-13 or lower, exclude items without certification as they could be inappropriate
          const isUserRatingRestrictive = finalUserRating === 'PG-13' || 
                                         (movieRatingHierarchy.indexOf(finalUserRating) !== -1 && 
                                          movieRatingHierarchy.indexOf(finalUserRating) <= movieRatingHierarchy.indexOf('PG-13')) ||
                                         (tvRatingHierarchy.indexOf(finalUserRating) !== -1 && 
                                          tvRatingHierarchy.indexOf(finalUserRating) <= tvRatingHierarchy.indexOf('TV-14'));
          
          if (!cert || cert === "" || cert.toLowerCase() === 'nr') {
            return !isUserRatingRestrictive; // Exclude items without certification if user rating is restrictive
          }
          
          const resultRatingIndex = ratingHierarchy.indexOf(cert);

          if (resultRatingIndex === -1) {
            return true;
          }
          
          return resultRatingIndex <= userRatingIndex;
        });

        const afterCount = filteredMetas.length;
        const filterTime = performance.now() - filterStartTime;
        if (beforeCount !== afterCount) {
          logger.debug(`[getTrending] Age rating filter removed ${beforeCount - afterCount} items in ${filterTime.toFixed(2)}ms`);
        }
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