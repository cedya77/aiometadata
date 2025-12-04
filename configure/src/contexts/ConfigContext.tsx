import React, { createContext, useContext, useState, useEffect, useRef  } from "react";
import { AppConfig, CatalogConfig, SearchConfig } from "./config";
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';
import { allCatalogDefinitions, allSearchProviders } from "@/data/catalogs";
import { LoadingScreen } from "@/components/LoadingScreen"; 

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
  hasBuiltInTvdb: boolean;
  hasBuiltInTmdb: boolean;
  catalogTTL: number;
  isLoading: boolean;
  sessionId: string;
  setSessionId: (sessionId: string) => void;
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
      
      // Migration completed - config will be saved to database when user saves
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
  showMetaProviderAttribution: false,
  castCount: 10,
  displayAgeRating: false,
  sfw: false,
  hideUnreleasedDigital: false,
  providers: { movie: 'tmdb', series: 'tvdb', anime: 'mal', anime_id_provider: 'imdb', forceAnimeForDetectedImdb: false },
  artProviders: { 
    movie: { poster: 'meta', background: 'meta', logo: 'meta' },
    series: { poster: 'meta', background: 'meta', logo: 'meta' },
    anime: { poster: 'meta', background: 'imdb', logo: 'imdb' },
    englishArtOnly: false
  },
  tvdbSeasonType: 'default',
  mal: {
    skipFiller: false, 
    skipRecap: false,
    allowEpisodeMarking: false,
    useImdbIdForCatalogAndSearch: false,
  },
  tmdb: {
    scrapeImdb: false,
    forceLatinCastNames: false,
  },
  apiKeys: { 
    gemini: "", 
    tmdb: "",
    tvdb: "",
    fanart: "", 
    rpdb: "", 
    topPoster: "",
    mdblist: "" 
  },
  posterRatingProvider: 'rpdb' as 'rpdb' | 'top',
  mdblistWatchTracking: true,
  enableRatingPostersForLibrary: true, // Default to enabled - keep Rating Posters for library items
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
      enableRatingPosters: true, // Default to enabled for new catalogs
      randomizePerPage: false,
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
      'tvdb.collections.search': false,
      'tvmaze.search': true,
      'mal.search.movie': true,
      'mal.search.series': true,
    },
    providerNames: {},
    searchOrder: ['movie', 'series', 'tvdb.collections.search', 'anime_series', 'anime_movie'],
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
  enableRatingPosters: true, // Default to enabled for new catalogs
  randomizePerPage: false,
}));


export function ConfigProvider({ children }: { children: React.ReactNode }) {
  const [addonVersion, setAddonVersion] = useState<string>(' ');
  const [preloadedConfig] = useState(initializeConfigFromSources);
  const [auth, setAuth] = useState<AuthState>({ authenticated: false, userUUID: null, password: null });
  const [config, setConfig] = useState<AppConfig>(() => {
    if (preloadedConfig) {
      let hydratedCatalogs: CatalogConfig[] = [...defaultCatalogs] as CatalogConfig[];
      
      if (preloadedConfig.catalogs && preloadedConfig.catalogs.length > 0) {
          const userCatalogSettings = new Map(
              preloadedConfig.catalogs.map(c => {
                const settings: CatalogConfig = {
                  id: c.id,
                  name: c.name,
                  type: c.type as any,
                  source: c.source as any,
                  enabled: c.enabled,
                  showInHome: c.showInHome,
                };
                if (c.enableRatingPosters !== undefined) settings.enableRatingPosters = c.enableRatingPosters;
                if (c.randomizePerPage !== undefined) settings.randomizePerPage = c.randomizePerPage;
                if (c.displayType !== undefined) settings.displayType = c.displayType;
                if (c.cacheTTL !== undefined) settings.cacheTTL = c.cacheTTL;
                if (c.genreSelection !== undefined) settings.genreSelection = c.genreSelection;
                if (c.sort !== undefined) settings.sort = c.sort;
                if (c.order !== undefined) settings.order = c.order;
                if (c.pageSize !== undefined) settings.pageSize = c.pageSize;
                return [`${c.id}-${c.type}`, settings];
              })
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
                  return { ...defaultCatalog, ...userCatalogSettings.get(key) } as CatalogConfig;
              }
              return defaultCatalog as CatalogConfig;
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
        artProviders: (() => {
          const defaultArtProviders = initialConfig.artProviders;
          const userArtProviders = preloadedConfig.artProviders;
          
          if (!userArtProviders) return defaultArtProviders;
          
          // Migrate legacy string format to new nested format
          const migratedArtProviders = { ...defaultArtProviders };
          
          ['movie', 'series', 'anime'].forEach(contentType => {
            const userValue = userArtProviders[contentType];
            if (typeof userValue === 'string') {
              // Legacy format: convert single string to nested object
              migratedArtProviders[contentType] = {
                poster: userValue,
                background: userValue,
                logo: userValue
              };
            } else if (userValue && typeof userValue === 'object') {
              // New format: merge with defaults
              migratedArtProviders[contentType] = {
                ...defaultArtProviders[contentType],
                ...userValue
              };
            }
          });
          
          // Handle englishArtOnly property
          if (userArtProviders.englishArtOnly !== undefined) {
            migratedArtProviders.englishArtOnly = userArtProviders.englishArtOnly;
          }
          
          return migratedArtProviders;
        })(),
        search: {
          ...initialConfig.search,
          ...preloadedConfig.search,
          engineEnabled: hydratedEngineEnabled,
        },
        mal: { ...initialConfig.mal, ...preloadedConfig.mal },
        tmdb: { ...initialConfig.tmdb, ...preloadedConfig.tmdb },
        catalogs: hydratedCatalogs,
      };
    }
    return initialConfig;
  });
  const [isLoading, setIsLoading] = useState(true);
  const [hasBuiltInTvdb, setHasBuiltInTvdb] = useState(false);
  const [hasBuiltInTmdb, setHasBuiltInTmdb] = useState(false);
  const [catalogTTL, setCatalogTTL] = useState(86400); // Default to 24 hours

  // --- THIS IS THE CORRECTED EFFECT ---
  useEffect(() => {
    let isMounted = true;
    const finalizeConfig = async () => {
      try {
        const envResponse = await fetch('/api/config');
        if (!isMounted) return;
        const envApiKeys = await envResponse.json();
        setAddonVersion(envApiKeys.addonVersion || ' ');
        setHasBuiltInTvdb(!!envApiKeys.hasBuiltInTvdb);
        setHasBuiltInTmdb(!!envApiKeys.hasBuiltInTmdb);
        setCatalogTTL(envApiKeys.catalogTTL || 86400);

        // Layer in the server keys with the correct priority.
        // We use `preloadedConfig` because it holds the user's saved data.
        setConfig(currentConfig => ({
          ...currentConfig,
          apiKeys: {
            ...initialConfig.apiKeys,   // Priority 3: Default empty strings
            ...envApiKeys,              // Priority 2: Server-provided keys
            ...preloadedConfig?.apiKeys, // Priority 1: User's saved keys (from URL or localStorage)
            // ALWAYS override customDescriptionBlurb from server - it's instance-specific, not user-specific
            customDescriptionBlurb: envApiKeys.customDescriptionBlurb
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
    return <LoadingScreen message="Loading configuration..." />;
  }

  // Helper functions for sessionId
  const sessionId = config.sessionId || "";
  const setSessionId = (newSessionId: string) => {
    setConfig(prev => ({ ...prev, sessionId: newSessionId }));
  };

  return (
    <ConfigContext.Provider value={{ config, setConfig, addonVersion, resetConfig, auth, setAuth, hasBuiltInTvdb, hasBuiltInTmdb, catalogTTL, isLoading, sessionId, setSessionId }}>
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

