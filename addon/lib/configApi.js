const crypto = require('crypto');
const { request, Agent, ProxyAgent } = require("undici");
const database = require('./database');
const buildInfo = require('./buildInfo');
const KEY_VALIDATION_STATUS_SET = new Set(['valid', 'invalid', 'timeout', 'error']);
const isKnownKeyValidationStatus = (status) =>
  typeof status === 'string' && KEY_VALIDATION_STATUS_SET.has(status);
const TESTABLE_API_KEY_FIELDS = new Set(['gemini', 'tmdb', 'tvdb', 'fanart', 'rpdb', 'topPoster', 'mdblist', 'openrouter', 'publicmetadb']);
const TEST_API_KEY_MAX_LENGTH = (() => {
  const parsed = parseInt(process.env.TEST_API_KEY_MAX_LENGTH || '128', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 128;
})();

// Gemini dispatcher configuration for API key testing
// Priority: GEMINI_HTTPS_PROXY/GEMINI_HTTP_PROXY > HTTPS_PROXY/HTTP_PROXY > direct connection
const createGeminiDispatcher = () => {
  // First check for Gemini-specific proxy
  const geminiProxy = process.env.GEMINI_HTTPS_PROXY ?? process.env.GEMINI_HTTP_PROXY;
  if (geminiProxy) {
    try {
      return new ProxyAgent({ uri: new URL(geminiProxy).toString(), allowH2: false });
    } catch (error) {
      console.warn("Invalid Gemini proxy URL:", geminiProxy);
    }
  }
  // Fall back to global proxy
  const globalProxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (globalProxy) {
    try {
      return new ProxyAgent({ uri: new URL(globalProxy).toString(), allowH2: false });
    } catch (error) {
      console.warn("Invalid global proxy URL:", globalProxy);
    }
  }
  // No proxy configured - use direct connection
  return new Agent({
    allowH2: false,
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

  // Optional cap on catalog count per user. Opt-in via MAX_CATALOGS env var.
  // Leaving MAX_CATALOGS unset (the default) preserves the previous unbounded
  // behaviour — nothing is enforced. When set to a positive integer, saves
  // with more than N catalogs are rejected. Some users have accumulated 800+
  // catalogs in the past; every manifest request iterates the full array, so
  // outliers cost 10× the baseline CPU/RAM per request.
  validateCatalogCount(config) {
    const raw = process.env.MAX_CATALOGS;
    if (!raw) return { valid: true };
    const max = Number.parseInt(raw, 10);
    if (!Number.isFinite(max) || max <= 0) return { valid: true };
    const catalogs = config && config.catalogs;
    if (!Array.isArray(catalogs)) return { valid: true };
    if (catalogs.length <= max) return { valid: true };
    return {
      valid: false,
      count: catalogs.length,
      max,
      message: `Too many catalogs (${catalogs.length}); the maximum allowed on this instance is ${max}. Remove some catalogs and try again.`,
    };
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

      // Optional catalog count ceiling (opt-in via MAX_CATALOGS env var)
      const catalogCheck = this.validateCatalogCount(config);
      if (!catalogCheck.valid) {
        return res.status(400).json({
          error: catalogCheck.message,
          catalogCount: catalogCheck.count,
          maxCatalogs: catalogCheck.max,
        });
      }

      await this.sanitizeTraktToken(config);

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
              patterns.push(`v*:catalog:${userUUID}:*`);
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
          
          // Meta provider changes - actively clear user's catalog cache so stale
          // enriched metas (with old provider attribution) are not served.
          if (config.providers && oldConfig?.providers) {
            logger.debug('Comparing providers - old:', oldConfig.providers, 'new:', config.providers);
            const providersChanged = Object.keys(config.providers).some(key =>
              config.providers[key] !== oldConfig.providers?.[key]
            );
            if (providersChanged) {
              logger.info('Providers changed - clearing user catalog cache to avoid stale meta provider data');
              patterns.push(`v*:catalog:${userUUID}:*`);
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
                const pattern = `v*:catalog:${userUUID}:*${catalogId}*`;
                patterns.push(pattern);
                logger.debug(`Added cache invalidation pattern for MDBList catalog: ${pattern}`);
              }
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

      // Optional catalog count ceiling (opt-in via MAX_CATALOGS env var)
      const catalogCheck = this.validateCatalogCount(config);
      if (!catalogCheck.valid) {
        return res.status(400).json({
          error: catalogCheck.message,
          catalogCount: catalogCheck.count,
          maxCatalogs: catalogCheck.max,
        });
      }

      await this.sanitizeTraktToken(config);

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
              patterns.push(`v*:catalog:${userUUID}:*`);
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

          // Meta provider changes - actively clear user's catalog cache so stale
          // enriched metas (with old provider attribution) are not served.
          if (config.providers && oldConfig?.providers) {
            const providersChanged = Object.keys(config.providers).some(key =>
              config.providers[key] !== oldConfig.providers?.[key]
            );
            if (providersChanged) {
              logger.info('Providers changed - clearing user catalog cache to avoid stale meta provider data');
              patterns.push(`v*:catalog:${userUUID}:*`);
            }
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
                const pattern = `v*:catalog:${userUUID}:*${catalogId}*`;
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
      const cachedConfig = await configCache.getOrLoad(userUUID, async () => {
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

        // Default posterRatingProvider for configs that predate the field
        if (!config.posterRatingProvider && (config.apiKeys?.rpdb || config.apiKeys?.topPoster)) {
          config.posterRatingProvider = config.apiKeys?.topPoster ? 'top' : 'rpdb';
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

      return JSON.parse(JSON.stringify(cachedConfig));
    } catch (error) {
      logger.error('loadConfigFromDatabase error:', error);
      throw error;
    }
  }

  buildApiKeyValidationSummary(details) {
    const summary = {
      totalCount: 0,
      validCount: 0,
      failedCount: 0,
      testedKeys: [],
      validKeys: [],
      invalidKeys: [],
      invalidNonQuotaKeys: [],
      quotaExhaustedKeys: [],
      timeoutKeys: [],
      errorKeys: [],
      failureLines: [],
    };

    for (const [key, detail] of Object.entries(details || {})) {
      summary.totalCount += 1;
      summary.testedKeys.push(key);

      if (detail?.status === 'valid') {
        summary.validCount += 1;
        summary.validKeys.push(key);
        continue;
      }

      if (detail?.status === 'invalid') {
        summary.invalidKeys.push(key);
        if (detail.reason === 'quota_exhausted') {
          summary.quotaExhaustedKeys.push(key);
        } else {
          summary.invalidNonQuotaKeys.push(key);
        }
        continue;
      }

      if (detail?.status === 'timeout') {
        summary.timeoutKeys.push(key);
        continue;
      }

      summary.errorKeys.push(key);
    }

    summary.failedCount = summary.totalCount - summary.validCount;

    if (summary.quotaExhaustedKeys.length > 0) {
      summary.failureLines.push(`Quota exhausted: ${summary.quotaExhaustedKeys.join(', ')}`);
    }
    if (summary.invalidNonQuotaKeys.length > 0) {
      summary.failureLines.push(`Invalid: ${summary.invalidNonQuotaKeys.join(', ')}`);
    }
    if (summary.timeoutKeys.length > 0) {
      summary.failureLines.push(`Timed out: ${summary.timeoutKeys.join(', ')}`);
    }
    if (summary.errorKeys.length > 0) {
      summary.failureLines.push(`Errors: ${summary.errorKeys.join(', ')}`);
    }

    return summary;
  }

  validateAndNormalizeTestApiKeys(apiKeys) {
    if (!apiKeys || typeof apiKeys !== 'object' || Array.isArray(apiKeys)) {
      return { error: "apiKeys must be a plain object." };
    }

    const prototype = Object.getPrototypeOf(apiKeys);
    if (prototype !== Object.prototype && prototype !== null) {
      return { error: "apiKeys must be a plain object." };
    }

    const normalizedApiKeys = {};

    for (const [key, value] of Object.entries(apiKeys)) {
      if (!TESTABLE_API_KEY_FIELDS.has(key)) {
        return { error: `Unsupported apiKeys field '${key}'.` };
      }

      if (typeof value !== 'string') {
        return { error: `API key '${key}' must be a string.` };
      }

      const trimmedValue = value.trim();
      if (trimmedValue.length === 0) {
        continue;
      }

      if (trimmedValue.length > TEST_API_KEY_MAX_LENGTH) {
        return { error: `API key '${key}' exceeds max length (${TEST_API_KEY_MAX_LENGTH}).` };
      }

      normalizedApiKeys[key] = trimmedValue;
    }

    if (Object.keys(normalizedApiKeys).length === 0) {
      return { error: "At least one non-empty API key is required." };
    }

    return { apiKeys: normalizedApiKeys };
  }

  async validateApiKeys(apiKeys) {
    const KEY_TEST_TIMEOUT_MS = Math.max(
      1000,
      parseInt(process.env.API_KEY_TEST_TIMEOUT_MS || '8000', 10)
    );

    const withTimeout = (promise, timeoutMs, keyName) =>
      new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          const timeoutError = new Error(`Validation timed out for ${keyName} after ${timeoutMs}ms`);
          timeoutError.code = 'API_KEY_TEST_TIMEOUT';
          reject(timeoutError);
        }, timeoutMs);

        Promise.resolve(promise)
          .then((value) => {
            clearTimeout(timeoutId);
            resolve(value);
          })
          .catch((error) => {
            clearTimeout(timeoutId);
            reject(error);
          });
      });

    const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
    const RETRYABLE_ERROR_CODES = new Set([
      'ABORT_ERR',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_SOCKET',
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ENOTFOUND',
    ]);
    const TIMEOUT_ERROR_CODES = new Set([
      'API_KEY_TEST_TIMEOUT',
      'ABORT_ERR',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'ETIMEDOUT',
    ]);

    const getErrorCode = (err) => err?.code || err?.cause?.code;

    const getHttpStatusCode = (err) => {
      const candidates = [
        err?.statusCode,
        err?.response?.status,
        err?.cause?.statusCode,
        err?.cause?.response?.status,
      ];

      for (const candidate of candidates) {
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
          return candidate;
        }
        if (typeof candidate === 'string' && candidate.trim() !== '') {
          const parsed = Number(candidate);
          if (Number.isFinite(parsed)) {
            return parsed;
          }
        }
      }

      return undefined;
    };

    const isInvalidKeyStatusCode = (statusCode) => {
      if (typeof statusCode !== 'number') {
        return false;
      }
      if (statusCode === 400 || statusCode === 401 || statusCode === 403) {
        return true;
      }
      return statusCode >= 400 && statusCode < 500 && statusCode !== 429;
    };

    const isTimeoutLikeError = (error) => {
      const code = getErrorCode(error);
      return (
        (typeof code === 'string' && TIMEOUT_ERROR_CODES.has(code)) ||
        error?.name === 'TimeoutError'
      );
    };

    const shouldRetryApiKeyTestError = (error) => {
      const statusCode = getHttpStatusCode(error);
      if (typeof statusCode === 'number') {
        return RETRYABLE_STATUS_CODES.has(statusCode);
      }

      const code = getErrorCode(error);
      return typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code);
    };

    const normalizeErrorStatus = (error) => {
      if (!error) {
        return { status: 'error', message: 'Unknown error' };
      }

      const code = getErrorCode(error);
      const message = error.message || 'Unexpected error during validation';
      const normalizedStatusCode = getHttpStatusCode(error);

      if (code === 'MDBLIST_QUOTA_EXHAUSTED') {
        return { status: 'invalid', reason: 'quota_exhausted', message };
      }

      if (isTimeoutLikeError(error)) {
        return { status: 'timeout', message };
      }

      if (isInvalidKeyStatusCode(normalizedStatusCode)) {
        return { status: 'invalid', message };
      }

      return { status: 'error', message };
    };

    const serviceRequest = async (url, options = {}, retries = 2) => {
      for (let i = 0; i <= retries; i++) {
        try {
          const response = await request(url, {
            ...options,
            headers: { "User-Agent": `AIOMetadata/${buildInfo.version}`, ...options.headers },
            signal: AbortSignal.timeout(5000),
          });

          if (response.statusCode >= 200 && response.statusCode < 300) {
            const body = await response.body.json().catch(() => ({}));
            return { statusCode: response.statusCode, data: body };
          }

          const statusError = new Error(
            `Request failed with status code ${response.statusCode}`,
          );
          statusError.statusCode = response.statusCode;
          throw statusError;
        } catch (error) {
          const isLastAttempt = i === retries;
          if (isLastAttempt || !shouldRetryApiKeyTestError(error)) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    };

    const testFunctions = {
      gemini: async (key) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models`;
        const response = await serviceRequest(url, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": key,
          },
          dispatcher: geminiDispatcher
        });
        return !!(response && response.statusCode === 200);
      },

      tmdb: async (key) => {
        const url = `https://api.themoviedb.org/3/configuration?api_key=${key}`;
        const response = await serviceRequest(url, { method: "GET" });
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

        const response = await serviceRequest(url, options);

        const isValid = !!(
          response &&
          response.statusCode === 200 &&
          response.data?.data?.token
        );
        return isValid;
      },

      fanart: async (key) => {
        const url = `https://webservice.fanart.tv/v3/movies/603?api_key=${key}`;
        const response = await serviceRequest(url, { method: "GET" });
        return response && response.statusCode === 200;
      },

      rpdb: async (key) => {
        const url = `https://api.ratingposterdb.com/${key}/isValid`;
        const response = await serviceRequest(url, { method: "GET" });
        return (
          response &&
          response.statusCode === 200 &&
          response.data?.valid === true
        );
      },

      topPoster: async (key) => {
        const url = `https://api.top-posters.com/auth/verify/${key}`;
        const response = await serviceRequest(url, { method: "GET" });
        return (
          response &&
          response.statusCode === 200 &&
          response.data?.valid === true &&
          response.data?.is_active === true
        );
      },

      mdblist: async (key) => {
        const { testMdblistKey } = require('../utils/mdbList');
        return await testMdblistKey(key);
      },

      publicmetadb: async (key) => {
        const { validateKey } = require('../utils/publicmetadbUtils');
        return await validateKey(key);
      },

      openrouter: async (key) => {
        const response = await serviceRequest('https://openrouter.ai/api/v1/auth/key', {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${key}` },
        });
        return response?.statusCode === 200;
      },
    };

    const validationPromises = Object.entries(apiKeys)
      .filter(([key, value]) => typeof value === 'string' && value.length > 0 && testFunctions[key])
      .map(async ([key, value]) => {
        const startedAt = Date.now();

        try {
          const result = await withTimeout(testFunctions[key](value), KEY_TEST_TIMEOUT_MS, key);

          if (
            result &&
            typeof result === 'object' &&
            isKnownKeyValidationStatus(result.status)
          ) {
            return [
              key,
              {
                status: result.status,
                reason: typeof result.reason === 'string' ? result.reason : undefined,
                message: typeof result.message === 'string' ? result.message : undefined,
                durationMs: Date.now() - startedAt,
              },
            ];
          }

          const isValid = !!result;
          return [key, { status: isValid ? 'valid' : 'invalid', durationMs: Date.now() - startedAt }];
        } catch (error) {
          const normalizedError = normalizeErrorStatus(error);
          return [key, { ...normalizedError, durationMs: Date.now() - startedAt }];
        }
      });

    const detailsEntries = await Promise.all(validationPromises);
    const details = Object.fromEntries(detailsEntries);
    const summary = this.buildApiKeyValidationSummary(details);

    return { details, summary };
  }

  async testApiKeys(req, res) {
    try {
      await this.initialize();
      const { apiKeys } = req.body;
      const validation = this.validateAndNormalizeTestApiKeys(apiKeys);
      if (validation.error) {
        return res.status(400).json({ error: validation.error });
      }

      const { details, summary } = await this.validateApiKeys(validation.apiKeys);
      res.json({ success: true, details, summary });
    } catch (error) {
      logger.error('API key testing failed:', error);
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
  testApiKeys: configApi.testApiKeys.bind(configApi)
};
