// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE

const { buildProxyArtUrl } = require('./posterCache/proxyArt.js');
const posterCacheConfig = require('./posterCache/config.js');

function extractIdsFromWarmerMeta(meta) {
  const ids = {};
  if (!meta) return ids;
  const id = meta.id || '';
  if (id) ids.id = id;
  if (id.startsWith('tmdb:')) ids.tmdbId = id.slice(5);
  else if (id.startsWith('tvdb:')) ids.tvdbId = id.slice(5);
  else if (id.startsWith('kitsu:')) ids.kitsuId = id.slice(6);
  else if (id.startsWith('mal:')) ids.malId = id.slice(4);
  else if (id.startsWith('anilist:')) ids.anilistId = id.slice(8);
  else if (id.startsWith('anidb:')) ids.anidbId = id.slice(6);
  else if (id.startsWith('tt')) ids.imdbId = id;
  if (meta.imdb_id) ids.imdbId = meta.imdb_id;
  if (meta._tmdbId && !ids.tmdbId) ids.tmdbId = meta._tmdbId;
  if (meta._tvdbId && !ids.tvdbId) ids.tvdbId = meta._tvdbId;
  if (meta._imdbId && !ids.imdbId) ids.imdbId = meta._imdbId;
  if (meta._malId && !ids.malId) ids.malId = meta._malId;
  if (meta._kitsuId && !ids.kitsuId) ids.kitsuId = meta._kitsuId;
  if (meta._anilistId && !ids.anilistId) ids.anilistId = meta._anilistId;
  if (meta._anidbId && !ids.anidbId) ids.anidbId = meta._anidbId;
  return ids;
}

/**
 * `deps` exists so this can be exercised without `parseProps`, which reaches
 * Redis, the TMDB/MAL/TVmaze agents and the rest of the metadata stack at require
 * time. Production passes nothing and gets the real resolvers.
 */
function collectWarmupTargets(metas, config, fallbackType, deps) {
  const {
    resolveCustomArtUrl,
    resolvePosterPattern,
    resolveLandscapePattern,
    posterShapeOf,
    resolveProxyRatingPosterUrl,
    getPosterRatingApiKey,
    isRatingPostersEnabled,
  } = deps || require('../utils/parseProps');

  const ratingPostersEnabled = isRatingPostersEnabled(config);
  const posterPattern = ratingPostersEnabled ? resolvePosterPattern(config) : null;
  const proxyApiKey = ratingPostersEnabled && config.usePosterProxy ? getPosterRatingApiKey(config) : null;
  const proxyArtBase = posterCacheConfig.getProxyArtWarmBase();
  const cacheProcessed = posterCacheConfig.isClassEnabled('processed');
  const cachePosters = posterCacheConfig.isClassEnabled('poster');
  const language = config.language || 'en-US';
  const selfOrigin = posterCacheConfig.getSelfOrigin();
  const metaFieldClasses = posterCacheConfig.META_FIELD_CLASSES;
  const cacheThumbnails = posterCacheConfig.isClassEnabled('thumbnail');
  const cacheableFields = new Set(posterCacheConfig.getCacheableFields());
  if (cacheThumbnails) cacheableFields.add('thumbnail');
  const cacheCast = posterCacheConfig.isClassEnabled('cast');
  if (cacheCast) cacheableFields.add('cast');
  const customArtPatterns = {
    background: config.customBackgroundUrlPattern,
    landscapePoster: resolveLandscapePattern(config, posterPattern),
    logo: config.customLogoUrlPattern,
  };

  const targets = [];
  const addThirdParty = (url, imageClass, field) => {
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
    if (selfOrigin && url.startsWith(selfOrigin)) return;
    if (!cacheableFields.has(field || imageClass)) return;
    targets.push({ imageClass, url });
  };
  // A rendered target without a check key is refetched on every run, so an origin
  // URL it can be looked up by is required rather than optional.
  const addRendered = (url, imageClass, checkClass, checkKey) => {
    if (!url || !checkKey) return;
    targets.push({ imageClass, url, http: url, checkClass, checkKey });
  };

  for (const meta of metas) {
    const ids = extractIdsFromWarmerMeta(meta);
    const type = meta.type || fallbackType;
    const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));

    let posterWarmed = false;
    if (posterPattern && proxyId) {
      if (proxyApiKey) {
        const origin = resolveProxyRatingPosterUrl(type, proxyId, language, proxyApiKey, meta.poster);
        if (proxyArtBase && cacheProcessed && origin && !posterCacheConfig.isBypassed(origin)) {
          addRendered(
            buildProxyArtUrl({ base: proxyArtBase, imageClass: 'poster', type: type, id: proxyId, fallback: meta.poster, ratingKey: proxyApiKey, lang: language }),
            'poster',
            'processed',
            `rating-poster:${origin}`
          );
        }
        posterWarmed = true;
      } else {
        const resolved = resolveCustomArtUrl(posterPattern, ids, type, config, { shape: posterShapeOf(meta) });
        if (resolved) {
          if (config.usePosterProxy) {
            if (proxyArtBase && cachePosters && !posterCacheConfig.isBypassed(resolved)) {
              addRendered(
                buildProxyArtUrl({ base: proxyArtBase, imageClass: 'poster', type: type, id: proxyId, fallback: meta.poster, url: resolved }),
                'poster',
                'poster',
                resolved
              );
            }
          } else {
            addThirdParty(resolved, 'poster', 'poster');
          }
          posterWarmed = true;
        }
      }
    }
    if (!posterWarmed && meta.poster) {
      addThirdParty(meta.poster, 'poster', 'poster');
    }

    for (const [field, imageClass] of Object.entries(metaFieldClasses)) {
      if (field === 'poster') continue;

      // The served URL, which is what a client will ask for. index.js swaps these
      // patterns in on the way out, so warming meta[field] fills a key nobody
      // requests and leaves the one they do request cold.
      const pattern = customArtPatterns[field];
      const resolved = pattern ? resolveCustomArtUrl(pattern, ids, type, config, field === 'logo' ? undefined : { shape: 'landscape' }) : null;
      if (resolved) {
        if (config.usePosterProxy && proxyId) {
          if (proxyArtBase
            && posterCacheConfig.isClassEnabled(imageClass)
            && !posterCacheConfig.isBypassed(resolved)) {
            addRendered(
              buildProxyArtUrl({ base: proxyArtBase, imageClass, type: type, id: proxyId, fallback: meta[field], url: resolved }),
              imageClass,
              imageClass,
              resolved
            );
          }
        } else {
          addThirdParty(resolved, imageClass, field);
        }
        continue;
      }

      if (meta[field]) addThirdParty(meta[field], imageClass, field);
    }

    if (cacheThumbnails && Array.isArray(meta.videos)) {
      for (const video of meta.videos) {
        if (video?.thumbnail) addThirdParty(video.thumbnail, 'thumbnail', 'thumbnail');
      }
    }

    if (cacheCast && Array.isArray(meta.app_extras?.cast)) {
      for (const member of meta.app_extras.cast) {
        if (member?.photo) addThirdParty(member.photo, 'cast', 'cast');
      }
    }
  }

  return targets;
}

module.exports = { collectWarmupTargets, extractIdsFromWarmerMeta };
