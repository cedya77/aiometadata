require("dotenv").config();
import * as moviedb from "./getTmdb.js";
import * as Utils from '../utils/parseProps.js';
import { resolveAllIds } from './id-resolver.js';
import { getMeta } from './getMeta.js';
import { cacheWrapMetaSmart } from './getCache.js';
import { UserConfig } from '../types/index.js';
import { isReleasedDigitally } from "../utils/parseProps.js";

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

const host = process.env.HOST_NAME?.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;

async function getTrending(type: string, language: string, page: number, genre: string, config: UserConfig, userUUID: string): Promise<{ metas: any[] }> {
  const startTime = performance.now();
  try {
    console.log(`[getTrending] Fetching trending for type=${type}, language=${language}, page=${page}, genre=${genre}`);
    const media_type = type === "series" ? "tv" : type;
    const time_window = genre && ['day', 'week'].includes(genre.toLowerCase()) ? genre.toLowerCase() : "day";
    
    const parameters = { media_type, time_window, language, page };
    //const genreList = await getGenreList(language, type);
    
    const tmdbStartTime = performance.now();
    const res: any = await moviedb.trending(parameters, config);
    const tmdbTime = performance.now() - tmdbStartTime;
    console.log(`[getTrending] TMDB trending fetch took ${tmdbTime.toFixed(2)}ms`);
    const metasStartTime = performance.now();
    let preferredProvider;
    if (type === 'movie') {
      preferredProvider = config.providers?.movie || 'tmdb';
    } else {
      preferredProvider = config.providers?.series || 'tvdb';
    }

    const metas = await Promise.all(res.results.map(async (item: any) => {
      let stremioId = `tmdb:${item.id}`;
      const result =  await cacheWrapMetaSmart(userUUID, stremioId, async () => {
        return await getMeta(type, language, stremioId, config, userUUID, false);
      }, undefined, {enableErrorCaching: true, maxRetries: 2}, type as any, false);
      
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
    console.log(`[getTrending] ${validMetas.length} Metas processing took ${metasTime.toFixed(2)}ms`);


    const movieRatingHierarchy = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
    const tvRatingHierarchy = ["TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA"];
    
    // Pre-compute rating mappings and indices for performance
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
      const filterStartTime = performance.now();
      filteredMetas = metas.filter(meta => {
        
        if (!meta.certification) {
          return true;
        }
        
        const resultRatingIndex = ratingHierarchy.indexOf(meta.certification);
        if (userRatingIndex !== -1 && resultRatingIndex !== -1) {
          return resultRatingIndex <= userRatingIndex;
        }
        
        // If result rating is not in hierarchy (like NR), filter it out when age filtering is enabled
        if (resultRatingIndex === -1) {
          return false;
        }
        
        return true;
      });
      
      const filterTime = performance.now() - filterStartTime;
      console.log(`[getTrending] ${filteredMetas.length} Age rating filtering took ${filterTime.toFixed(2)}ms`);
    } else {
      console.log(`[getTrending] No age rating filtering applied (ageRating: ${userRating})`);
    }

    // Apply digital release filter if enabled (movies only)
    if (type === 'movie' && config.hideUnreleasedDigital) {
      const beforeCount = filteredMetas.length;
      filteredMetas = filteredMetas.filter(meta => isReleasedDigitally(meta));
      const afterCount = filteredMetas.length;
      if (beforeCount !== afterCount) {
        console.log(`Digital release filter: filtered out ${beforeCount - afterCount} unreleased movies`);
      }
    }
    
    const totalTime = performance.now() - startTime;
    console.log(`[getTrending] Total function execution took ${totalTime.toFixed(2)}ms`);
    
    return { metas: filteredMetas };

  } catch (error: any) {
    console.error(`Error fetching trending for type=${type}:`, error.message);
    return { metas: [] };
  }
}

export { getTrending };
