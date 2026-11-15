import { buildProxyArtUrl } from './posterCache/proxyArt';
import { extractIdsFromMeta } from '../utils/metaIds';

export function applyMetaArt(meta: any, config: any, type: string, userAgent: string): void {
  const host = process.env.HOST_NAME.startsWith('http') ? process.env.HOST_NAME : `https://${process.env.HOST_NAME}`;
  const { resolveCustomArtUrl, resolvePosterPattern, resolveThumbnailPattern, getPosterRatingApiKey, resolveLandscapePattern, posterShapeOf } = require('../utils/parseProps');
  const ids = extractIdsFromMeta(meta);
  const metaType = meta.type || type;
  const metaPosterPattern = config.enableRatingPostersForLibrary !== false ? resolvePosterPattern(config) : null;
  const metaLandscapePattern = resolveLandscapePattern(config, metaPosterPattern);
  // Apply poster pattern unless enableRatingPostersForLibrary is explicitly disabled
  if (config.enableRatingPostersForLibrary !== false) {
    if (metaPosterPattern) {
      const proxyApiKey = config.usePosterProxy ? getPosterRatingApiKey(config) : null;
      if (proxyApiKey) {
        const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
        if (proxyId) {
          meta.poster = buildProxyArtUrl({ base: `${host}/poster-cache/proxy`, imageClass: 'poster', type: metaType, id: proxyId, fallback: meta.poster, ratingKey: proxyApiKey, lang: config.language });
        }
      } else {
        const resolved = resolveCustomArtUrl(metaPosterPattern, ids, metaType, config, { userAgent, shape: posterShapeOf(meta) });
        if (resolved) {
          if (config.usePosterProxy) {
            const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
            if (proxyId) {
              meta.poster = buildProxyArtUrl({ base: `${host}/poster-cache/proxy`, imageClass: 'poster', type: metaType, id: proxyId, fallback: meta.poster, url: resolved });
            } else {
              meta.poster = resolved;
            }
          } else {
            meta.poster = resolved;
          }
        }
      }
    }
  }
  if (config.customBackgroundUrlPattern) {
    const resolved = resolveCustomArtUrl(config.customBackgroundUrlPattern, ids, metaType, config, { userAgent, shape: 'landscape' });
    if (resolved) {
      if (config.usePosterProxy) {
        const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
        if (proxyId) {
          meta.background = buildProxyArtUrl({ base: `${host}/poster-cache/proxy`, imageClass: 'background', type: metaType, id: proxyId, fallback: meta.background, url: resolved });
        } else {
          meta.background = resolved;
        }
      } else {
        meta.background = resolved;
      }
    }
  }
  if (metaLandscapePattern) {
    const resolved = resolveCustomArtUrl(metaLandscapePattern, ids, metaType, config, { userAgent, shape: 'landscape' });
    if (resolved) {
      if (config.usePosterProxy) {
        const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
        if (proxyId) {
          meta.landscapePoster = buildProxyArtUrl({ base: `${host}/poster-cache/proxy`, imageClass: 'landscape', type: metaType, id: proxyId, fallback: meta.landscapePoster, url: resolved });
        } else {
          meta.landscapePoster = resolved;
        }
      } else {
        meta.landscapePoster = resolved;
      }
    }
  }
  if (config.customLogoUrlPattern) {
    const resolved = resolveCustomArtUrl(config.customLogoUrlPattern, ids, metaType, config, { userAgent });
    if (resolved) {
      if (config.usePosterProxy) {
        const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
        if (proxyId) {
          meta.logo = buildProxyArtUrl({ base: `${host}/poster-cache/proxy`, imageClass: 'logo', type: metaType, id: proxyId, fallback: meta.logo, url: resolved });
        } else {
          meta.logo = resolved;
        }
      } else {
        meta.logo = resolved;
      }
    }
  }
  // Apply thumbnail pattern to episode videos
  const thumbnailPattern = resolveThumbnailPattern(config);
  if (thumbnailPattern && meta.videos && Array.isArray(meta.videos)) {
    const thumbnailProxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
    for (const video of meta.videos) {
      const idParts = video.id?.split(':');
      if (idParts && idParts.length >= 3) {
        const season = parseInt(idParts[idParts.length - 2], 10);
        const episode = parseInt(idParts[idParts.length - 1], 10);
        if (!isNaN(season) && !isNaN(episode)) {
          // Unwrap blur proxy to get original thumbnail URL for {thumbnail} placeholder
          let originalThumb = video.thumbnail || '';
          if (originalThumb.includes('/api/image/blur?url=')) {
            originalThumb = decodeURIComponent(originalThumb.split('/api/image/blur?url=')[1] || '');
          }
          const resolved = resolveCustomArtUrl(thumbnailPattern, ids, metaType, config, {
            season,
            episode,
            blur: config.blurThumbs ? 'true' : 'false',
            thumbnail: encodeURIComponent(originalThumb),
            userAgent,
          });
          if (resolved) {
            if (config.usePosterProxy && thumbnailProxyId) {
              // All episodes share the show's id; the per-episode url keeps proxy cache entries distinct.
              video.thumbnail = buildProxyArtUrl({ base: `${host}/poster-cache/proxy`, imageClass: 'background', type: metaType, id: thumbnailProxyId, fallback: originalThumb || '', url: resolved });
            } else {
              video.thumbnail = resolved;
            }
          }
        }
      }
    }
  }
}
