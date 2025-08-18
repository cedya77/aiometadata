const express = require("express");
const favicon = require('serve-favicon');
const path = require("path");
const crypto = require('crypto');
const addon = express();
// Honor X-Forwarded-* headers from reverse proxies (e.g., Traefik) so req.protocol reflects HTTPS
addon.set('trust proxy', true);
const analytics = require('./utils/analytics');
const { getCatalog } = require("./lib/getCatalog");
const { getSearch } = require("./lib/getSearch");
const { getManifest, DEFAULT_LANGUAGE } = require("./lib/getManifest");
const { getMeta } = require("./lib/getMeta");
const { cacheWrap, cacheWrapMeta, cacheWrapCatalog, cacheWrapJikanApi, cacheWrapStaticCatalog, cacheWrapGlobal, getCacheHealth, clearCacheHealth, logCacheHealth } = require("./lib/getCache");
const { warmEssentialContent, warmRelatedContent, scheduleEssentialWarming } = require("./lib/cacheWarmer");
const configApi = require('./lib/configApi');
const database = require('./lib/database');
const { getTrending } = require("./lib/getTrending");
const { parseConfig, getRpdbPoster, checkIfExists, parseAnimeCatalogMeta, parseAnimeCatalogMetaBatch } = require("./utils/parseProps");
const { getRequestToken, getSessionId } = require("./lib/getSession");
const { getFavorites, getWatchList } = require("./lib/getPersonalLists");
const { blurImage } = require('./utils/imageProcessor');
const axios = require('axios');
const jikan = require('./lib/mal');
const packageJson = require('../package.json');
const ADDON_VERSION = packageJson.version;
const sharp = require('sharp');

// Parse JSON and URL-encoded bodies for API routes
addon.use(express.json({ limit: '2mb' }));
addon.use(express.urlencoded({ extended: true }));

addon.use(analytics.middleware);
const NO_CACHE = process.env.NO_CACHE === 'true';

// Initialize cache warming for public instances
const ENABLE_CACHE_WARMING = process.env.ENABLE_CACHE_WARMING === 'true';
const CACHE_WARMING_INTERVAL = parseInt(process.env.CACHE_WARMING_INTERVAL || '30', 10);

if (ENABLE_CACHE_WARMING && !NO_CACHE) {
  console.log(`[Cache Warming] Initializing essential content warming (interval: ${CACHE_WARMING_INTERVAL} minutes)`);
  scheduleEssentialWarming(CACHE_WARMING_INTERVAL);
} else {
  console.log('[Cache Warming] Cache warming disabled or cache disabled');
}



const getCacheHeaders = function (opts) {
  opts = opts || {};
  if (!Object.keys(opts).length) return false;
  let cacheHeaders = {
    cacheMaxAge: "max-age",
    staleRevalidate: "stale-while-revalidate",
    staleError: "stale-if-error",
  };
  return Object.keys(cacheHeaders)
    .map((prop) => {
      const value = opts[prop];
      if (!value) return false;
      return cacheHeaders[prop] + "=" + value;
    })
    .filter((val) => !!val)
    .join(", ");
};

const respond = function (req, res, data, opts) {

  if (NO_CACHE) {
    console.log('[Cache] Bypassing browser cache for this request.');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  } else {
    const configString = req.params.catalogChoices || '';
    let etagContent = ADDON_VERSION + JSON.stringify(data) + configString;
    
    // For meta routes, include provider-specific info in ETag for immediate cache invalidation
    if (req.route && req.route.path && req.route.path.includes('/meta/')) {
      const config = parseConfig(configString) || {};
      const providerInfo = {
        providers: config.providers || {},
        artProviders: config.artProviders || {}
      };
      etagContent += JSON.stringify(providerInfo);
    }
    
    const etagHash = crypto.createHash('md5').update(etagContent).digest('hex');
    const etag = `W/"${etagHash}"`;

    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public'); // It's public, but must be validated

    if (req.headers['if-none-match'] === etag) {
      res.status(304).end(); // The browser's cache is fresh.
      return;
    }

    const cacheControl = getCacheHeaders(opts);
    if (cacheControl) {
      res.setHeader("Cache-Control", `${cacheControl}, public`);
    }
  }
  
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Content-Type", "application/json");
  res.send(data);
};

addon.get("/api/config", (req, res) => {
  const publicEnvConfig = {
    tmdb: process.env.TMDB_API || "",
    tvdb: process.env.TVDB_API_KEY || "",
    fanart: process.env.FANART_API_KEY || "",
    addonVersion: ADDON_VERSION,
  };
  
  res.json(publicEnvConfig);
});

// --- Configuration Database API Routes ---
addon.post("/api/config/save", configApi.saveConfig.bind(configApi));
addon.post("/api/config/load/:userUUID", configApi.loadConfig.bind(configApi));
addon.put("/api/config/update/:userUUID", configApi.updateConfig.bind(configApi));
addon.post("/api/config/migrate", configApi.migrateFromLocalStorage.bind(configApi));
addon.get('/api/config/is-trusted/:uuid', configApi.isTrusted.bind(configApi));

// --- Admin Configuration Routes ---
addon.get("/api/config/stats", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  configApi.getStats(req, res);
});

// --- Cache Warming Endpoints (Admin only) ---
addon.post("/api/cache/warm", async (req, res) => {
  // Simple admin check - you might want to implement proper authentication
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    console.log('[API] Manual essential content warming requested');
    const results = await warmEssentialContent();
    res.json({ 
      success: true, 
      message: 'Essential content warming completed',
      results 
    });
  } catch (error) {
    console.error('[API] Essential content warming failed:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

addon.get("/api/cache/status", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  res.json({
    cacheEnabled: !NO_CACHE,
    warmingEnabled: ENABLE_CACHE_WARMING,
    warmingInterval: CACHE_WARMING_INTERVAL,
    addonVersion: ADDON_VERSION
  });
});

// Cache health monitoring endpoints
addon.get("/api/cache/health", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const health = getCacheHealth();
  res.json({
    success: true,
    health,
    timestamp: new Date().toISOString()
  });
});

addon.post("/api/cache/health/clear", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  clearCacheHealth();
  res.json({
    success: true,
    message: 'Cache health statistics cleared'
  });
});

addon.post("/api/cache/health/log", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  logCacheHealth();
  res.json({
    success: true,
    message: 'Cache health logged to console'
  });
});

// --- Static, Auth, and Configuration Routes ---
addon.get("/", function (_, res) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0'); 
    res.redirect("/configure"); 
});
addon.get("/request_token", async function (req, res) { const r = await getRequestToken(); respond(req, res, r); });
addon.get("/session_id", async function (req, res) { const s = await getSessionId(req.query.request_token); respond(req, res, s); });



// --- UUID-based Manifest Route for Public Instances ---
addon.get("/stremio/:userUUID/:compressedConfig/manifest.json", async function (req, res) {
    const { userUUID, compressedConfig } = req.params;
    
    try {
        // Try to load config from database first
        const config = await database.getUserConfig(userUUID);
        
        if (config) {
            // Use database config
            const manifest = await cacheWrap(`manifest:${userUUID}`, async () => {
                console.log(`[Manifest] Cache miss for user: ${userUUID}. Building fresh manifest.`);
                return await getManifest(config);
            }, 12 * 60 * 60, NO_CACHE);
            
            if (!manifest) {
                return res.status(500).send({ err: "Failed to build manifest." });
            }
            
            const cacheOpts = { cacheMaxAge: 1 * 60 * 60 };
            respond(req, res, manifest, cacheOpts);
        } else {
            // Fallback to compressed config in URL
            const config = parseConfig(compressedConfig) || {};
            const manifest = await cacheWrap(`manifest:${compressedConfig}`, async () => {
                console.log(`[Manifest] Cache miss for compressed config. Building fresh manifest.`);
                return await getManifest(config);
            }, 12 * 60 * 60, NO_CACHE);
            
            if (!manifest) {
                return res.status(500).send({ err: "Failed to build manifest." });
            }
            
            const cacheOpts = { cacheMaxAge: 1 * 60 * 60 };
            respond(req, res, manifest, cacheOpts);
        }
    } catch (error) {
        console.error(`[Manifest] Error for user ${userUUID}:`, error);
        res.status(500).send({ err: "Failed to build manifest." });
    }
});

// --- Catalog & Search Route (with enhanced caching) ---
addon.get("/:catalogChoices?/catalog/:type/:id/:extra?.json", async function (req, res) {
  const { catalogChoices, type, id, extra } = req.params;
  const config = parseConfig(catalogChoices) || {};
  const language = config.language || DEFAULT_LANGUAGE;
  const sessionId = config.sessionId;

  const isStaticCatalog = ['mal.decade80s', 'mal.decade90s', 'mal.decade00s', 'mal.decade10s'].includes(id);
  const cacheWrapper = isStaticCatalog ? cacheWrapStaticCatalog : cacheWrapCatalog;

  const catalogKey = `${id}:${type}:${JSON.stringify(extra || {})}`;
  
  // Enhanced caching options for better error handling
  const cacheOptions = {
    enableErrorCaching: true,
    maxRetries: 2, // Allow retries for temporary failures
  };
  
  try {
    const responseData = await cacheWrapper(catalogChoices, catalogKey, async () => {
      let metas = []; 
      
      if (id.includes('search')) {
        const extraArgs = extra ? Object.fromEntries(new URLSearchParams(extra)) : {};
        const searchResult = await getSearch(id, type, language, extraArgs, config);
        metas = searchResult.metas || [];
      } else {
        const { genre: genreName, type_filter,  skip } = extra ? Object.fromEntries(new URLSearchParams(extra)) : {};
        const pageSize = 25;
        const page = skip ? Math.floor(parseInt(skip) / pageSize) + 1 : 1;
        const args = [type, language, page];
        switch (id) {
          // --- Dynamic Catalogs (will use 1-hour cache) ---
          case "tmdb.trending":
            metas = (await getTrending(...args, genreName, config, catalogChoices)).metas;
            break;
          case "tmdb.favorites":
            metas = (await getFavorites(...args, genreName, sessionId, config)).metas;
            break;
          case "tmdb.watchlist":
            metas = (await getWatchList(...args, genreName, sessionId, config)).metas;
            break;
          case "tvdb.genres":
            metas = (await  getCatalog(type, language, page, id, genreName, config, catalogChoices)).metas;
            break;
          case 'mal.airing':
          case 'mal.upcoming':
          case 'mal.decade20s': {
            const animeResults = id === 'mal.airing'
              ? await jikan.getAiringNow(page, config)
              : id === 'mal.upcoming'
                ? await jikan.getUpcoming(page, config)
                : await jikan.getTopAnimeByDateRange('2020-01-01', '2029-12-31', page, config);
            metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            break;
          }
          case 'mal.genres': {
            const mediaType = type_filter ||'series';
            const allAnimeGenres = await cacheWrapJikanApi('anime-genres', async () => {
              console.log('[Cache Miss] Fetching fresh anime genre list from Jikan...');
              return await jikan.getAnimeGenres();
             });
            const genreNameToFetch = genreName || allAnimeGenres[0]?.name;
            if (genreNameToFetch) {
              const selectedGenre = allAnimeGenres.find(g => g.name === genreNameToFetch);
              if (selectedGenre) {
                const genreId = selectedGenre.mal_id;
                const animeResults = await jikan.getAnimeByGenre(genreId, mediaType, page, config);
                metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
              }
            }
            break;
          }

          case 'mal.schedule': {
            
            const dayOfWeek = genreName || 'Monday'; 
            const animeResults = await jikan.getAiringSchedule(dayOfWeek, page, config);
            metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            break;
          }

          case 'mal.studios': {
            if (genreName) {
                console.log(`[Catalog] Fetching anime for MAL studio: ${genreName}`);
                const studios = await cacheWrapJikanApi('mal-studios', () => jikan.getStudios(100));
                const selectedStudio = studios.find(studio => {
                    const defaultTitle = studio.titles.find(t => t.type === 'Default');
                    return defaultTitle && defaultTitle.title === genreName;
                });
        
                if (selectedStudio) {
                    const studioId = selectedStudio.mal_id;
                    const animeResults = await jikan.getAnimeByStudio(studioId, page);
                    metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
                } else {
                    console.warn(`[Catalog] Could not find a MAL ID for studio name: ${genreName}`);
                }
            }
            break;
          }

          case 'mal.decade80s':
          case 'mal.decade90s':
          case 'mal.decade00s':
          case 'mal.decade10s':
            const decadeMap = {
              'mal.decade80s': ['1980-01-01', '1989-12-31'],
              'mal.decade90s': ['1990-01-01', '1999-12-31'],
              'mal.decade00s': ['2000-01-01', '2009-12-31'],
              'mal.decade10s': ['2010-01-01', '2019-12-31'],
            };
            const [startDate, endDate] = decadeMap[id];
            const animeResults = await jikan.getTopAnimeByDateRange(startDate, endDate, page, config);
            metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            break;
          
          default:
            metas = (await getCatalog(type, language, page, id, genreName, config, catalogChoices)).metas;
            break;
        }
      }
      return { metas: metas || [] };
    }, undefined, cacheOptions);
    const httpCacheOpts = isStaticCatalog 
        ? { cacheMaxAge: 24 * 60 * 60 }
        : { cacheMaxAge: 1 * 60 * 60 }; 
    respond(req, res, responseData, httpCacheOpts);

  } catch (e) {
    console.error(`Error in catalog route for id "${id}" and type "${type}":`, e);
    return res.status(500).send("Internal Server Error");
  }
});

// --- Catalog Route under /stremio/:userUUID/:catalogChoices prefix ---
addon.get("/stremio/:userUUID/:catalogChoices/catalog/:type/:id/:extra?.json", async function (req, res) {
  const { catalogChoices, type, id, extra } = req.params;
  const config = parseConfig(catalogChoices) || {};
  const language = config.language || DEFAULT_LANGUAGE;
  const sessionId = config.sessionId;

  const isStaticCatalog = ['mal.decade80s', 'mal.decade90s', 'mal.decade00s', 'mal.decade10s'].includes(id);
  const cacheWrapper = isStaticCatalog ? cacheWrapStaticCatalog : cacheWrapCatalog;

  const catalogKey = `${id}:${type}:${JSON.stringify(extra || {})}`;
  
  const cacheOptions = {
    enableErrorCaching: true,
    maxRetries: 2,
  };
  
  try {
    const responseData = await cacheWrapper(catalogChoices, catalogKey, async () => {
      let metas = [];
      if (id.includes('search')) {
        const extraArgs = extra ? Object.fromEntries(new URLSearchParams(extra)) : {};
        const searchResult = await getSearch(id, type, language, extraArgs, config);
        metas = searchResult.metas || [];
      } else {
        const { genre: genreName, type_filter,  skip } = extra ? Object.fromEntries(new URLSearchParams(extra)) : {};
        const pageSize = 25;
        const page = skip ? Math.floor(parseInt(skip) / pageSize) + 1 : 1;
        const args = [type, language, page];
        switch (id) {
          case "tmdb.trending":
            console.log(`[CATALOG ROUTE 2] tmdb.trending called with type=${type}, language=${language}, page=${page}`);
            metas = (await getTrending(...args, genreName, config, catalogChoices)).metas;
            break;
          case "tmdb.favorites":
            metas = (await getFavorites(...args, genreName, sessionId, config)).metas;
            break;
          case "tmdb.watchlist":
            metas = (await getWatchList(...args, genreName, sessionId, config)).metas;
            break;
          case "tvdb.genres":
            metas = (await  getCatalog(type, language, page, id, genreName, config, catalogChoices)).metas;
            break;
          case 'mal.airing':
          case 'mal.upcoming':
          case 'mal.decade20s': {
            const animeResults = id === 'mal.airing'
              ? await jikan.getAiringNow(page, config)
              : id === 'mal.upcoming'
                ? await jikan.getUpcoming(page, config)
                : await jikan.getTopAnimeByDateRange('2020-01-01', '2029-12-31', page, config);
            metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            break;
          }
          case 'mal.genres': {
            const mediaType = type_filter || 'series';
            const allAnimeGenres = await cacheWrapJikanApi('anime-genres', async () => {
              console.log('[Cache Miss] Fetching fresh anime genre list from Jikan...');
              return await jikan.getAnimeGenres();
            });
            const genreNameToFetch = genreName || allAnimeGenres[0]?.name;
            if (genreNameToFetch) {
              const selectedGenre = allAnimeGenres.find(g => g.name === genreNameToFetch);
              if (selectedGenre) {
                const genreId = selectedGenre.mal_id;
                const animeResults = await jikan.getAnimeByGenre(genreId, mediaType, page, config);
                metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
              }
            }
            break;
          }

          case 'mal.studios': {
            if (genreName) {
                console.log(`[Catalog] Fetching anime for MAL studio: ${genreName}`);
                const studios = await cacheWrapJikanApi('mal-studios', () => jikan.getStudios(100));
                const selectedStudio = studios.find(studio => {
                    const defaultTitle = studio.titles.find(t => t.type === 'Default');
                    return defaultTitle && defaultTitle.title === genreName;
                });
        
                if (selectedStudio) {
                    const studioId = selectedStudio.mal_id;
                    const animeResults = await jikan.getAnimeByStudio(studioId, page);
                    metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
                } else {
                    console.warn(`[Catalog] Could not find a MAL ID for studio name: ${genreName}`);
                }
            }
            break;
          }
          case 'mal.schedule': {
            const dayOfWeek = genreName || 'Monday';
            const animeResults = await jikan.getAiringSchedule(dayOfWeek, page, config);
            metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            break;
          }
          case 'mal.decade80s':
          case 'mal.decade90s':
          case 'mal.decade00s':
          case 'mal.decade10s': {
            const decadeMap = {
              'mal.decade80s': ['1980-01-01', '1989-12-31'],
              'mal.decade90s': ['1990-01-01', '1999-12-31'],
              'mal.decade00s': ['2000-01-01', '2009-12-31'],
              'mal.decade10s': ['2010-01-01', '2019-12-31'],
            };
            const [startDate, endDate] = decadeMap[id];
            const animeResults = await jikan.getTopAnimeByDateRange(startDate, endDate, page, config);
            metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            break;
          }
          default:
            metas = (await getCatalog(type, language, page, id, genreName, config, catalogChoices)).metas;
            break;
        }
      }
      return { metas: metas || [] };
    }, undefined, cacheOptions);
    const httpCacheOpts = isStaticCatalog
      ? { cacheMaxAge: 24 * 60 * 60 }
      : { cacheMaxAge: 1 * 60 * 60 };
    respond(req, res, responseData, httpCacheOpts);

  } catch (e) {
    console.error(`Error in catalog route for id "${id}" and type "${type}":`, e);
    return res.status(500).send("Internal Server Error");
  }
});
// --- Meta Route (with enhanced caching) ---
addon.get("/stremio/:userUUID/:catalogChoices/meta/:type/:id.json", async function (req, res) {
  const { userUUID, catalogChoices, type, id: stremioId } = req.params;
  const config = parseConfig(catalogChoices) || {};
  const language = config.language || DEFAULT_LANGUAGE;
  const fullConfig = config; 
  
  // Enhanced caching options for better error handling
  const cacheOptions = {
    enableErrorCaching: true,
    maxRetries: 2, // Allow retries for temporary failures
  };
  
  try {
    const result = await cacheWrapMeta(catalogChoices, stremioId, async () => {
      // Pass the full userUUID/catalogChoices string for proper genre link construction
      const fullCatalogChoices = `${userUUID}/${catalogChoices}`;
      return await getMeta(type, language, stremioId, fullConfig, fullCatalogChoices);
    }, undefined, cacheOptions);

    if (!result || !result.meta) {
      return respond(req, res, { meta: null });
    }
    
    // Warm related content in the background for public instances
    if (ENABLE_CACHE_WARMING && !NO_CACHE) {
      // Don't await this - let it run in background
      warmRelatedContent(stremioId, type).catch(error => {
        console.warn(`[Cache Warming] Background warming failed for ${stremioId}:`, error.message);
      });
    }
    
    // Cache times can be longer now since ETags handle immediate provider change invalidation
    const cacheOpts = { staleRevalidate: 20 * 24 * 60 * 60, staleError: 30 * 24 * 60 * 60 };
    if (type === "movie") {
      cacheOpts.cacheMaxAge = 14 * 24 * 60 * 60; // 14 days - ETags handle provider changes
    } else if (type === "series") {
      const hasEnded = result.meta.status === 'Ended';
      cacheOpts.cacheMaxAge = (hasEnded ? 7 : 1) * 24 * 60 * 60; // 7 days for ended, 1 day for running
    }
    
    respond(req, res, result, cacheOpts);
    
  } catch (error) {
    console.error(`CRITICAL ERROR in meta route for ${stremioId}:`, error);
    res.status(500).send("Internal Server Error");
  }
});



addon.get("/poster/:type/:id", async function (req, res) {
  const { type, id } = req.params;
  const { fallback, lang, key } = req.query;
  if (!key) {
    return res.redirect(302, fallback);
  }

  const [idSource, idValue] = id.split(':');
  const ids = {
    tmdbId: idSource === 'tmdb' ? idValue : null,
    tvdbId: idSource === 'tvdb' ? idValue : null,
    imdbId: idSource.startsWith('tt') ? idSource : null,
  };

  try {
    const rpdbUrl = getRpdbPoster(type, ids, lang, key);

    if (rpdbUrl && await checkIfExists(rpdbUrl)) {
      //console.log("Success! Pipe the image from RPDB directly to the user.");
      const imageResponse = await axios({
        method: 'get',
        url: rpdbUrl,
        responseType: 'stream'
      });
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
      imageResponse.data.pipe(res);
    } else {
      res.redirect(302, fallback);
    }
  } catch (error) {
    console.error(`Error in poster proxy for ${id}:`, error.message);
    res.redirect(302, fallback);
  }
});


// --- Image Blur Route ---
addon.get("/api/image/blur", async function (req, res) {
  const imageUrl = req.query.url;
  if (!imageUrl) { return res.status(400).send('Image URL not provided'); }
  try {
    const blurredImageBuffer = await blurImage(imageUrl);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(blurredImageBuffer);
  } catch (error) {
    console.error('Error in blur route:', error);
    res.status(500).send('Error processing image');
  }
});

// --- Image Resize Route ---
addon.get('/resize-image', async function (req, res) {
  const imageUrl = req.query.url;
  const fit = req.query.fit || 'cover';
  const output = req.query.output || 'jpg';
  const quality = parseInt(req.query.q, 10) || 95;

  if (!imageUrl) {
    return res.status(400).send('Image URL not provided');
  }

  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    let transformer = sharp(response.data).resize({
      width: 1280, // You can adjust or make this configurable
      height: 720,
      fit: fit
    });
    if (output === 'jpg' || output === 'jpeg') {
      transformer = transformer.jpeg({ quality });
      res.setHeader('Content-Type', 'image/jpeg');
    } else if (output === 'png') {
      transformer = transformer.png({ quality });
      res.setHeader('Content-Type', 'image/png');
    } else if (output === 'webp') {
      transformer = transformer.webp({ quality });
      res.setHeader('Content-Type', 'image/webp');
    } else {
      return res.status(400).send('Unsupported output format');
    }
    const buffer = await transformer.toBuffer();
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buffer);
  } catch (error) {
    console.error('Error in resize-image route:', error);
    res.status(500).send('Error processing image');
  }
});


addon.get('/:catalogChoices?/configure', function (req, res) {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// Support Stremio settings opening under /stremio/:uuid/:config/configure
addon.get('/stremio/:userUUID/:catalogChoices/configure', function (req, res) {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

addon.use(favicon(path.join(__dirname, '../public/favicon.png')));
addon.use('/configure', express.static(path.join(__dirname, '../dist')));
addon.use(express.static(path.join(__dirname, '../public')));
addon.use(express.static(path.join(__dirname, '../dist')));

addon.get('/api/config/addon-info', (req, res) => {
  res.json({
    requiresAddonPassword: !!process.env.ADDON_PASSWORD,
    addonVersion: ADDON_VERSION
  });
});

module.exports = addon;
