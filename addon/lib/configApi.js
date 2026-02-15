const crypto = require('crypto');
const { request, Agent, ProxyAgent } = require("undici");
const database = require('./database');
const packageJson = require('../../package.json');

// Gemini dispatcher configuration for API key testing
// Priority: GEMINI_HTTPS_PROXY/GEMINI_HTTP_PROXY > HTTPS_PROXY/HTTP_PROXY > direct connection
const createGeminiDispatcher = () => {
  // First check for Gemini-specific proxy
  const geminiProxy = process.env.GEMINI_HTTPS_PROXY ?? process.env.GEMINI_HTTP_PROXY;
  if (geminiProxy) {
    try {
      return new ProxyAgent({ uri: new URL(geminiProxy).toString() });
    } catch (error) {
      console.warn("Invalid Gemini proxy URL:", geminiProxy);
    }
  }
  // Fall back to global proxy
  const globalProxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (globalProxy) {
    try {
      return new ProxyAgent({ uri: new URL(globalProxy).toString() });
    } catch (error) {
      console.warn("Invalid global proxy URL:", globalProxy);
    }
  }
  // No proxy configured - use direct connection
  return new Agent({
    keepAliveTimeout: 10000,
    connections: 10,
  });
};

const geminiDispatcher = createGeminiDispatcher();
const consola = require('consola');

const logger = consola.withTag('ConfigApi');
// Import the config cache
const configCache = require('./configCache');
const { deleteKeysByPattern } = require('./redisUtils');

class ConfigApi {
  constructor() {
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await database.initialize();
    this.initialized = true;
  }

  async sanitizeTraktToken(config) {
    if (config?.apiKeys?.traktTokenId) {
        const token = await database.getOAuthToken(config.apiKeys.traktTokenId);
        if (!token) {
            logger.warn(`[Config Protection] Attempted to save config with dead Trakt token ${config.apiKeys.traktTokenId}. Removing it.`);
            // Strip the dead token so we don't save a broken state
            delete config.apiKeys.traktTokenId;
            
            // Optional: Also disable Trakt-specific settings to prevent errors
            if (config.trakt) delete config.trakt;
            
            return { cleaned: true };
        }
    }
    return { cleaned: false };
  }

  sanitizeMergedCatalogs(config) {
    if (!config || !Array.isArray(config.catalogs)) return;

    const catalogs = config.catalogs;
    const ensureMergedChildRestoreState = (catalog) => {
      const current = catalog?.metadata?.mergedChildState;
      if (
        current &&
        typeof current.showInHome === 'boolean' &&
        typeof current.randomizePerPage === 'boolean'
      ) {
        return;
      }

      catalog.metadata = {
        ...(catalog.metadata || {}),
        mergedChildState: {
          showInHome: !!catalog.showInHome,
          randomizePerPage: !!catalog.randomizePerPage,
        },
      };
    };
    const restoreMergedChildState = (catalog) => {
      const restoreState = catalog?.metadata?.mergedChildState;
      if (restoreState && typeof restoreState.showInHome === 'boolean') {
        catalog.showInHome = restoreState.showInHome;
      }
      if (restoreState && typeof restoreState.randomizePerPage === 'boolean') {
        catalog.randomizePerPage = restoreState.randomizePerPage;
      }
      if (catalog.metadata && typeof catalog.metadata === 'object') {
        delete catalog.metadata.mergedChildState;
        if (Object.keys(catalog.metadata).length === 0) {
          delete catalog.metadata;
        }
      }
      delete catalog.mergedInto;
    };
    const catalogByKey = new Map(catalogs.map(c => [`${c.id}-${c.type}`, c]));
    const validMergedParents = new Set();
    const childrenByParent = new Map();

    for (const catalog of catalogs) {
      const isMergedParent = catalog?.source === 'merged' || String(catalog?.id || '').startsWith('merge.');
      if (!isMergedParent) continue;

      const mergedMeta = catalog?.metadata?.merged;
      if (!mergedMeta || !Array.isArray(mergedMeta.children)) continue;
      const allowMixedTypes = (catalog.type === 'series' || catalog.type === 'movie' || catalog.type === 'anime' || catalog.type === 'all') && mergedMeta.allowMixedTypes === true;

      const seen = new Set();
      const normalizedChildren = [];
      for (const childRef of mergedMeta.children) {
        const childKey = `${childRef?.id}-${childRef?.type}`;
        if (!childRef?.id || !childRef?.type || seen.has(childKey)) continue;
        if (childRef.id === catalog.id && childRef.type === catalog.type) continue;
        const resolvedChild = catalogByKey.get(childKey);
        if (!resolvedChild) continue;
        const parentType = catalog.type;
        if (allowMixedTypes) {
          if (!(resolvedChild.type === 'movie' || resolvedChild.type === 'series' || resolvedChild.type === 'anime' || resolvedChild.type === 'all')) continue;
        } else if (resolvedChild.type !== parentType) {
          continue;
        }
        seen.add(childKey);
        normalizedChildren.push({
          id: resolvedChild.id,
          type: resolvedChild.type,
          ...(typeof childRef.weight === 'number' ? { weight: childRef.weight } : {}),
        });
      }

      mergedMeta.version = 1;
      mergedMeta.children = normalizedChildren;
      mergedMeta.strategy = mergedMeta.strategy === 'interleaved' ? 'interleaved' : 'sequential';
      mergedMeta.genreMode = 'strict';
      if (mergedMeta.dedupe === undefined) mergedMeta.dedupe = true;
      mergedMeta.allowMixedTypes = allowMixedTypes;

      if (normalizedChildren.length >= 2) {
        validMergedParents.add(catalog.id);
        childrenByParent.set(catalog.id, normalizedChildren);
      }
    }

    for (const catalog of catalogs) {
      if (catalog.mergedInto && !validMergedParents.has(catalog.mergedInto)) {
        restoreMergedChildState(catalog);
      }
    }

    for (const [parentId, children] of childrenByParent.entries()) {
      for (const childRef of children) {
        const child = catalogByKey.get(`${childRef.id}-${childRef.type}`);
        if (!child) continue;
        ensureMergedChildRestoreState(child);
        child.mergedInto = parentId;
        child.showInHome = false;
        child.randomizePerPage = false;
      }
    }
  }

  // Validate required API keys
  validateRequiredKeys(config) {
    const requiredKeys = ['tmdb'];
    
    // Check if fanart is selected in any art provider (handles both legacy and new formats)
    const isFanartSelected = (() => {
      const artProviders = config.artProviders;
      if (!artProviders) return false;
      
      return ['movie', 'series', 'anime'].some(contentType => {
        const provider = artProviders[contentType];
        
        // Handle legacy string format
        if (typeof provider === 'string') {
          return provider === 'fanart';
        }
        
        // Handle new nested object format
        if (typeof provider === 'object' && provider !== null) {
          return provider.poster === 'fanart' || 
                 provider.background === 'fanart' || 
                 provider.logo === 'fanart';
        }
        
        return false;
      });
    })();
    
    if (isFanartSelected && !requiredKeys.includes('fanart')) {
      requiredKeys.push('fanart');
    }
    
    const missingKeys = requiredKeys.filter(key => {
      if (key === 'tmdb') {
        // TMDB is required unless there's a built-in key
        const hasUserKey = config.apiKeys?.tmdb?.trim();
        const hasBuiltInKey = !!(process.env.BUILT_IN_TMDB_API_KEY);
        return !hasUserKey && !hasBuiltInKey;
      }
      return !config.apiKeys?.[key] || config.apiKeys[key].trim() === '';
    });
    
    if (missingKeys.length > 0) {
      return {
        valid: false,
        missingKeys,
        message: `Missing required API keys: ${missingKeys.join(', ')}`
      };
    }
    
    return { valid: true };
  }

  // Save configuration with password
  async saveConfig(req, res) {
    logger.debug('saveConfig called - starting function');
    try {
      await this.initialize();
      
      // Ensure body exists and is JSON
      if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({ error: 'Invalid request body. Expected JSON.' });
      }

      const { config, password, userUUID: existingUUID, addonPassword } = req.body;
      
      if (!config) {
        return res.status(400).json({ error: 'Configuration data is required' });
      }

      if (!password) {
        return res.status(400).json({ error: 'Password is required' });
      }

      // Check addon password if one is set
      if (process.env.ADDON_PASSWORD && process.env.ADDON_PASSWORD.length > 0) {
        if (!addonPassword || addonPassword !== process.env.ADDON_PASSWORD) {
          return res.status(401).json({ error: 'Invalid addon password. Contact the addon administrator.' });
        }
      }

      // Validate required API keys
      const validation = this.validateRequiredKeys(config);
      if (!validation.valid) {
        return res.status(400).json({ 
          error: validation.message,
          missingKeys: validation.missingKeys
        });
      }

      await this.sanitizeTraktToken(config);
      this.sanitizeMergedCatalogs(config);

      // Use existing UUID if provided, otherwise generate a new one
      const userUUID = existingUUID || database.generateUserUUID();
      
      // Hash the password with bcrypt
      const passwordHash = await database.hashPassword(password);
      
      // Add timestamp to track config changes
      const configWithTimestamp = {
        ...config,
        lastModified: Date.now()
      };
      
      // Get old config to compare changes
      let oldConfig = null;
      try {
        oldConfig = await database.getUserConfig(userUUID);
        logger.debug(`Retrieved old config for user ${userUUID}`);
      } catch (error) {
        // User might not exist yet, that's fine
        logger.debug(`No existing config found for user ${userUUID}, treating as new config`);
      }
      
      // Add a config version that changes when config is updated
      // This helps with cache invalidation
      configWithTimestamp.configVersion = Date.now();
      
      await database.saveUserConfig(userUUID, passwordHash, configWithTimestamp);
      logger.info(`Saved config for user ${userUUID}`);
      
      // Invalidate memory cache
      configCache.del(userUUID);
      
      // Always trust the UUID after creation
      await database.trustUUID(userUUID);
      
      // Invalidate user's cache when config changes
      try {
        const redis = require('./getCache').redis;
        logger.debug(`Starting cache invalidation process`);
        
        // Clear only the meta components affected by config changes
        try {
          const patterns = [];
          

          
          // Log config changes for debugging (no global meta cache clearing)
          if (config.castCount !== undefined && config.castCount !== oldConfig?.castCount) {
            logger.debug(`Cast count changed from ${oldConfig?.castCount} to ${config.castCount} - new requests will use new cache key`);
          }
          if (config.language !== undefined && config.language !== oldConfig?.language) {
            logger.debug(`Language changed from ${oldConfig?.language} to ${config.language} - new requests will use new cache key`);
          }
          if (config.blurThumbs !== undefined && config.blurThumbs !== oldConfig?.blurThumbs) {
            logger.debug(`Blur thumbs changed from ${oldConfig?.blurThumbs} to ${config.blurThumbs} - new requests will use new cache key`);
          }
          if (config.showPrefix !== undefined && config.showPrefix !== oldConfig?.showPrefix) {
            logger.debug(`Show prefix changed from ${oldConfig?.showPrefix} to ${config.showPrefix} - new requests will use new cache key`);
          }
          if (config.showMetaProviderAttribution !== undefined && config.showMetaProviderAttribution !== oldConfig?.showMetaProviderAttribution) {
            logger.debug(`Show meta provider attribution changed from ${oldConfig?.showMetaProviderAttribution} to ${config.showMetaProviderAttribution} - new requests will use new cache key`);
          }

          // API key changes - only clear catalog cache (user-scoped), not global meta cache
          if (config.apiKeys && oldConfig?.apiKeys) {
            const rpdbChanged = config.apiKeys.rpdb !== oldConfig.apiKeys.rpdb;
            const mdblistChanged = config.apiKeys.mdblist !== oldConfig.apiKeys.mdblist;
            
            if (rpdbChanged || mdblistChanged) {
              // RPDB/MDBList API key changes affect catalog rendering, clear user's catalogs
              patterns.push(`*catalog:${userUUID}:*`); // User-scoped catalog cache
              logger.debug(`API keys changed - RPDB: ${rpdbChanged}, MDBList: ${mdblistChanged} - clearing user's catalog cache`);
            }
          }

          // Art provider changes - affects all art-related components
          logger.debug(`DEBUG: Checking art providers - config.artProviders:`, config.artProviders);
          logger.debug(`DEBUG: Checking art providers - oldConfig?.artProviders:`, oldConfig?.artProviders);
          
          if (config.artProviders && oldConfig?.artProviders) {
            logger.debug(`DEBUG: Both art providers exist, comparing...`);
            let artProvidersChanged = false;
            
            // Check englishArtOnly boolean property
            if (config.artProviders?.englishArtOnly !== oldConfig?.artProviders?.englishArtOnly) {
              artProvidersChanged = true;
              logger.debug(`englishArtOnly changed from ${oldConfig?.artProviders?.englishArtOnly} to ${config.artProviders?.englishArtOnly}`);
            }
            
            // Check each content type (movie, series, anime)
            const contentTypes = ['movie', 'series', 'anime'];
            for (const contentType of contentTypes) {
              const newContentType = config.artProviders?.[contentType];
              const oldContentType = oldConfig?.artProviders?.[contentType];
              
              // Handle legacy string format
              if (typeof newContentType === 'string' && typeof oldContentType === 'string') {
                if (newContentType !== oldContentType) {
                  artProvidersChanged = true;
                  logger.debug(`${contentType} art provider changed from ${oldContentType} to ${newContentType}`);
                }
              }
              // Handle new nested object format
              else if (typeof newContentType === 'object' && typeof oldContentType === 'object') {
                const artTypes = ['poster', 'background', 'logo'];
                for (const artType of artTypes) {
                  if (newContentType?.[artType] !== oldContentType?.[artType]) {
                    artProvidersChanged = true;
                    logger.debug(`${contentType}.${artType} changed from ${oldContentType?.[artType]} to ${newContentType?.[artType]}`);
                  }
                }
              }
              // Handle mixed formats (legacy to new or vice versa) or missing values
              else if (newContentType !== oldContentType) {
                artProvidersChanged = true;
                logger.debug(`${contentType} art provider format changed from ${oldContentType} to ${newContentType}`);
              }
            }
            
            if (artProvidersChanged) {
              // Art provider changes are reflected in new cache keys, no need to clear globally
              logger.debug('Art providers changed - new requests will use new cache key');
              logger.debug('Old art providers:', oldConfig?.artProviders);
              logger.debug('New art providers:', config.artProviders);
            }
          }
          
          // Meta provider changes - new config creates new cache keys
          if (config.providers && oldConfig?.providers) {
            logger.debug('Comparing providers - old:', oldConfig.providers, 'new:', config.providers);
            const providersChanged = Object.keys(config.providers).some(key => 
              config.providers[key] !== oldConfig.providers?.[key]
            );
            if (providersChanged) {
              logger.debug('Providers changed - new requests will use new cache key');
            }
          } else {
            logger.debug('No providers to compare - old:', oldConfig?.providers, 'new:', config.providers);
          }
          
          // SFW mode changes - new config creates new cache keys
          if (config.sfw !== undefined && config.sfw !== oldConfig?.sfw) {
            logger.debug(`SFW mode changed from ${oldConfig?.sfw} to ${config.sfw} - new requests will use new cache key`);
          }
          
          // MDBList catalog changes - affects specific catalog cache
          if (config.catalogs && oldConfig?.catalogs) {
            const oldMdbCatalogs = oldConfig.catalogs.filter(c => c.id?.startsWith('mdblist.'));
            const newMdbCatalogs = config.catalogs.filter(c => c.id?.startsWith('mdblist.'));
            
            // Check if any MDBList catalog sort/order settings changed
            let mdblistChanged = false;
            const changedCatalogs = [];
            
            for (const newCatalog of newMdbCatalogs) {
              const oldCatalog = oldMdbCatalogs.find(c => c.id === newCatalog.id && c.type === newCatalog.type);
              if (oldCatalog) {
                if (newCatalog.sort !== oldCatalog.sort || newCatalog.order !== oldCatalog.order) {
                  mdblistChanged = true;
                  changedCatalogs.push(newCatalog.id);
                  logger.debug(`MDBList catalog ${newCatalog.id} sort/order changed:`, {
                    old: { sort: oldCatalog.sort, order: oldCatalog.order },
                    new: { sort: newCatalog.sort, order: newCatalog.order }
                  });
                }
              }
            }
            
            if (mdblistChanged) {
              // Clear cache for specific MDBList catalogs that changed
              for (const catalogId of changedCatalogs) {
                const pattern = `*catalog:${userUUID}:*${catalogId}*`;
                patterns.push(pattern);
                logger.debug(`Added cache invalidation pattern for MDBList catalog: ${pattern}`);
              }
            }
          }
          
          // Search-specific changes - affects search results
          if (config.search && oldConfig?.search) {
            const searchProvidersChanged = config.search.providers && oldConfig.search.providers && 
              Object.keys(config.search.providers).some(key => 
                config.search.providers[key] !== oldConfig.search.providers?.[key]
              );
            const aiEnabledChanged = config.search.ai_enabled !== oldConfig.search.ai_enabled;
            
            if (searchProvidersChanged || aiEnabledChanged) {
              patterns.push(`search:*`); // Clear all search cache
              logger.debug(`Search settings changed, clearing search cache`);
              if (searchProvidersChanged) logger.debug(`Search providers changed`);
              if (aiEnabledChanged) logger.debug(`AI enabled changed from ${oldConfig.search.ai_enabled} to ${config.search.ai_enabled}`);
              logger.debug(`DEBUG: Added pattern "search:*" for search settings change`);
            }
          }
          
          // If no specific patterns identified, don't clear anything
          if (patterns.length === 0) {
            logger.debug(`No config changes detected, skipping cache clearing`);
          }
          
          let totalCleared = 0;
          
          // First try pattern-based clearing
          for (const pattern of patterns) {
            const deleted = await deleteKeysByPattern(pattern);
            if (deleted > 0) {
              logger.debug(`Cleared ${deleted} cache entries matching pattern: ${pattern}`);
              totalCleared += deleted;
            } else {
              logger.debug(`No keys found matching pattern "${pattern}"`);
            }
          }
          
          // NOTE: Nuclear option removed - meta cache uses config hash in keys,
          // so new config = new cache keys = fresh data automatically.
          // Old entries expire naturally via TTL. This prevents cross-user cache pollution.
          
          if (totalCleared > 0) {
            logger.info(`Total affected cache cleared: ${totalCleared} entries`);
          } else {
            logger.debug('No affected cache entries found to clear');
          }
        } catch (cacheError) {
          logger.warn('Failed to clear affected cache:', cacheError.message);
        }
        

      } catch (cacheError) {
        logger.warn(`Failed to invalidate cache for user ${userUUID}:`, cacheError.message);
        // Don't fail the config save if cache invalidation fails
      }
      
      const hostEnv = process.env.HOST_NAME;
      const baseUrl = hostEnv
        ? (hostEnv.startsWith('http') ? hostEnv : `https://${hostEnv}`)
        : `https://${req.get('host')}`;

      const installUrl = `${baseUrl}/stremio/${userUUID}/manifest.json`;

      res.json({
        success: true,
        userUUID,
        installUrl,
        message: existingUUID ? 'Configuration updated successfully' : 'Configuration saved successfully'
      });
    } catch (error) {
      logger.error('Save config error:', error);
      res.status(500).json({ error: 'Failed to save configuration' });
    }
  }

  // Manual cache clearing endpoint (temporarily disabled)
  // async clearCache(req, res) { ... }

  // Load configuration by UUID (requires password)
    async loadConfig(req, res) {
    try {
      await this.initialize();
      const { userUUID } = req.params;
      const { password, addonPassword } = req.body;
      if (!userUUID) {
        return res.status(400).json({ error: 'User UUID is required' });
      }
      if (!password) {
        return res.status(400).json({ error: 'Password is required' });
      }
      // Check if UUID is trusted
      const isTrusted = await database.isUUIDTrusted(userUUID);
      if (!isTrusted && process.env.ADDON_PASSWORD && process.env.ADDON_PASSWORD.length > 0) {
        if (!addonPassword || addonPassword !== process.env.ADDON_PASSWORD) {
          return res.status(401).json({ error: 'Invalid addon password. Contact the addon administrator.' });
        }
      }
      const config = await database.verifyUserAndGetConfig(userUUID, password);
      if (!config) {
        return res.status(401).json({ error: 'Invalid UUID or password' });
      }
      // If not already trusted and correct addon password was provided, trust this UUID
      if (!isTrusted && addonPassword && addonPassword === process.env.ADDON_PASSWORD) {
        await database.trustUUID(userUUID);
      }
      
      // Strip instance-specific fields that shouldn't be returned from saved config
      const sanitizedConfig = {
        ...config,
        apiKeys: {
          ...config.apiKeys,
          customDescriptionBlurb: undefined
        }
      };
      
      res.json({
        success: true,
        userUUID,
        config: sanitizedConfig
      });
    } catch (error) {
      logger.error('Load config error:', error);
      res.status(500).json({ error: 'Failed to load configuration' });
    }
  }

  // Update configuration (requires password)
  async updateConfig(req, res) {
    logger.debug(`updateConfig called for userUUID: ${req.params.userUUID}`);
    logger.debug(`Request body keys:`, Object.keys(req.body || {}));
    try {
      await this.initialize();
      
      const { userUUID } = req.params;
      const { config, password, addonPassword } = req.body;
      
      if (!userUUID) {
        return res.status(400).json({ error: 'User UUID is required' });
      }

      if (!password) {
        return res.status(400).json({ error: 'Password is required' });
      }

      if (!config) {
        return res.status(400).json({ error: 'Configuration data is required' });
      }

      // Check if UUID is trusted
      const isTrusted = await database.isUUIDTrusted(userUUID);
      if (!isTrusted && process.env.ADDON_PASSWORD && process.env.ADDON_PASSWORD.length > 0) {
        if (!addonPassword || addonPassword !== process.env.ADDON_PASSWORD) {
          return res.status(401).json({ error: 'Invalid addon password. Contact the addon administrator.' });
        }
      }

      // Validate required API keys
      const validation = this.validateRequiredKeys(config);
      if (!validation.valid) {
        return res.status(400).json({ 
          error: validation.message,
          missingKeys: validation.missingKeys
        });
      }
      
      await this.sanitizeTraktToken(config);
      this.sanitizeMergedCatalogs(config);

      // Verify existing config exists
      const existingConfig = await database.verifyUserAndGetConfig(userUUID, password);
      if (!existingConfig) {
        return res.status(401).json({ error: 'Invalid UUID or password' });
      }

      // Hash the password with bcrypt
      const passwordHash = await database.hashPassword(password);
      
      // Get old config to compare changes
      let oldConfig = null;
      try {
        oldConfig = await database.getUserConfig(userUUID);
        logger.debug(`Retrieved old config for user ${userUUID}`);
      } catch (error) {
        logger.debug(`Could not retrieve old config for user ${userUUID}:`, error.message);
      }

      // Add timestamp to track config changes
      // Use a slightly higher timestamp to ensure it's always different
      const newConfigVersion = Date.now() + 1;
      const configWithTimestamp = {
        ...config,
        lastModified: Date.now(),
        configVersion: newConfigVersion
      };
      
      // Update the configuration
      await database.saveUserConfig(userUUID, passwordHash, configWithTimestamp);
      logger.debug(`Updated config for user ${userUUID} with configVersion: ${configWithTimestamp.configVersion}`);
      logger.debug(`Previous configVersion was: ${oldConfig?.configVersion || 'none'}`);
      
      // Invalidate memory cache
      configCache.del(userUUID);
      
      // Invalidate user's cache when config changes
      try {
        const redis = require('./getCache').redis;
        logger.debug(`Starting cache invalidation process`);
        
        // Clear only the meta components affected by config changes
        try {
          const patterns = [];
          

          
          // Log config changes for debugging (no global meta cache clearing)
          if (config.castCount !== undefined && config.castCount !== oldConfig?.castCount) {
            logger.debug(`Cast count changed from ${oldConfig?.castCount} to ${config.castCount} - new requests will use new cache key`);
          }
          if (config.language !== undefined && config.language !== oldConfig?.language) {
            logger.debug(`Language changed from ${oldConfig?.language} to ${config.language} - new requests will use new cache key`);
          }
          if (config.blurThumbs !== undefined && config.blurThumbs !== oldConfig?.blurThumbs) {
            logger.debug(`Blur thumbs changed from ${oldConfig?.blurThumbs} to ${config.blurThumbs} - new requests will use new cache key`);
          }
          if (config.showPrefix !== undefined && config.showPrefix !== oldConfig?.showPrefix) {
            logger.debug(`Show prefix changed from ${oldConfig?.showPrefix} to ${config.showPrefix} - new requests will use new cache key`);
          }
          if (config.showMetaProviderAttribution !== undefined && config.showMetaProviderAttribution !== oldConfig?.showMetaProviderAttribution) {
            logger.debug(`Show meta provider attribution changed - new requests will use new cache key`);
          }

          // API key changes - only clear catalog cache (user-scoped), not global meta cache
          if (config.apiKeys && oldConfig?.apiKeys) {
            const rpdbChanged = config.apiKeys.rpdb !== oldConfig.apiKeys.rpdb;
            const mdblistChanged = config.apiKeys.mdblist !== oldConfig.apiKeys.mdblist;
            
            if (rpdbChanged || mdblistChanged) {
              patterns.push(`*catalog:${userUUID}:*`); // User-scoped catalog cache
              logger.debug(`API keys changed - RPDB: ${rpdbChanged}, MDBList: ${mdblistChanged} - clearing user's catalog cache`);
            }
          }

          // Art provider changes - affects all art-related components
          logger.debug(`DEBUG: Checking art providers - config.artProviders:`, config.artProviders);
          logger.debug(`DEBUG: Checking art providers - oldConfig?.artProviders:`, oldConfig?.artProviders);
          
          if (config.artProviders && oldConfig?.artProviders) {
            logger.debug(`DEBUG: Both art providers exist, comparing...`);
            let artProvidersChanged = false;
            
            // Check englishArtOnly boolean property
            if (config.artProviders?.englishArtOnly !== oldConfig?.artProviders?.englishArtOnly) {
              artProvidersChanged = true;
              logger.debug(`englishArtOnly changed from ${oldConfig?.artProviders?.englishArtOnly} to ${config.artProviders?.englishArtOnly}`);
            }
            
            // Check each content type (movie, series, anime)
            const contentTypes = ['movie', 'series', 'anime'];
            for (const contentType of contentTypes) {
              const newContentType = config.artProviders?.[contentType];
              const oldContentType = oldConfig?.artProviders?.[contentType];
              
              if (newContentType && oldContentType) {
                // Check individual art type properties (poster, background, logo, banner)
                const artTypes = ['poster', 'background', 'logo', 'banner'];
                
                for (const artType of artTypes) {
                  const newArtProvider = newContentType[artType];
                  const oldArtProvider = oldContentType[artType];
                  
                  if (newArtProvider !== oldArtProvider) {
                    artProvidersChanged = true;
                    logger.debug(`${contentType} ${artType} changed from '${oldArtProvider}' to '${newArtProvider}'`);
                  }
                }
                
                // Also check legacy providers/fallbacks arrays if they exist
                const newProviders = newContentType.providers || [];
                const oldProviders = oldContentType.providers || [];
                
                if (newProviders.length > 0 || oldProviders.length > 0) {
                  if (JSON.stringify(newProviders.sort()) !== JSON.stringify(oldProviders.sort())) {
                    artProvidersChanged = true;
                    logger.debug(`${contentType} providers changed from [${oldProviders.join(', ')}] to [${newProviders.join(', ')}]`);
                  }
                }
                
                const newFallbacks = newContentType.fallbacks || [];
                const oldFallbacks = oldContentType.fallbacks || [];
                
                if (newFallbacks.length > 0 || oldFallbacks.length > 0) {
                  if (JSON.stringify(newFallbacks.sort()) !== JSON.stringify(oldFallbacks.sort())) {
                    artProvidersChanged = true;
                    logger.debug(`${contentType} fallbacks changed from [${oldFallbacks.join(', ')}] to [${newFallbacks.join(', ')}]`);
                  }
                }
              } else if (newContentType !== oldContentType) {
                // One exists and the other doesn't
                artProvidersChanged = true;
                logger.debug(`${contentType} content type changed from ${oldContentType ? 'exists' : 'null'} to ${newContentType ? 'exists' : 'null'}`);
              }
            }
            
            if (artProvidersChanged) {
              // Art provider changes are reflected in new cache keys, no need to clear globally
              logger.debug(`Art providers changed - new requests will use new cache key`);
            } else {
              logger.debug(`Art providers unchanged`);
            }
          } else if (config.artProviders !== oldConfig?.artProviders) {
            // One exists and the other doesn't
            logger.debug(`Art providers changed from ${oldConfig?.artProviders ? 'exists' : 'null'} to ${config.artProviders ? 'exists' : 'null'} - new requests will use new cache key`);
          } else {
            logger.debug(`No art providers in config or oldConfig`);
          }
          
          // MDBList catalog changes - affects specific catalog cache
          if (config.catalogs && oldConfig?.catalogs) {
            const oldMdbCatalogs = oldConfig.catalogs.filter(c => c.id?.startsWith('mdblist.'));
            const newMdbCatalogs = config.catalogs.filter(c => c.id?.startsWith('mdblist.'));
            
            // Check if any MDBList catalog sort/order settings changed
            let mdblistChanged = false;
            const changedCatalogs = [];
            
            for (const newCatalog of newMdbCatalogs) {
              const oldCatalog = oldMdbCatalogs.find(c => c.id === newCatalog.id && c.type === newCatalog.type);
              if (oldCatalog) {
                if (newCatalog.sort !== oldCatalog.sort || newCatalog.order !== oldCatalog.order) {
                  mdblistChanged = true;
                  changedCatalogs.push(newCatalog.id);
                  logger.debug(`MDBList catalog ${newCatalog.id} sort/order changed:`, {
                    old: { sort: oldCatalog.sort, order: oldCatalog.order },
                    new: { sort: newCatalog.sort, order: newCatalog.order }
                  });
                }
              }
            }
            
            if (mdblistChanged) {
              // Clear cache for specific MDBList catalogs that changed
              for (const catalogId of changedCatalogs) {
                const pattern = `*${catalogId}*`;
                patterns.push(pattern);
                logger.debug(`Added cache invalidation pattern for MDBList catalog: ${pattern}`);
              }
            }
          }
          
          // Clear cache patterns if any changes were detected
          if (patterns.length > 0) {
            logger.debug(`Clearing cache patterns:`, patterns);
            
            // Clear each pattern
            for (const pattern of patterns) {
              try {
                const deleted = await deleteKeysByPattern(pattern);
                if (deleted > 0) {
                  logger.debug(`Cleared ${deleted} cache entries for pattern: ${pattern}`);
                }
              } catch (patternError) {
                logger.error(`Error clearing cache pattern ${pattern}:`, patternError);
              }
            }
            
            logger.debug(`Cache invalidation completed for user ${userUUID}`);
          } else {
            logger.debug(`No cache patterns to clear - no relevant config changes detected`);
          }
        } catch (cacheError) {
          logger.error(`Error during cache invalidation:`, cacheError);
        }
      } catch (redisError) {
        logger.error(`Error accessing Redis for cache invalidation:`, redisError);
      }
      
      const hostEnv2 = process.env.HOST_NAME;
      const baseUrl2 = hostEnv2
        ? (hostEnv2.startsWith('http') ? hostEnv2 : `https://${hostEnv2}`)
        : `https://${req.get('host')}`;
      
      res.json({
        success: true,
        userUUID,
        installUrl: `${baseUrl2}/stremio/${userUUID}/manifest.json`,
        message: 'Configuration updated successfully'
      });
    } catch (error) {
      logger.error('Update config error:', error);
      res.status(500).json({ error: 'Failed to update configuration' });
    }
  }

  // Migrate from localStorage (for backward compatibility)
  async migrateFromLocalStorage(req, res) {
    try {
      await this.initialize();
      
      const { localStorageData, password } = req.body;
      
      if (!localStorageData) {
        return res.status(400).json({ error: 'localStorage data is required' });
      }

      if (!password) {
        return res.status(400).json({ error: 'Password is required' });
      }

      const userUUID = await database.migrateFromLocalStorage(localStorageData, password);
      
      if (!userUUID) {
        return res.status(400).json({ error: 'Failed to migrate localStorage data' });
      }
      // Always trust the UUID after migration
      await database.trustUUID(userUUID);

      const config = await database.getUserConfig(userUUID);

      const hostEnv3 = process.env.HOST_NAME;
      const baseUrl3 = hostEnv3
        ? (hostEnv3.startsWith('http') ? hostEnv3 : `https://${hostEnv3}`)
        : `https://${req.get('host')}`;
      res.json({
        success: true,
        userUUID,
        installUrl: `${baseUrl3}/stremio/${userUUID}/manifest.json`,
        message: 'Migration completed successfully'
      });
    } catch (error) {
      logger.error('Migration error:', error);
      res.status(500).json({ error: 'Failed to migrate data' });
    }
  }

  // Get database stats (admin endpoint)
  async getStats(req, res) {
    try {
      await this.initialize();
      
      const userConfigs = await database.allQuery('SELECT COUNT(*) as count FROM user_configs');

      res.json({
        success: true,
        stats: {
          userConfigs: userConfigs[0]?.count || 0
        }
      });
    } catch (error) {
      logger.error('Get stats error:', error);
      res.status(500).json({ error: 'Failed to get database stats' });
    }
  }

  // Check if addon password is required
  async getAddonInfo(req, res) {
    try {
      const requiresAddonPassword = !!(process.env.ADDON_PASSWORD && process.env.ADDON_PASSWORD.length > 0);
      
      res.json({
        success: true,
        requiresAddonPassword,
        version: process.env.npm_package_version || '1.0.0'
      });
    } catch (error) {
      logger.error('Get addon info error:', error);
      res.status(500).json({ error: 'Failed to get addon information' });
    }
  }

  // Check if a UUID is trusted and if addon password is required
  async isTrusted(req, res) {
    try {
      await this.initialize();
      const { uuid } = req.params;
      if (!uuid) return res.status(400).json({ error: 'UUID is required' });
      const trusted = await database.isUUIDTrusted(uuid);
      const requiresAddonPassword = !!(process.env.ADDON_PASSWORD && process.env.ADDON_PASSWORD.length > 0);
      res.json({ trusted, requiresAddonPassword });
    } catch (error) {
      logger.error('isTrusted error:', error);
      res.status(500).json({ error: 'Failed to check trust status' });
    }
  }

  // Load configuration from database by UUID (for internal use)
  async loadConfigFromDatabase(userUUID) {
    try {
      await this.initialize();
      
      if (!userUUID) {
        throw new Error('userUUID is required');
      }

      // Use getOrLoad for stampede protection - only one DB load per expired key
      return await configCache.getOrLoad(userUUID, async () => {
        logger.debug(`❌ Config cache MISS for user ${userUUID.substring(0, 8)}..., loading from database`);

        // Load from database
        const config = await database.getUserConfig(userUUID);
        if (!config) {
          throw new Error(`No configuration found for userUUID: ${userUUID}`);
        }
        
        // Migrate old property names to new ones
        if (config.search?.engineRPDB && !config.search?.engineRatingPosters) {
          config.search.engineRatingPosters = config.search.engineRPDB;
          delete config.search.engineRPDB;
        }
        
        // Migrate catalogs
        if (config.catalogs && Array.isArray(config.catalogs)) {
          config.catalogs = config.catalogs.map(catalog => {
            if (catalog.enableRPDB !== undefined && catalog.enableRatingPosters === undefined) {
              return {
                ...catalog,
                enableRatingPosters: catalog.enableRPDB,
                enableRPDB: undefined
              };
            }
            return catalog;
          });
        }

        // Strip instance-specific fields that shouldn't be returned from saved config
        const sanitizedConfig = {
          ...config,
          apiKeys: {
            ...config.apiKeys,
            customDescriptionBlurb: undefined
          }
        };

        logger.debug(`⚡ Config loaded and cached for user ${userUUID.substring(0, 8)}...`);
        return sanitizedConfig;
      });
    } catch (error) {
      logger.error('loadConfigFromDatabase error:', error);
      throw error;
    }
  }

  // Get all ID mapping corrections (admin endpoint)
  async getCorrections(req, res) {
    try {
      const { loadCorrections } = require('./id-mapper');
      await loadCorrections();
      
      const fs = require('fs').promises;
      const path = require('path');
      const correctionsPath = path.join(process.cwd(), 'addon', 'data', 'id-mapping-corrections.json');
      
      try {
        const correctionsData = await fs.readFile(correctionsPath, 'utf-8');
        const corrections = JSON.parse(correctionsData);
        
        res.json({
          success: true,
          corrections
        });
      } catch (error) {
        if (error.code === 'ENOENT') {
          res.json({
            success: true,
            corrections: []
          });
        } else {
          throw error;
        }
      }
    } catch (error) {
      logger.error('Get corrections error:', error);
      res.status(500).json({ error: 'Failed to get corrections' });
    }
  }

  // Add a new ID mapping correction (admin endpoint)
  async addCorrection(req, res) {
    try {
      const { addonPassword } = req.body;
      
      // Check addon password if one is set
      if (process.env.ADDON_PASSWORD && process.env.ADDON_PASSWORD.length > 0) {
        if (!addonPassword || addonPassword !== process.env.ADDON_PASSWORD) {
          return res.status(401).json({ error: 'Invalid addon password. Contact the addon administrator.' });
        }
      }

      const { type, sourceId, correctedField, correctedId, reason } = req.body;
      
      if (!type || !sourceId || !correctedField || !correctedId) {
        return res.status(400).json({ 
          error: 'Missing required fields: type, sourceId, correctedField, correctedId' 
        });
      }

      const { addCorrection } = require('./id-mapper');
      const success = await addCorrection({
        type,
        sourceId,
        correctedField,
        correctedId,
        reason
      });

      if (success) {
        res.json({
          success: true,
          message: 'Correction added successfully'
        });
      } else {
        res.status(500).json({ error: 'Failed to add correction' });
      }
    } catch (error) {
      logger.error('Add correction error:', error);
      res.status(500).json({ error: 'Failed to add correction' });
    }
  }

  // Remove an ID mapping correction (admin endpoint)
  async removeCorrection(req, res) {
    try {
      const { addonPassword } = req.body;
      
      // Check addon password if one is set
      if (process.env.ADDON_PASSWORD && process.env.ADDON_PASSWORD.length > 0) {
        if (!addonPassword || addonPassword !== process.env.ADDON_PASSWORD) {
          return res.status(401).json({ error: 'Invalid addon password. Contact the addon administrator.' });
        }
      }

      const { type, sourceId, correctedField } = req.body;
      
      if (!type || !sourceId || !correctedField) {
        return res.status(400).json({ 
          error: 'Missing required fields: type, sourceId, correctedField' 
        });
      }

      const { removeCorrection } = require('./id-mapper');
      const success = await removeCorrection(type, sourceId, correctedField);

      if (success) {
        res.json({
          success: true,
          message: 'Correction removed successfully'
        });
      } else {
        res.status(404).json({ error: 'Correction not found' });
      }
    } catch (error) {
      logger.error('Remove correction error:', error);
      res.status(500).json({ error: 'Failed to remove correction' });
    }
  }

    async testApiKeys(req, res) {
    try {
      await this.initialize();
      const { apiKeys } = req.body;
      if (!apiKeys) {
        return res.status(400).json({ error: "apiKeys object is required" });
      }

      const serviceRequest = async (url, options = {}, retries = 2) => {
        for (let i = 0; i <= retries; i++) {
          try {
            const response = await request(url, {
              ...options,
              headers: { "User-Agent": `AIOMetadata/${packageJson.version}`, ...options.headers },
              signal: AbortSignal.timeout(5000),
            });

            // Fail immediately on authorization errors.
            if (response.statusCode === 401 || response.statusCode === 403) {
              return { statusCode: response.statusCode, data: null };
            }

            // For other errors, allow retrying.
            if (response.statusCode < 200 || response.statusCode >= 300) {
              throw new Error(
                `Request failed with status code ${response.statusCode}`,
              );
            }

            const body = await response.body.json().catch(() => ({}));
            return { statusCode: response.statusCode, data: body };
          } catch (error) {
            if (i === retries) throw error;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
      };

      const testFunctions = {
        gemini: async (key) => {
          // Validate by listing available models - no token usage
          // Use Gemini-specific proxy if configured
          const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
          const response = await serviceRequest(url, {
            method: "GET",
            dispatcher: geminiDispatcher
          }).catch(
            () => null,
          );
          return !!(response && response.statusCode === 200 && response.data?.models);
        },

        tmdb: async (key) => {
          const url = `https://api.themoviedb.org/3/configuration?api_key=${key}`;
          const response = await serviceRequest(url, { method: "GET" }).catch(
            () => null,
          );
          return response && response.statusCode === 200;
        },

        tvdb: async (key) => {
          const url = "https://api4.thetvdb.com/v4/login";
          const bodyContent = JSON.stringify({ apikey: key });

          const options = {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: Buffer.from(bodyContent),
          };

          const response = await serviceRequest(url, options).catch((err) => {
            return null;
          });

          const isValid = !!(
            response &&
            response.statusCode === 200 &&
            response.data?.data?.token
          );
          return isValid;
        },

        fanart: async (key) => {
          const url = `https://webservice.fanart.tv/v3/movies/603?api_key=${key}`;
          const response = await serviceRequest(url, { method: "GET" }).catch(
            () => null,
          );
          return response && response.statusCode === 200;
        },

        rpdb: async (key) => {
          const url = `https://api.ratingposterdb.com/${key}/isValid`;
          const response = await serviceRequest(url, { method: "GET" }).catch(
            () => null,
          );
          return (
            response &&
            response.statusCode === 200 &&
            response.data?.valid === true
          );
        },

        topPoster: async (key) => {
          const url = `https://api.top-streaming.stream/auth/verify/${key}`;
          const response = await serviceRequest(url, { method: "GET" }).catch(
            () => null,
          );
          return (
            response &&
            response.statusCode === 200 &&
            response.data?.valid === true &&
            response.data?.is_active === true
          );
        },

        mdblist: async (key) => {
          try {
            const { makeRateLimitedMDBListRequest } = require('../utils/mdbList');
            const url = `https://api.mdblist.com/lists/user?apikey=${key}`;
            const response = await makeRateLimitedMDBListRequest(url, key, 'MDBList API Key Test');
            // Rate-limited request returns response with .data property on success
            return response && (response.data !== undefined || Array.isArray(response.data));
          } catch (error) {
            // Rate limiter throws on failure, return false
            return false;
          }
        },
      };

      const promises = Object.entries(apiKeys)
        .filter(([key, value]) => value && testFunctions[key])
        .map(async ([key, value]) => {
          const isValid = await testFunctions[key](value);
          return [key, isValid];
        });

      const resultsArray = await Promise.all(promises);
      const results = Object.fromEntries(resultsArray);

      res.json({ success: true, results });
    } catch (error) {
      res.status(500).json({ error: "Failed to test API keys" });
    }
  }
}

const configApi = new ConfigApi();

module.exports = {
  saveConfig: configApi.saveConfig.bind(configApi),
  loadConfig: configApi.loadConfig.bind(configApi),
  updateConfig: configApi.updateConfig.bind(configApi),
  migrateFromLocalStorage: configApi.migrateFromLocalStorage.bind(configApi),
  getStats: configApi.getStats.bind(configApi),
  getAddonInfo: configApi.getAddonInfo.bind(configApi),
  isTrusted: configApi.isTrusted.bind(configApi),
  loadConfigFromDatabase: configApi.loadConfigFromDatabase.bind(configApi),
  getCorrections: configApi.getCorrections.bind(configApi),
  addCorrection: configApi.addCorrection.bind(configApi),
  removeCorrection: configApi.removeCorrection.bind(configApi),
  testApiKeys: configApi.testApiKeys.bind(configApi)
};
