import React, { createContext, useContext, useState, useEffect, useRef  } from "react";
import { AppConfig, CatalogConfig, SearchConfig } from "./config";
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';
import { allCatalogDefinitions, allSearchProviders } from "@/data/catalogs"; 

interface AuthState {
  authenticated: boolean;
  userUUID: string | null;
  password: string | null; // ephemeral, in-memory only
}

interface ConfigContextType {
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  addonVersion: string;
  resetConfig: () => Promise<void>;
  auth: AuthState;
  setAuth: React.Dispatch<React.SetStateAction<AuthState>>;
}

const ConfigContext = createContext<ConfigContextType | undefined>(undefined);

const CONFIG_STORAGE_KEY = 'stremio-addon-config';

let initialConfigFromSources: AppConfig | null = null;
let hasInitialized = false;

function initializeConfigFromSources(): AppConfig | null {
  if (hasInitialized) {
    return initialConfigFromSources;
  }
  hasInitialized = true;

  let loadedConfig: any = null; 

  try {
    const pathParts = window.location.pathname.split('/');
    const configStringIndex = pathParts.findIndex(p => p.toLowerCase() === 'configure');
    
    // Only load config from URL if it's NOT a Stremio UUID-based URL
    // Stremio UUID URLs should require authentication
    const isStremioUUIDUrl = pathParts.includes('stremio') && 
                            configStringIndex > 1 && 
                            pathParts[configStringIndex - 2] && 
                            pathParts[configStringIndex - 2].match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    
    if (configStringIndex > 0 && pathParts[configStringIndex - 1] && !isStremioUUIDUrl) {
      const decompressed = decompressFromEncodedURIComponent(pathParts[configStringIndex - 1]);
      if (decompressed) {
        console.log('[Config] Initializing from URL.');
        loadedConfig = JSON.parse(decompressed);
        window.history.replaceState({}, '', '/configure');
      }
    }
  } catch (e) { /* Fall through */ }

  // Note: localStorage initialization removed - configurations now stored in database

  if (loadedConfig) {
    const providers = loadedConfig.search?.providers;
    if (providers && providers.anime) {
      console.log("[Config Migration] Old 'anime' provider found. Upgrading configuration...");
      
      providers.anime_movie = providers.anime_movie || 'mal.search.movie';
      providers.anime_series = providers.anime_series || 'mal.search.series';
      
      delete providers.anime;
      
      try {
        localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(loadedConfig));
        console.log("[Config Migration] Migrated config saved back to localStorage.");
      } catch (e) {
        console.error("[Config Migration] Failed to save migrated config:", e);
      }
    }
  }

  initialConfigFromSources = loadedConfig;
  return initialConfigFromSources;
}


// --- Define the initial, default state for a new user ---
const initialConfig: AppConfig = {
  language: "en-US",
  includeAdult: false,
  blurThumbs: false,
  showPrefix: false,
  castCount: 10,
  providers: { movie: 'tmdb', series: 'tvdb', anime: 'mal', anime_id_provider: 'imdb', },
  artProviders: { movie: 'tmdb', series: 'tvdb', anime: 'mal' },
  tvdbSeasonType: 'default',
  mal: {
    skipFiller: false, 
    skipRecap: false,
  },
  apiKeys: { 
    gemini: "", 
    tmdb: "",
    tvdb: "",
    fanart: "", 
    rpdb: "", 
    mdblist: "" 
  },
  ageRating: 'None',
  searchEnabled: true,
  sessionId: "",
  catalogs: allCatalogDefinitions
    .map(c => ({
      id: c.id,
      name: c.name,
      type: c.type,
      source: c.source,
      enabled: c.isEnabledByDefault || false,
      showInHome: c.showOnHomeByDefault || false,
    })),
  search: {
    enabled: true,
    ai_enabled: false,
    providers: {
      movie: 'tmdb.search',
      series: 'tvdb.search',
      anime_movie: 'mal.search.movie',
      anime_series: 'mal.search.series',
    },
    engineEnabled: {
      'tmdb.search': true,
      'tvdb.search': true,
      'tvmaze.search': true,
      'mal.search.movie': true,
      'mal.search.series': true,
    },
  },
  streaming: [], // Added to satisfy AppConfig interface
};

const defaultCatalogs = allCatalogDefinitions.map(c => ({
  id: c.id,
  name: c.name,
  type: c.type,
  source: c.source,
  enabled: c.isEnabledByDefault || false,
  showInHome: c.showOnHomeByDefault || false,
}));


export function ConfigProvider({ children }: { children: React.ReactNode }) {
  const [addonVersion, setAddonVersion] = useState<string>(' ');
  const [preloadedConfig] = useState(initializeConfigFromSources);
  const [auth, setAuth] = useState<AuthState>({ authenticated: false, userUUID: null, password: null });
  const [config, setConfig] = useState<AppConfig>(() => {
    if (preloadedConfig) {
      let hydratedCatalogs = [...defaultCatalogs];
      
      if (preloadedConfig.catalogs && preloadedConfig.catalogs.length > 0) {
          const userCatalogSettings = new Map(
              preloadedConfig.catalogs.map(c => [`${c.id}-${c.type}`, { enabled: c.enabled, showInHome: c.showInHome }])
          );

          // Always merge in new catalogs from allCatalogDefinitions
          // MIGRATION: Ensure all catalogs from allCatalogDefinitions are present in user configs
          const userCatalogKeys = new Set(preloadedConfig.catalogs.map(c => `${c.id}-${c.type}`));
          const missingCatalogs = defaultCatalogs.filter(def => !userCatalogKeys.has(`${def.id}-${def.type}`));
          const mergedCatalogs = [
            ...missingCatalogs,
            ...preloadedConfig.catalogs
          ];

          hydratedCatalogs = mergedCatalogs.map(defaultCatalog => {
              const key = `${defaultCatalog.id}-${defaultCatalog.type}`;
              if (userCatalogSettings.has(key)) {
                  return { ...defaultCatalog, ...userCatalogSettings.get(key) };
              }
              return defaultCatalog;
          });

          // Remove the old forEach that pushed missing userCatalogs (now handled above)
      }
      // Hydrate search.engineEnabled
      const hydratedEngineEnabled = { ...initialConfig.search.engineEnabled, ...(preloadedConfig.search?.engineEnabled || {}) };
      return {
        ...initialConfig,
        ...preloadedConfig,
        apiKeys: { ...initialConfig.apiKeys, ...preloadedConfig.apiKeys },
        providers: { ...initialConfig.providers, ...preloadedConfig.providers },
        artProviders: { ...initialConfig.artProviders, ...preloadedConfig.artProviders },
        search: {
          ...initialConfig.search,
          ...preloadedConfig.search,
          engineEnabled: hydratedEngineEnabled,
        },
        catalogs: hydratedCatalogs,
      };
    }
    return initialConfig;
  });
  const [isLoading, setIsLoading] = useState(true);

  // --- THIS IS THE CORRECTED EFFECT ---
  useEffect(() => {
    let isMounted = true;
    const finalizeConfig = async () => {
      try {
        const envResponse = await fetch('/api/config');
        if (!isMounted) return;
        const envApiKeys = await envResponse.json();
        console.log('[Config] Server API keys loaded:', envApiKeys);
        setAddonVersion(envApiKeys.addonVersion || ' ');

        // Layer in the server keys with the correct priority.
        // We use `preloadedConfig` because it holds the user's saved data.
        setConfig(currentConfig => ({
          ...currentConfig,
          apiKeys: {
            ...initialConfig.apiKeys,   // Priority 3: Default empty strings
            ...envApiKeys,              // Priority 2: Server-provided keys
            ...preloadedConfig?.apiKeys // Priority 1: User's saved keys (from URL or localStorage)
          }
        }));

      } catch (e) {
        console.error("Could not fetch server-side keys.", e);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };
    finalizeConfig();
    return () => { isMounted = false; };
  }, []); // The empty dependency array is correct.

  // Note: localStorage usage has been removed in favor of database storage
  // Configurations are now saved via the ConfigurationManager component

  const resetConfig = async () => {
    try {
      const envResponse = await fetch('/api/config');
      const envApiKeys = await envResponse.json();
      setConfig({
        ...initialConfig,
        apiKeys: { ...initialConfig.apiKeys, ...envApiKeys },
      });
    } catch (e) {
      // Fallback to pure defaults if env fetch fails
      setConfig(initialConfig);
    }
  };

  if (isLoading) {
    return <div>Loading configuration...</div>;
  }

  return (
    <ConfigContext.Provider value={{ config, setConfig, addonVersion, resetConfig, auth, setAuth }}>
      {children}
    </ConfigContext.Provider>
  );
}

export const useConfig = () => {
  const context = useContext(ConfigContext);
  if (context === undefined) {
    throw new Error('useConfig must be used within a ConfigProvider');
  }
  return context;
};
export type { AppConfig };

export type { CatalogConfig };

