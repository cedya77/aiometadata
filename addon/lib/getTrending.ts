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
        // Fallback info for region filter on series when TMDB doesn't expose 'released' in meta
        if (type === 'series') {
          // Use TMDB item fields as fallback
          if (item?.first_air_date) {
            result.meta.app_extras.firstAirDate = item.first_air_date;
          }
          if (Array.isArray(item?.origin_country) && item.origin_country.length > 0) {
            result.meta.app_extras.originCountries = item.origin_country;
          }
        }
            
        return result.meta;
      }
      return null;
    }));
    const metasTime = performance.now() - metasStartTime;
    const validMetas = metas.filter(meta => meta !== null);
    logger.debug(`[getTrending] ${validMetas.length} Metas processing took ${metasTime.toFixed(2)}ms`);

    // Apply Region Filter (per-catalog toggle) for TMDB trending
    try {
      const catalogConfig = Array.isArray((config as any).catalogs)
        ? (config as any).catalogs.find((c: any) => c.id === 'tmdb.trending' && c.type === type)
        : null;
      // Applicare region filter solo per i film
      if (catalogConfig?.regionFilterEnabled && type === 'movie') {
        const langParts = language.split('-');
        const regionCode = (langParts[1] || langParts[0]).toUpperCase();
        const tz = (process.env.TZ || 'UTC');
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        const allowedTypes = new Set([3, 4, 5, 6]); // Theatrical, Digital, Physical, TV
        const beforeCount = validMetas.length;
        logger.info(`[Trending Region Filter] Start: region=${regionCode}, items=${beforeCount}, date<=${today}`);
        // Movies: require a release in region with allowed type and date <= today
        const regionFilteredMetas = validMetas.filter(meta => {
          const results = meta?.app_extras?.releaseDates?.results;
          if (Array.isArray(results)) {
            const entry = results.find((r: any) => (r.iso_3166_1 || '').toUpperCase() === regionCode);
            if (entry && Array.isArray(entry.release_dates)) {
              return entry.release_dates.some((rd: any) => {
                const dateStr = (rd.release_date || '').substring(0, 10);
                return !!dateStr && allowedTypes.has(rd.type) && dateStr <= today;
              });
            }
          }
          return false;
        });
        const afterCount = regionFilteredMetas.length;
        logger.info(`[Trending Region Filter] End: filtered ${beforeCount} -> ${afterCount} items (region=${regionCode})`);
        // Use region-filtered list for subsequent filters
        validMetas.splice(0, validMetas.length, ...regionFilteredMetas);
      }
    } catch (e: any) {
      logger.warn(`[Trending Region Filter] Skipped due to error: ${e.message}`);
    }

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
