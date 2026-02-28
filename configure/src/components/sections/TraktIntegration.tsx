import React, { useState, useEffect } from 'react';
import { useConfig, CatalogConfig } from '@/contexts/ConfigContext';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ExternalLink, CheckCircle2, XCircle, Trash2, Plus, Loader2, ChevronDown } from 'lucide-react';
import { toast } from "sonner";
import { apiCache } from '@/utils/apiCache';
import { createTraktCatalog } from '@/utils/catalogUtils';

interface TraktIntegrationProps {
  isOpen: boolean;
  onClose: () => void;
}

import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';

const VIP_SORT_OPTIONS = [
  'imdb_rating',
  'tmdb_rating',
  'rt_tomatometer',
  'rt_audience',
  'metascore',
  'votes',
  'imdb_votes',
  'tmdb_votes',
];

const SORT_OPTIONS = [
  { value: 'default', label: 'Default (Original Order)' },
  { value: 'rank', label: 'Rank' },
  { value: 'added', label: 'Added' },
  { value: 'title', label: 'Title' },
  { value: 'released', label: 'Released' },
  { value: 'runtime', label: 'Runtime' },
  { value: 'popularity', label: 'Popularity' },
  { value: 'random', label: 'Random' },
  { value: 'percentage', label: 'Percentage' },
  { value: 'imdb_rating', label: 'IMDb Rating', vip: true },
  { value: 'tmdb_rating', label: 'TMDb Rating', vip: true },
  { value: 'rt_tomatometer', label: 'RT Tomatometer', vip: true },
  { value: 'rt_audience', label: 'RT Audience', vip: true },
  { value: 'metascore', label: 'Metascore', vip: true },
  { value: 'votes', label: 'Votes', vip: true },
  { value: 'imdb_votes', label: 'IMDb Votes', vip: true },
  { value: 'tmdb_votes', label: 'TMDb Votes', vip: true },
  { value: 'my_rating', label: 'My Rating' },
  { value: 'watched', label: 'Watched' },
  { value: 'collected', label: 'Collected' },
];

const MOST_FAVORITED_PERIODS = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'all', label: 'All Time' },
];

// Helper for formatting large numbers
function formatNumber(n: number) {
  return n?.toLocaleString() ?? '0';
}

const getDisplayTypeOverride = (
  catalogType: 'movie' | 'series' | 'anime' | 'all',
  overrides?: { movie?: string; series?: string }
): string | undefined => {
  if (!overrides) return undefined;
  if (catalogType === 'movie' && overrides.movie) return overrides.movie;
  if (catalogType === 'series' && overrides.series) return overrides.series;
  return undefined;
};

export function TraktIntegration({ isOpen, onClose }: TraktIntegrationProps) {
    const [traktClientId, setTraktClientId] = useState<string>("");
    useEffect(() => {
      fetch("/api/config")
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data && data.trakt) setTraktClientId(data.trakt);
        });
    }, []);
  const { config, setConfig, auth } = useConfig();
  const [tempTokenId, setTempTokenId] = useState(config.apiKeys?.traktTokenId || "");
  const [isConnected, setIsConnected] = useState(!!config.apiKeys?.traktTokenId);
  const [customListUrl, setCustomListUrl] = useState("");
  const [customListType, setCustomListType] = useState<'all' | 'split'>('all');
  const [disconnecting, setDisconnecting] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [loadingUsername, setLoadingUsername] = useState(false);
  const [watchlistSortBy, setWatchlistSortBy] = useState('default');
  const [watchlistSortHow, setWatchlistSortHow] = useState<'asc' | 'desc'>('asc');
  const [customListSortBy, setCustomListSortBy] = useState('default');
  const [customListSortHow, setCustomListSortHow] = useState<'asc' | 'desc'>('asc');
  const [listPreview, setListPreview] = useState<any>(null);
  const [listPreviewPending, setListPreviewPending] = useState(false);
  const [traktUsername, setTraktUsername] = useState("");
  const [traktUserLists, setTraktUserLists] = useState<any[]>([]);
  const [selectedTraktLists, setSelectedTraktLists] = useState<Set<string>>(new Set());
  const [isLoadingTraktUser, setIsLoadingTraktUser] = useState(false);
  const [userStats, setUserStats] = useState<any>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [statsCollapsed, setStatsCollapsed] = useState(true);
  const [trendingLists, setTrendingLists] = useState<any[]>([]);
  const [popularLists, setPopularLists] = useState<any[]>([]);
  const [isLoadingTrending, setIsLoadingTrending] = useState(false);
  const [isLoadingPopular, setIsLoadingPopular] = useState(false);
  const [selectedTrendingLists, setSelectedTrendingLists] = useState<Set<string>>(new Set());
  const [trendingListType, setTrendingListType] = useState<'personal' | 'official'>('personal');
  const [likedLists, setLikedLists] = useState<any[]>([]);
  const [selectedLikedLists, setSelectedLikedLists] = useState<Set<string>>(new Set());
  const [isLoadingLikedLists, setIsLoadingLikedLists] = useState(false);
  const [favoriteSortBy, setFavoriteSortBy] = useState('default');
  const [favoriteSortHow, setFavoriteSortHow] = useState<'asc' | 'desc'>('asc');
  const [mostFavType, setMostFavType] = useState<'movies' | 'shows'>('movies');
  const [mostFavPeriod, setMostFavPeriod] = useState<'daily' | 'weekly' | 'monthly' | 'all'>('weekly');

  const authUrl = "/api/auth/trakt/authorize";

  useEffect(() => {
    if (isOpen) {
      setIsConnected(!!config.apiKeys?.traktTokenId);
      setTempTokenId(config.apiKeys?.traktTokenId || "");
      
      if (config.apiKeys?.traktTokenId) {
        setLoadingUsername(true);
        fetch("/api/oauth/token/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tokenId: config.apiKeys.traktTokenId }),
        })
          .then(res => res.ok ? res.json() : null)
          .then(data => {
            if (data?.username) setUsername(data.username);
          })
          .catch(() => setUsername(null))
          .finally(() => setLoadingUsername(false));
      } else {
        setUsername(null);
      }
    }
  }, [isOpen, config.apiKeys?.traktTokenId]);

  // Fetch Trakt user stats when username is available and connected
  useEffect(() => {
    if (isConnected && username && traktClientId) {
      setLoadingStats(true);
      const cacheKey = `trakt_stats_${username}`;
      apiCache.cachedFetch(
        cacheKey,
        async () => {
          const response = await fetch(`/api/trakt/users/${username}/stats`);
          return response.ok ? await response.json() : null;
        },
        15 * 60 * 1000 // Cache for 15 minutes
      )
        .then(data => setUserStats(data))
        .catch(() => setUserStats(null))
        .finally(() => setLoadingStats(false));
    } else {
      setUserStats(null);
    }
  }, [isConnected, username, traktClientId]);

  const handleConnect = () => {
    window.open(authUrl, "_blank", "width=600,height=700");
    toast.info("Complete the authorization in the new window and paste the Token ID below");
  };

  const handleSave = async () => {
    if (!tempTokenId.trim()) {
      toast.error("Please enter a valid Token ID");
      return;
    }

    // Fetch username from token to validate and display in UI
    try {
      const response = await fetch("/api/oauth/token/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenId: tempTokenId.trim() }),
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.provider === 'trakt') {
          setUsername(data.username);
          
          setConfig(prev => ({
            ...prev,
            apiKeys: {
              ...prev.apiKeys,
              traktTokenId: tempTokenId.trim(),
            },
          }));

          setIsConnected(true);
          toast.success(`Connected as @${data.username}`);
        } else {
          toast.error("Invalid Trakt token");
        }
      } else {
        toast.error("Invalid token ID");
      }
    } catch (error) {
      console.error("Token validation error:", error);
      toast.error("Failed to validate token");
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      // For guests just clear local state
      if (!auth.userUUID) {
        setConfig(prev => ({
          ...prev,
          apiKeys: {
            ...prev.apiKeys,
            traktTokenId: undefined,
          },
        }));
        setTempTokenId("");
        setIsConnected(false);
        setUsername(null);
        toast.success("Trakt account disconnected");
        setDisconnecting(false);
        return;
      }

      // For registered users, call the backend to clean up database
      const response = await fetch("/api/auth/trakt/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userUUID: auth.userUUID }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || "Failed to disconnect");
      }
      
      setTempTokenId("");
      setIsConnected(false);
      setUsername(null);
      toast.success("Trakt account disconnected");
      
      window.location.reload();
    } catch (error) {
      console.error("Disconnect error:", error);
      toast.error(error.message || "Failed to disconnect Trakt");
    } finally {
      setDisconnecting(false);
    }
  };

  const fetchTraktUserLists = async () => {
    if (!traktUsername.trim()) {
      toast.error("Please enter a Trakt username");
      return;
    }

    setIsLoadingTraktUser(true);
    try {
      if (!traktClientId) {
        throw new Error('Trakt Client ID not configured. Please set TRAKT_CLIENT_ID in your server environment.');
      }
      
      const cacheKey = `trakt_user_lists_${traktUsername.trim()}`;
      const userLists = await apiCache.cachedFetch(
        cacheKey,
        async () => {
          const response = await fetch(`/api/trakt/users/${traktUsername.trim()}/lists`);
          
          if (!response.ok) {
            if (response.status === 404) {
              throw new Error(`User "${traktUsername}" not found or has no public lists`);
            }
            throw new Error(`Failed to fetch lists (Status: ${response.status})`);
          }

          const data = await response.json();
          if (!Array.isArray(data)) {
            throw new Error("Invalid response format from Trakt API");
          }
          return data;
        },
        10 * 60 * 1000 // Cache for 10 minutes
      );

      if (userLists.length === 0) {
        toast.info("No lists found", {
          description: `User "${traktUsername}" has no public lists available`
        });
        setTraktUserLists([]);
      } else {
        setTraktUserLists(userLists);
        setSelectedTraktLists(new Set());
        toast.success("User lists loaded", {
          description: `Found ${userLists.length} list(s) from ${traktUsername}`
        });
      }
    } catch (error) {
      console.error("Error fetching Trakt user lists:", error);
      toast.error("Failed to load user lists", {
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
      setTraktUserLists([]);
    } finally {
      setIsLoadingTraktUser(false);
    }
  };

  const handleTraktListSelection = (listId: string, checked: boolean) => {
    const newSelection = new Set(selectedTraktLists);
    if (checked) {
      newSelection.add(listId);
    } else {
      newSelection.delete(listId);
    }
    setSelectedTraktLists(newSelection);
  };

  const importSelectedTraktLists = () => {
    if (selectedTraktLists.size === 0) {
      toast.error("Please select at least one list to import");
      return;
    }

    try {
      setConfig(prev => {
        let newCatalogs = [...prev.catalogs];
        let importedCount = 0;

        traktUserLists.forEach((list) => {
          if (!selectedTraktLists.has(String(list.ids.trakt))) return;

          const catalogId = `trakt.list.${list.ids.trakt}`;
          // Skip if already exists
          if (newCatalogs.some(c => c.id === catalogId)) {
            return;
          }

          const newCatalog = createTraktCatalog({
            list,
            username: traktUsername.trim(),
            displayTypeOverrides: prev.displayTypeOverrides,
          });

          newCatalogs.push(newCatalog);
          importedCount++;
        });

        return {
          ...prev,
          catalogs: newCatalogs,
        };
      });

      toast.success("Lists imported successfully", {
        description: `${selectedTraktLists.size} list(s) added to your catalogs`
      });

      setSelectedTraktLists(new Set());
    } catch (error) {
      console.error("Error importing lists:", error);
      toast.error("Failed to import lists");
    }
  };

  const handleAddWatchlist = (split: boolean = false) => {
    if (!isConnected) {
      toast.error("Please connect your Trakt account first");
      return;
    }

    const existingCatalogs = config.catalogs.filter(c => !c.id.startsWith("trakt.watchlist"));
    
    if (split) {
      setConfig(prev => {
        const movieDisplayType = getDisplayTypeOverride('movie', prev.displayTypeOverrides);
        const seriesDisplayType = getDisplayTypeOverride('series', prev.displayTypeOverrides);

        const newCatalogs: CatalogConfig[] = [
          {
            id: "trakt.watchlist.movies",
            type: "movie",
            name: "Trakt Watchlist",
            enabled: true,
            showInHome: true,
            source: "trakt",
            ...(movieDisplayType && { displayType: movieDisplayType }),
          },
          {
            id: "trakt.watchlist.series",
            type: "series",
            name: "Trakt Watchlist",
            enabled: true,
            showInHome: true,
            source: "trakt",
            ...(seriesDisplayType && { displayType: seriesDisplayType }),
          },
        ];

        return {
          ...prev,
          catalogs: [...existingCatalogs, ...newCatalogs],
        };
      });

      toast.success("Watchlists added (Movies & Series)");
    } else {
      const newCatalog: CatalogConfig = {
        id: "trakt.watchlist",
        type: "all",
        name: "Trakt Watchlist",
        enabled: true,
        showInHome: true,
        source: "trakt",
      };

      setConfig(prev => ({
        ...prev,
        catalogs: [...existingCatalogs, newCatalog],
      }));

      toast.success("Watchlist added");
    }
  };

  const handleAddCustomList = async () => {
    if (!isConnected) {
      toast.error("Please connect your Trakt account first");
      return;
    }

    try {
      const url = new URL(customListUrl);
      const pathParts = url.pathname.split("/").filter(Boolean);
      if (pathParts.length < 4 || pathParts[0] !== "users" || pathParts[2] !== "lists") {
        throw new Error("Invalid URL format");
      }
      const username = pathParts[1];
      const listSlug = pathParts[3];
      const catalogId = `trakt.${username}.${listSlug}`;
      if (config.catalogs.some(c => c.id === catalogId)) {
        toast.error("This list is already added");
        return;
      }
      setListPreviewPending(true);
      if (!traktClientId) {
        throw new Error('Trakt Client ID not configured. Please set TRAKT_CLIENT_ID in your server environment.');
      }
      const response = await fetch(`/api/trakt/users/${username}/lists/${listSlug}`);
      if (!response.ok) {
        let errorText = `HTTP ${response.status}`;
        try {
          const errJson = await response.json();
          if (errJson && errJson.error) errorText += `: ${errJson.error}`;
        } catch {}
        toast.error("Failed to fetch list details", {
          description: errorText
        });
        setListPreviewPending(false);
        return;
      }
      const listData = await response.json();

      // Parse sort params from URL query string (e.g. ?sort=added,asc)
      const urlSortParam = url.searchParams.get('sort');
      if (urlSortParam) {
        const [sortBy, sortHow] = urlSortParam.split(',');
        if (sortBy) listData.sort_by = sortBy;
        if (sortHow === 'asc' || sortHow === 'desc') listData.sort_how = sortHow;
      }

      const numericListId = listData?.ids?.trakt;
      
        if (customListType === 'split') {
        // Create two separate catalogs for movies and series
        setConfig(prev => {
          const idBase = numericListId ? `trakt.list.${numericListId}` : `${catalogId}`;
          
          const movieCatalog = createTraktCatalog({
            list: listData,
            username,
            sort: customListSortBy,
            sortDirection: customListSortHow,
            displayTypeOverrides: prev.displayTypeOverrides,
            catalogType: 'movie',
          });
          movieCatalog.id = `${idBase}.movies`;
          
          const seriesCatalog = createTraktCatalog({
            list: listData,
            username,
            sort: customListSortBy,
            sortDirection: customListSortHow,
            displayTypeOverrides: prev.displayTypeOverrides,
            catalogType: 'series',
          });
          seriesCatalog.id = `${idBase}.series`;

          return {
            ...prev,
            catalogs: [...prev.catalogs, movieCatalog, seriesCatalog],
          };
        });
        toast.success(`Added: ${listData.name} (Movies & Series)`);
        } else {
        // Create unified catalog
        const newCatalog = createTraktCatalog({
          list: listData,
          username,
          sort: customListSortBy,
          sortDirection: customListSortHow,
          displayTypeOverrides: config.displayTypeOverrides,
        });
        
        setConfig(prev => ({
          ...prev,
          catalogs: [...prev.catalogs, newCatalog],
        }));
        
        toast.success(`Added: ${listData.name}`);
      }
      
      setCustomListUrl("");
      setListPreviewPending(false);
    } catch (error) {
      let description = error instanceof Error ? error.message : String(error);
      toast.error("Error adding Trakt list", {
        description
      });
      setListPreviewPending(false);
    }
  };



  const handleRemoveWatchlist = () => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.filter(c => !c.id.startsWith("trakt.watchlist")),
    }));
    toast.success("Watchlist removed");
  };

  const fetchTrendingLists = async () => {
    if (!traktClientId) {
      toast.error('Trakt Client ID not configured');
      return;
    }
    setIsLoadingTrending(true);
    setPopularLists([]);
    try {
      const cacheKey = `trakt_trending_${trendingListType}`;
      const data = await apiCache.cachedFetch(
        cacheKey,
        async () => {
          const response = await fetch(`/api/trakt/lists/trending/${trendingListType}?limit=100`);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return await response.json();
        },
        10 * 60 * 1000 // Cache for 10 minutes
      );
      setTrendingLists(data);
      setSelectedTrendingLists(new Set());
      toast.success(`Loaded ${data.length} trending lists`);
    } catch (error) {
      toast.error("Failed to fetch trending lists", {
        description: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setIsLoadingTrending(false);
    }
  };

  const fetchPopularLists = async () => {
    if (!traktClientId) {
      toast.error('Trakt Client ID not configured');
      return;
    }
    setIsLoadingPopular(true);
    setTrendingLists([]); // Clear trending lists when loading popular
    try {
      const cacheKey = `trakt_popular_${trendingListType}`;
      const data = await apiCache.cachedFetch(
        cacheKey,
        async () => {
          const response = await fetch(`/api/trakt/lists/popular/${trendingListType}?limit=100`);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return await response.json();
        },
        10 * 60 * 1000 // Cache for 10 minutes
      );
      setPopularLists(data);
      setSelectedTrendingLists(new Set());
      toast.success(`Loaded ${data.length} popular lists`);
    } catch (error) {
      toast.error("Failed to fetch popular lists", {
        description: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setIsLoadingPopular(false);
    }
  };

  const importSelectedTrendingLists = () => {
    const listsToImport = [...trendingLists, ...popularLists].filter(item => {
      if (!item?.list?.ids?.trakt) return false;
      const list = item.list;
      const listKey = String(list.ids.trakt);
      return selectedTrendingLists.has(listKey);
    });

    listsToImport.forEach(item => {
      const list = item.list;
      const catalogId = `trakt.list.${list.ids.trakt}`;
      
      if (config.catalogs.some(c => c.id === catalogId)) {
        return;
      }

      const newCatalog = createTraktCatalog({
        list,
        displayTypeOverrides: config.displayTypeOverrides,
      });

      setConfig(prev => ({
        ...prev,
        catalogs: [...prev.catalogs, newCatalog],
      }));
    });

    toast.success(`Imported ${listsToImport.length} list${listsToImport.length !== 1 ? 's' : ''}`);
    setSelectedTrendingLists(new Set());
  };

  // Handlers to add single-catalog trending/popular endpoints as catalogs
  const handleAddTrendingCatalog = (type: 'movies' | 'shows') => {
    const id = `trakt.trending.${type}`;
    if (config.catalogs.some(c => c.id === id)) {
      toast.info(`Trending ${type} catalog already added.`);
      return;
    }
    const newCatalog: CatalogConfig = {
      id,
      type: type === 'movies' ? 'movie' : 'series',
      name: `Trakt Trending ${type.charAt(0).toUpperCase() + type.slice(1)}`,
      enabled: true,
      showInHome: true,
      source: 'trakt',
      metadata: { traktEndpoint: `trending/${type}` }
    };
    setConfig(prev => ({ ...prev, catalogs: [...prev.catalogs, newCatalog] }));
    toast.success(`Added Trakt Trending ${type}`);
  };

  const handleAddPopularCatalog = (type: 'movies' | 'shows') => {
    const id = `trakt.popular.${type}`;
    if (config.catalogs.some(c => c.id === id)) {
      toast.info(`Popular ${type} catalog already added.`);
      return;
    }
    const newCatalog: CatalogConfig = {
      id,
      type: type === 'movies' ? 'movie' : 'series',
      name: `Trakt Popular ${type.charAt(0).toUpperCase() + type.slice(1)}`,
      enabled: true,
      showInHome: true,
      source: 'trakt',
      metadata: { traktEndpoint: `popular/${type}` }
    };
    setConfig(prev => ({ ...prev, catalogs: [...prev.catalogs, newCatalog] }));
    toast.success(`Added Trakt Popular ${type}`);
  };

  const fetchLikedLists = async () => {
    if (!isConnected || !config.apiKeys?.traktTokenId) {
      toast.error('Not connected to Trakt or token not available');
      return;
    }

    setIsLoadingLikedLists(true);
    try {
      const cacheKey = `trakt_liked_lists_${username}`;
      const data = await apiCache.cachedFetch(
        cacheKey,
        async () => {
          const response = await fetch(`/api/trakt/proxy`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              tokenId: config.apiKeys?.traktTokenId,
              endpoint: `/users/${username}/likes/lists?limit=100`,
            })
          });
          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || `HTTP ${response.status}`);
          }
          return await response.json();
        },
        10 * 60 * 1000 // Cache for 10 minutes
      );
      setLikedLists(data);
      setSelectedLikedLists(new Set());
      toast.success(`Loaded ${data.length} liked lists`);
    } catch (error) {
      toast.error("Failed to fetch liked lists", {
        description: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setIsLoadingLikedLists(false);
    }
  };

  const importSelectedLikedLists = () => {
    const listsToImport = likedLists.filter(item => {
      if (!item?.list?.ids?.trakt) return false;
      const list = item.list;
      const listKey = String(list.ids.trakt);
      return selectedLikedLists.has(listKey);
    });

    listsToImport.forEach(item => {
      const list = item.list;
      const catalogId = `trakt.list.${list.ids.trakt}`;
      
      if (config.catalogs.some(c => c.id === catalogId)) {
        return;
      }

      const newCatalog = createTraktCatalog({
        list,
        displayTypeOverrides: config.displayTypeOverrides,
      });

      setConfig(prev => ({
        ...prev,
        catalogs: [...prev.catalogs, newCatalog],
      }));
    });

    toast.success(`Imported ${listsToImport.length} list${listsToImport.length !== 1 ? 's' : ''}`);
    setSelectedLikedLists(new Set());
  };

  const handleAddFavorites = (type: 'movies' | 'shows' = 'movies') => {
    if (!isConnected) {
      toast.error("Please connect your Trakt account first");
      return;
    }

    const catalogId = `trakt.favorites.${type}`;
    
    if (config.catalogs.some(c => c.id === catalogId)) {
      toast.error("This favorites catalog is already added");
      return;
    }

    const catalogName = `Trakt Favorites`;

    setConfig(prev => {
      const catalogType = type === 'movies' ? 'movie' : 'series';
      const displayType = getDisplayTypeOverride(catalogType, prev.displayTypeOverrides);

      const newCatalog: CatalogConfig = {
        id: catalogId,
        type: catalogType,
        name: catalogName,
        enabled: true,
        showInHome: true,
        source: "trakt",
        sort: favoriteSortBy as 'rank' | 'score' | 'usort' | 'score_average' | 'released' | 'releasedigital' | 'imdbrating' | 'imdbvotes' | 'last_air_date' | 'imdbpopular' | 'tmdbpopular' | 'rogerbert' | 'rtomatoes' | 'rtaudience' | 'metacritic' | 'myanimelist' | 'letterrating' | 'lettervotes' | 'budget' | 'revenue' | 'runtime' | 'title' | 'added' | 'random' | 'default',
        sortDirection: favoriteSortHow === 'desc' ? 'desc' : 'asc',
        ...(displayType && { displayType }),
      };

      return {
        ...prev,
        catalogs: [...prev.catalogs, newCatalog],
      };
    });

    toast.success(`Added: ${catalogName}`);
  };

  const handleRemoveFavorites = (type: 'movies' | 'shows') => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.filter(c => c.id !== `trakt.favorites.${type}`),
    }));
    toast.success("Favorites catalog removed");
  };

  const handleAddRecommendations = (type: 'movies' | 'shows' = 'movies') => {
    if (!isConnected) {
      toast.error("Please connect your Trakt account first");
      return;
    }

    const catalogId = `trakt.recommendations.${type}`;
    
    if (config.catalogs.some(c => c.id === catalogId)) {
      toast.error("This recommendations catalog is already added");
      return;
    }

    const newCatalog: CatalogConfig = {
      id: catalogId,
      type: type === 'movies' ? 'movie' : 'series',
      name: `Trakt Recommendations`,
      enabled: true,
      showInHome: true,
      source: "trakt",
    };

    setConfig(prev => ({
      ...prev,
      catalogs: [...prev.catalogs, newCatalog],
    }));

    toast.success(`Added: ${newCatalog.name}`);
  };

  const handleRemoveRecommendations = (type: 'movies' | 'shows') => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.filter(c => c.id !== `trakt.recommendations.${type}`),
    }));
    toast.success("Recommendations catalog removed");
  };

  const handleAddMostFavorited = () => {
    if (!isConnected) {
      toast.error("Please connect your Trakt account first");
      return;
    }

    const catalogId = `trakt.most_favorited.${mostFavType}.${mostFavPeriod}`;

    if (config.catalogs.some(c => c.id === catalogId)) {
      toast.error("This Most Favorited catalog is already added");
      return;
    }

    const periodLabel = MOST_FAVORITED_PERIODS.find(p => p.value === mostFavPeriod)?.label || mostFavPeriod;
    const catalogName = `Trakt Most Favorited - ${periodLabel}`;
    setConfig(prev => {
      const catalogType = mostFavType === 'movies' ? 'movie' : 'series';
      const displayType = getDisplayTypeOverride(catalogType, prev.displayTypeOverrides);

      const newCatalog: CatalogConfig = {
        id: catalogId,
        type: catalogType,
        name: catalogName,
        enabled: true,
        showInHome: true,
        source: "trakt",
        ...(displayType && { displayType }),
      };

      return {
        ...prev,
        catalogs: [...prev.catalogs, newCatalog],
      };
    });

    toast.success(`Added: ${catalogName}`);
  };

  const handleRemoveMostFavorited = (catalogId: string) => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.filter(c => c.id !== catalogId),
    }));
    toast.success("Most Favorited catalog removed");
  };

  const handleAddUnwatched = () => {
    if (!isConnected) {
      toast.error("Please connect your Trakt account first");
      return;
    }

    setConfig(prev => {
      const displayType = getDisplayTypeOverride('series', prev.displayTypeOverrides);

      const newCatalog: CatalogConfig = {
        id: "trakt.unwatched",
        type: "series",
        name: "My Recently Aired",
        enabled: true,
        showInHome: true,
        source: "trakt",
        cacheTTL: 300,
        ...(displayType && { displayType }),
      };

      return {
        ...prev,
        catalogs: [...prev.catalogs, newCatalog],
      };
    });

    toast.success("My Recently Aired catalog added");
  };

  const handleRemoveUnwatched = () => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.filter(c => c.id !== "trakt.unwatched"),
    }));
    toast.success("My Recently Aired catalog removed");
  };

  const handleAddUpNext = () => {
    if (!isConnected) {
      toast.error("Please connect your Trakt account first");
      return;
    }

    setConfig(prev => {
      const displayType = getDisplayTypeOverride('series', prev.displayTypeOverrides);

      const newCatalog: CatalogConfig = {
        id: "trakt.upnext",
        type: "series",
        name: "Trakt Up Next",
        enabled: true,
        showInHome: true,
        source: "trakt",
        cacheTTL: 300, // 5 minutes
        ...(displayType && { displayType }),
      };

      return {
        ...prev,
        catalogs: [...prev.catalogs, newCatalog],
      };
    });

    toast.success("Up Next catalog added");
  };

  const handleRemoveUpNext = () => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.filter(c => c.id !== "trakt.upnext"),
    }));
    toast.success("Up Next catalog removed");
  };

  const handleAddCalendar = () => {
    if (!isConnected) {
      toast.error("Please connect your Trakt account first");
      return;
    }

    setConfig(prev => {
      const displayType = getDisplayTypeOverride('series', prev.displayTypeOverrides);

      const newCatalog: CatalogConfig = {
        id: "trakt.calendar",
        type: "series",
        name: "Airing Soon",
        enabled: true,
        showInHome: true,
        source: "trakt",
        cacheTTL: 300, // 5 minutes
        ...(displayType && { displayType }),
      };

      return {
        ...prev,
        catalogs: [...prev.catalogs, newCatalog],
      };
    });

    toast.success("Airing Soon added");
  };

  const handleRemoveCalendar = () => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.filter(c => c.id !== "trakt.calendar"),
    }));
    toast.success("Airing Soon removed");
  };

  const traktCatalogs = config.catalogs.filter(c => c.id.startsWith("trakt."));
  const hasWatchlist = traktCatalogs.some(c => c.id.startsWith("trakt.watchlist"));
  const mostFavoritedCatalogs = config.catalogs.filter(c => c.id.startsWith("trakt.most_favorited."));
  const upNextCatalog = config.catalogs.find(c => c.id === "trakt.upnext");
  const unwatchedCatalog = config.catalogs.find(c => c.id === "trakt.unwatched");
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl w-full max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <img src="https://trakt.tv/assets/logos/logomark.square.gradient-b644b16c38ff775861b4b1f58c1230f6a097a2466ab33ae00445a505c33fcb91.svg" alt="Trakt Logo" className="h-7 w-auto" />
            <DialogTitle>Trakt Integration</DialogTitle>
          </div>
          <DialogDescription>
            Connect your Trakt account to import watchlists and custom lists
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Connection Status */}
          <Card>
            <CardHeader>
              <CardTitle>Connection Status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {!isConnected ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-900 border rounded-lg">
                    <div className="flex items-center gap-3">
                      <XCircle className="h-5 w-5 text-gray-500" />
                      <p className="text-gray-700 dark:text-gray-300">Not connected</p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Step 1: Authorize Trakt</Label>
                    <Button onClick={handleConnect} className="w-full" disabled={!traktClientId}>
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Authorize with Trakt
                    </Button>
                    {!traktClientId && (
                      <p className="text-xs text-red-500 mt-2">
                        Instance owner has not yet set up the Trakt integration.
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Opens a new window. You'll receive a Token ID to paste below.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="trakt-token">Step 2: Paste Token ID</Label>
                    <Input
                      id="trakt-token"
                      placeholder="Paste your Trakt Token ID here"
                      value={tempTokenId}
                      onChange={(e) => setTempTokenId(e.target.value)}
                    />
                  </div>

                  <Button onClick={handleSave} disabled={!tempTokenId.trim() || !traktClientId} className="w-full">
                    Connect Trakt
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-3">
                    {/* Connected Status */}
                    {isConnected && (
                      <div className="flex items-center justify-between p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                        <div className="flex items-center gap-3">
                          <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
                          <div>
                            <p className="font-medium text-green-900 dark:text-green-100">Connected to Trakt</p>
                            {loadingUsername ? (
                              <p className="text-xs text-muted-foreground">Loading...</p>
                            ) : username ? (
                              <p className="text-xs text-muted-foreground">@{username}</p>
                            ) : null}
                          </div>
                        </div>
                        <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={disconnecting}>
                          {disconnecting ? 'Disconnecting...' : 'Disconnect'}
                        </Button>
                      </div>
                    )}

                    {/* Trakt User Stats Card */}
                    {isConnected && username && (
                      <Card className="mb-4">
                        <CardHeader className="cursor-pointer" onClick={() => setStatsCollapsed(!statsCollapsed)}>
                          <div className="flex items-center justify-between">
                            <div>
                              <CardTitle>Trakt Stats</CardTitle>
                              <CardDescription>Overview of your Trakt activity</CardDescription>
                            </div>
                            <ChevronDown 
                              className={`w-5 h-5 transition-transform ${statsCollapsed ? 'rotate-180' : ''}`}
                            />
                          </div>
                        </CardHeader>
                        {!statsCollapsed && (
                          <CardContent>
                            {loadingStats ? (
                              <div className="text-center text-muted-foreground py-8">Loading stats...</div>
                            ) : userStats ? (
                              <div className="space-y-6">
                                {/* Main Stats Grid */}
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                                  {/* Movies */}
                                  <div className="space-y-3">
                                    <h3 className="font-semibold text-sm text-muted-foreground">Movies</h3>
                                    <div className="space-y-2">
                                      <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                        <span className="text-xs text-muted-foreground">Watched</span>
                                        <span className="font-bold text-sm">{formatNumber(userStats.movies?.watched)}</span>
                                      </div>
                                      <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                        <span className="text-xs text-muted-foreground">Plays</span>
                                        <span className="font-bold text-sm">{formatNumber(userStats.movies?.plays)}</span>
                                      </div>
                                      <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                        <span className="text-xs text-muted-foreground">Hours</span>
                                        <span className="font-bold text-sm">{formatNumber(Math.round(userStats.movies?.minutes / 60))}</span>
                                      </div>
                                      <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                        <span className="text-xs text-muted-foreground">Collected</span>
                                        <span className="font-bold text-sm">{formatNumber(userStats.movies?.collected)}</span>
                                      </div>
                                    </div>
                                  </div>

                                  {/* Shows */}
                                  <div className="space-y-3">
                                    <h3 className="font-semibold text-sm text-muted-foreground">Shows</h3>
                                    <div className="space-y-2">
                                      <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                        <span className="text-xs text-muted-foreground">Watched</span>
                                        <span className="font-bold text-sm">{formatNumber(userStats.shows?.watched)}</span>
                                      </div>
                                      <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                        <span className="text-xs text-muted-foreground">Collected</span>
                                        <span className="font-bold text-sm">{formatNumber(userStats.shows?.collected)}</span>
                                      </div>
                                      <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                        <span className="text-xs text-muted-foreground">Ratings</span>
                                        <span className="font-bold text-sm">{formatNumber(userStats.shows?.ratings)}</span>
                                      </div>
                                    </div>
                                  </div>

                                  {/* Episodes */}
                                  <div className="space-y-3">
                                    <h3 className="font-semibold text-sm text-muted-foreground">Episodes</h3>
                                    <div className="space-y-2">
                                      <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                        <span className="text-xs text-muted-foreground">Watched</span>
                                        <span className="font-bold text-sm">{formatNumber(userStats.episodes?.watched)}</span>
                                      </div>
                                      <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                        <span className="text-xs text-muted-foreground">Plays</span>
                                        <span className="font-bold text-sm">{formatNumber(userStats.episodes?.plays)}</span>
                                      </div>
                                      <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                        <span className="text-xs text-muted-foreground">Hours</span>
                                        <span className="font-bold text-sm">{formatNumber(Math.round(userStats.episodes?.minutes / 60))}</span>
                                      </div>
                                      <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                        <span className="text-xs text-muted-foreground">Collected</span>
                                        <span className="font-bold text-sm">{formatNumber(userStats.episodes?.collected)}</span>
                                      </div>
                                    </div>
                                  </div>

                                  {/* Network */}
                                  <div className="space-y-3">
                                    <h3 className="font-semibold text-sm text-muted-foreground">Network</h3>
                                    <div className="space-y-2">
                                      <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                        <span className="text-xs text-muted-foreground">Followers</span>
                                        <span className="font-bold text-sm">{formatNumber(userStats.network?.followers)}</span>
                                      </div>
                                      <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                        <span className="text-xs text-muted-foreground">Following</span>
                                        <span className="font-bold text-sm">{formatNumber(userStats.network?.following)}</span>
                                      </div>
                                      <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                        <span className="text-xs text-muted-foreground">Friends</span>
                                        <span className="font-bold text-sm">{formatNumber(userStats.network?.friends)}</span>
                                      </div>
                                    </div>
                                  </div>
                                </div>

                                {/* Ratings Section */}
                                <div className="pt-4 border-t">
                                  <h3 className="font-semibold text-sm text-muted-foreground mb-3">Ratings</h3>
                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div className="flex justify-between items-center p-3 rounded-lg bg-muted/40">
                                      <span className="text-sm text-muted-foreground">Total Ratings</span>
                                      <span className="font-bold text-base">{formatNumber(userStats.ratings?.total)}</span>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ) : (
                              <div className="text-center text-muted-foreground py-8">No stats available.</div>
                            )}
                          </CardContent>
                        )}
                      </Card>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Watchlist */}
          {isConnected && (
            <Card>
              <CardHeader>
                <CardTitle>Watchlist</CardTitle>
                <CardDescription>Import your Trakt watchlist</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="watchlist-sort-by">Sort By</Label>
                    <Select value={watchlistSortBy} onValueChange={setWatchlistSortBy}>
                      <SelectTrigger id="watchlist-sort-by">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <TooltipProvider>
                          {SORT_OPTIONS.map(option => (
                            <SelectItem key={option.value} value={option.value}>
                              <span className="flex items-center gap-1">
                                {option.label}
                                {option.vip && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span role="img" aria-label="VIP" className="ml-1">💎</span>
                                    </TooltipTrigger>
                                    <TooltipContent side="right" className="max-w-xs whitespace-normal">
                                      VIP Only: Requires Trakt VIP subscription
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </span>
                            </SelectItem>
                          ))}
                        </TooltipProvider>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="watchlist-sort-how">Sort Direction</Label>
                    <Select value={watchlistSortHow} onValueChange={(value) => setWatchlistSortHow(value as 'asc' | 'desc')}>
                      <SelectTrigger id="watchlist-sort-how">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="asc">Ascending</SelectItem>
                        <SelectItem value="desc">Descending</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {!hasWatchlist ? (
                  <div className="flex gap-2">
                    <Button onClick={() => handleAddWatchlist(false)} variant="outline" className="flex-1">
                      Unified Watchlist
                    </Button>
                    <Button onClick={() => handleAddWatchlist(true)} variant="outline" className="flex-1">
                      Split by Type
                    </Button>
                  </div>
                ) : (
                  <Button onClick={handleRemoveWatchlist} variant="destructive" className="w-full">
                    <Trash2 className="mr-2 h-4 w-4" />
                    Remove Watchlist
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">
                  {!hasWatchlist 
                    ? "Unified: Movies and series together. Split: Separate catalogs."
                    : "Watchlist is currently added to your catalogs"}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Import Lists from Trakt User */}
          {isConnected && (
            <Card>
              <CardHeader>
                <CardTitle>Import Lists from Trakt User</CardTitle>
                <CardDescription>Load all public lists from any Trakt user</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="trakt-username">Trakt Username</Label>
                  <div className="flex gap-2">
                    <Input
                      id="trakt-username"
                      placeholder="e.g., garycrawfordgc"
                      value={traktUsername}
                      onChange={(e) => setTraktUsername(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          fetchTraktUserLists();
                        }
                      }}
                    />
                    <Button
                      onClick={fetchTraktUserLists}
                      disabled={isLoadingTraktUser || !traktUsername.trim()}
                      variant="outline"
                    >
                      {isLoadingTraktUser ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Loading...
                        </>
                      ) : (
                        "Load Lists"
                      )}
                    </Button>
                  </div>
                </div>

                {/* Trakt User Lists Display */}
                {traktUserLists.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center space-x-3 p-3 border rounded-lg bg-muted/30">
                      <Switch
                        id="select-all-trakt"
                        checked={selectedTraktLists.size === traktUserLists.length && traktUserLists.length > 0}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedTraktLists(new Set(traktUserLists.map(l => String(l.ids.trakt))));
                          } else {
                            setSelectedTraktLists(new Set());
                          }
                        }}
                      />
                      <Label htmlFor="select-all-trakt" className="font-medium cursor-pointer">
                        Select all lists from {traktUsername}
                      </Label>
                      <Badge variant="outline" className="ml-auto">
                        {selectedTraktLists.size}/{traktUserLists.length}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-2"
                        onClick={() => setSelectedTraktLists(new Set())}
                        disabled={selectedTraktLists.size === 0}
                      >
                        Deselect All
                      </Button>
                    </div>

                    <div className="grid grid-cols-1 gap-3 max-h-80 overflow-y-auto border rounded-lg p-3 bg-muted/20">
                      {traktUserLists.map((list) => (
                        <div key={String(list.ids.trakt)} className="flex items-start space-x-3 p-3 border rounded-lg">
                          <Switch
                            id={`trakt-${String(list.ids.trakt)}`}
                            checked={selectedTraktLists.has(String(list.ids.trakt))}
                            onCheckedChange={(checked) => handleTraktListSelection(String(list.ids.trakt), checked)}
                          />
                          <div className="flex-1 min-w-0">
                            <Label htmlFor={`trakt-${String(list.ids.trakt)}`} className="font-medium cursor-pointer">
                              {list.name}
                            </Label>
                            <div className="flex items-center gap-2 mt-1">
                              <Badge variant="outline" className="text-xs capitalize">
                                {list.type}
                              </Badge>
                              <Badge variant="secondary" className="text-xs">
                                by {traktUsername}
                              </Badge>
                              {list.item_count && (
                                <Badge variant="secondary" className="text-xs">
                                  {list.item_count} items
                                </Badge>
                              )}
                            </div>
                            {list.description && (
                              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                                {list.description}
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    {selectedTraktLists.size > 0 && (
                      <Button
                        onClick={importSelectedTraktLists}
                        className="w-full"
                        disabled={selectedTraktLists.size === 0}
                      >
                        Import {selectedTraktLists.size} Selected List{selectedTraktLists.size !== 1 ? 's' : ''}
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Trending & Popular Lists */}
          {isConnected && (
            <Card>
              <CardHeader>
                <CardTitle>Trending & Popular Lists</CardTitle>
                <CardDescription>Discover and import curated lists from the Trakt community</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="list-type">List Type</Label>
                  <Select value={trendingListType} onValueChange={(value: any) => setTrendingListType(value)}>
                    <SelectTrigger id="list-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="personal">Personal Lists</SelectItem>
                      <SelectItem value="official">Official Lists</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex gap-2">
                  <Button 
                    onClick={fetchTrendingLists} 
                    disabled={isLoadingTrending}
                    variant="outline"
                    className="flex-1"
                  >
                    {isLoadingTrending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      'Load Trending'
                    )}
                  </Button>
                  <Button 
                    onClick={fetchPopularLists} 
                    disabled={isLoadingPopular}
                    variant="outline"
                    className="flex-1"
                  >
                    {isLoadingPopular ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      'Load Popular'
                    )}
                  </Button>
                </div>

                {(trendingLists.length > 0 || popularLists.length > 0) && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <Label>
                        {trendingLists.length > 0 ? 'Trending Lists' : 'Popular Lists'} ({trendingLists.length || popularLists.length})
                      </Label>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            const allLists = [...trendingLists, ...popularLists];
                            const allKeys = allLists
                              .filter(item => item?.list?.ids?.trakt)
                              .map(item => String(item.list.ids.trakt));
                            setSelectedTrendingLists(new Set(allKeys));
                          }}
                        >
                          Select All
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelectedTrendingLists(new Set())}
                          disabled={selectedTrendingLists.size === 0}
                        >
                          Deselect All
                        </Button>
                      </div>
                    </div>

                    <div className="space-y-2 max-h-[400px] overflow-y-auto">
                      {[...trendingLists, ...popularLists]
                        .filter(item => item?.list?.ids?.slug)
                        .map((item) => {
                          const list = item.list;
                          const listKey = String(list.ids.trakt);
                          const catalogId = `trakt.list.${list.ids.trakt}`;
                          const isAlreadyAdded = config.catalogs.some(c => c.id === catalogId);
                        
                          return (
                            <div 
                              key={listKey}
                              className={`flex items-start gap-3 p-3 border rounded-lg ${
                                isAlreadyAdded ? 'opacity-50 bg-muted/50' : 'cursor-pointer hover:bg-muted/50'
                              }`}
                              onClick={() => {
                                if (isAlreadyAdded) return;
                                setSelectedTrendingLists(prev => {
                                  const newSet = new Set(prev);
                                  if (newSet.has(listKey)) {
                                    newSet.delete(listKey);
                                  } else {
                                    newSet.add(listKey);
                                  }
                                  return newSet;
                                });
                              }}
                            >
                              {!isAlreadyAdded && (
                                <input
                                  type="checkbox"
                                  checked={selectedTrendingLists.has(listKey)}
                                  onChange={() => {}}
                                  className="mt-1"
                                />
                              )}
                              <div className="flex-1 min-w-0">
                                <h4 className="font-medium">{list.name}</h4>
                                <div className="flex flex-wrap items-center gap-2 mt-1">
                                  <Badge variant="outline" className="text-xs">
                                    {list.user?.username || 'Trakt'}
                                  </Badge>
                                  {list.item_count && (
                                    <Badge variant="secondary" className="text-xs">
                                      {list.item_count} items
                                    </Badge>
                                  )}
                                  {item.like_count > 0 && (
                                    <Badge variant="secondary" className="text-xs">
                                      {item.like_count} likes
                                    </Badge>
                                  )}
                                  {item.comment_count > 0 && (
                                    <Badge variant="secondary" className="text-xs">
                                      {item.comment_count} comments
                                    </Badge>
                                  )}
                                  {isAlreadyAdded && (
                                    <Badge variant="default" className="text-xs">
                                      Already Added
                                    </Badge>
                                  )}
                                </div>
                                {list.description && (
                                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                                    {list.description}
                                  </p>
                                )}
                              </div>
                            </div>
                          );
                        })}
                    </div>

                      {selectedTrendingLists.size > 0 && (
                      <Button
                        onClick={importSelectedTrendingLists}
                        className="w-full"
                      >
                        Import {selectedTrendingLists.size} Selected List{selectedTrendingLists.size !== 1 ? 's' : ''}
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

            {isConnected && (
              <Card>
                <CardHeader>
                  <CardTitle>Trending & Popular Catalogs</CardTitle>
                  <CardDescription>Import Trakt trending or popular movies/shows as single catalogs</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex gap-2">
                    <Button
                      onClick={() => handleAddTrendingCatalog('movies')}
                      variant="outline"
                      className="flex-1"
                      disabled={config.catalogs.some(c => c.id === 'trakt.trending.movies')}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Trending Movies
                    </Button>
                    <Button
                      onClick={() => handleAddTrendingCatalog('shows')}
                      variant="outline"
                      className="flex-1"
                      disabled={config.catalogs.some(c => c.id === 'trakt.trending.shows')}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Trending Shows
                    </Button>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => handleAddPopularCatalog('movies')}
                      variant="outline"
                      className="flex-1"
                      disabled={config.catalogs.some(c => c.id === 'trakt.popular.movies')}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Popular Movies
                    </Button>
                    <Button
                      onClick={() => handleAddPopularCatalog('shows')}
                      variant="outline"
                      className="flex-1"
                      disabled={config.catalogs.some(c => c.id === 'trakt.popular.shows')}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Popular Shows
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    These catalogs use Trakt's trending and popular endpoints for movies and shows. They update automatically.
                  </p>
                </CardContent>
              </Card>
            )}

          {/* Liked Lists */}
          {isConnected && (
            <Card>
              <CardHeader>
                <CardTitle>Your Liked Lists</CardTitle>
                <CardDescription>Import lists you've liked on Trakt</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button 
                  onClick={fetchLikedLists} 
                  disabled={isLoadingLikedLists}
                  className="w-full"
                >
                  {isLoadingLikedLists ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Loading...
                    </>
                  ) : (
                    <>
                      <Plus className="mr-2 h-4 w-4" />
                      Load My Liked Lists
                    </>
                  )}
                </Button>

                {likedLists.length > 0 && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <Label>
                        Liked Lists ({likedLists.length})
                      </Label>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const allKeys = likedLists
                            .filter(item => item?.list?.ids?.trakt)
                            .map(item => String(item.list.ids.trakt));
                          setSelectedLikedLists(new Set(allKeys));
                        }}
                      >
                        Select All
                      </Button>
                    </div>

                    <div className="space-y-2 max-h-[400px] overflow-y-auto">
                      {likedLists
                        .filter(item => item?.list?.user?.ids?.slug && item?.list?.ids?.slug)
                        .map((item) => {
                          const list = item.list;
                          const listKey = String(list.ids.trakt);
                          const catalogId = `trakt.list.${list.ids.trakt}`;
                          const isAlreadyAdded = config.catalogs.some(c => c.id === catalogId);
                          
                          return (
                            <div 
                              key={listKey}
                              className={`flex items-start gap-3 p-3 border rounded-lg ${
                                isAlreadyAdded ? 'opacity-50 bg-muted/50' : 'cursor-pointer hover:bg-muted/50'
                              }`}
                              onClick={() => {
                                if (isAlreadyAdded) return;
                                setSelectedLikedLists(prev => {
                                  const newSet = new Set(prev);
                                  if (newSet.has(listKey)) {
                                    newSet.delete(listKey);
                                  } else {
                                    newSet.add(listKey);
                                  }
                                  return newSet;
                                });
                              }}
                            >
                              {!isAlreadyAdded && (
                                <input
                                  type="checkbox"
                                  checked={selectedLikedLists.has(listKey)}
                                  onChange={() => {}}
                                  className="mt-1"
                                />
                              )}
                              <div className="flex-1 min-w-0">
                                <h4 className="font-medium">{list.name}</h4>
                                <div className="flex flex-wrap items-center gap-2 mt-1">
                                  <Badge variant="outline" className="text-xs">
                                    {list.user?.username || 'Trakt'}
                                  </Badge>
                                  {list.item_count && (
                                    <Badge variant="secondary" className="text-xs">
                                      {list.item_count} items
                                    </Badge>
                                  )}
                                  {item.like_count > 0 && (
                                    <Badge variant="secondary" className="text-xs">
                                      {item.like_count} likes
                                    </Badge>
                                  )}
                                  {isAlreadyAdded && (
                                    <Badge variant="default" className="text-xs">
                                      Already Added
                                    </Badge>
                                  )}
                                </div>
                                {list.description && (
                                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                                    {list.description}
                                  </p>
                                )}
                              </div>
                            </div>
                          );
                        })}
                    </div>

                    {selectedLikedLists.size > 0 && (
                      <Button
                        onClick={importSelectedLikedLists}
                        className="w-full"
                      >
                        Import {selectedLikedLists.size} Selected List{selectedLikedLists.size !== 1 ? 's' : ''}
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Your Favorites */}
          {isConnected && (
            <Card>
              <CardHeader>
                <CardTitle>Favorites</CardTitle>
                <CardDescription>Import your favorite movies or shows</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="favorite-sort-by">Sort By</Label>
                    <Select value={favoriteSortBy} onValueChange={setFavoriteSortBy}>
                      <SelectTrigger id="favorite-sort-by">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <TooltipProvider>
                          {SORT_OPTIONS.map(option => (
                            <SelectItem key={option.value} value={option.value}>
                              <span className="flex items-center gap-1">
                                {option.label}
                                {option.vip && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span role="img" aria-label="VIP" className="ml-1">💎</span>
                                    </TooltipTrigger>
                                    <TooltipContent side="right" className="max-w-xs whitespace-normal">
                                      VIP Only: Requires Trakt VIP subscription
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </span>
                            </SelectItem>
                          ))}
                        </TooltipProvider>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="favorite-sort-how">Sort Direction</Label>
                    <Select value={favoriteSortHow} onValueChange={(value) => setFavoriteSortHow(value as 'asc' | 'desc')}>
                      <SelectTrigger id="favorite-sort-how">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="asc">Ascending</SelectItem>
                        <SelectItem value="desc">Descending</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button 
                    onClick={() => handleAddFavorites('movies')} 
                    variant="outline" 
                    className="flex-1"
                    disabled={config.catalogs.some(c => c.id === 'trakt.favorites.movies')}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Movies
                  </Button>
                  <Button 
                    onClick={() => handleAddFavorites('shows')} 
                    variant="outline" 
                    className="flex-1"
                    disabled={config.catalogs.some(c => c.id === 'trakt.favorites.shows')}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Shows
                  </Button>
                </div>

                {(config.catalogs.some(c => c.id === 'trakt.favorites.movies') || config.catalogs.some(c => c.id === 'trakt.favorites.shows')) && (
                  <div className="space-y-2 border-t pt-4">
                    {config.catalogs.some(c => c.id === 'trakt.favorites.movies') && (
                      <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                        <span className="font-medium">Trakt Favorites</span>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => handleRemoveFavorites('movies')}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                    {config.catalogs.some(c => c.id === 'trakt.favorites.shows') && (
                      <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                        <span className="font-medium">Trakt Favorites</span>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => handleRemoveFavorites('shows')}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                <p className="text-xs text-muted-foreground">
                  Add your favorite movies or shows as separate catalogs. Configure sort options before adding.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Recommendations */}
          {isConnected && (
            <Card>
              <CardHeader>
                <CardTitle>Recommendations</CardTitle>
                <CardDescription>Get personalized recommendations for movies or shows</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2">
                  <Button 
                    onClick={() => handleAddRecommendations('movies')} 
                    variant="outline" 
                    className="flex-1"
                    disabled={config.catalogs.some(c => c.id === 'trakt.recommendations.movies')}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Movies
                  </Button>
                  <Button 
                    onClick={() => handleAddRecommendations('shows')} 
                    variant="outline" 
                    className="flex-1"
                    disabled={config.catalogs.some(c => c.id === 'trakt.recommendations.shows')}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Shows
                  </Button>
                </div>

                {(config.catalogs.some(c => c.id === 'trakt.recommendations.movies') || config.catalogs.some(c => c.id === 'trakt.recommendations.shows')) && (
                  <div className="space-y-2 border-t pt-4">
                    {config.catalogs.some(c => c.id === 'trakt.recommendations.movies') && (
                      <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                        <span className="font-medium">Trakt Recommendations (Movies)</span>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => handleRemoveRecommendations('movies')}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                    {config.catalogs.some(c => c.id === 'trakt.recommendations.shows') && (
                      <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                        <span className="font-medium">Trakt Recommendations (Shows)</span>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => handleRemoveRecommendations('shows')}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                <p className="text-xs text-muted-foreground">
                  Get personalized movie and show recommendations. Recommendations are updated regularly.
                </p>
              </CardContent>
            </Card>
          )}

            {/* Most Favorited */}
            {isConnected && (
              <Card>
                <CardHeader>
                  <CardTitle>Most Favorited</CardTitle>
                  <CardDescription>Top favorited movies or shows over a selected period</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Type</Label>
                      <Select value={mostFavType} onValueChange={(value) => setMostFavType(value as 'movies' | 'shows')}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="movies">Movies</SelectItem>
                          <SelectItem value="shows">Shows</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>Period</Label>
                      <Select value={mostFavPeriod} onValueChange={(value) => setMostFavPeriod(value as 'daily' | 'weekly' | 'monthly' | 'all')}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {MOST_FAVORITED_PERIODS.map(option => (
                            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <Button 
                      onClick={handleAddMostFavorited}
                      variant="outline"
                      className="flex-1"
                      disabled={config.catalogs.some(c => c.id === `trakt.most_favorited.${mostFavType}.${mostFavPeriod}`)}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add Catalog
                    </Button>
                  </div>

                  {mostFavoritedCatalogs.length > 0 && (
                    <div className="space-y-2 border-t pt-4">
                      {mostFavoritedCatalogs.map(catalog => (
                        <div key={catalog.id} className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                          <span className="font-medium">{catalog.name || catalog.id}</span>
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            onClick={() => handleRemoveMostFavorited(catalog.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}

                  <p className="text-xs text-muted-foreground">
                    Fetches the most favorited movies or shows from Trakt. Choose a period (daily, weekly, monthly, or all time) before adding.
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Up Next */}
            {isConnected && (
              <Card>
                <CardHeader>
                  <CardTitle>Up Next</CardTitle>
                  <CardDescription>Shows the next episode you should watch for each tracked show</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex gap-2">
                    <Button
                      onClick={handleAddUpNext}
                      variant="outline"
                      className="flex-1"
                      disabled={!!upNextCatalog}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add Up Next
                    </Button>
                  </div>
                  {upNextCatalog && (
                    <div className="space-y-2 border-t pt-4">
                      <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                        <span className="font-medium">Trakt Up Next</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleRemoveUpNext}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="flex items-center justify-between p-3 border rounded-lg">
                        <div className="space-y-0.5">
                          <label className="text-sm font-medium">Use Show Poster</label>
                          <p className="text-xs text-muted-foreground">Display show poster instead of episode thumbnail</p>
                        </div>
                        <Switch
                          checked={upNextCatalog.metadata?.useShowPosterForUpNext || false}
                          onCheckedChange={(checked) => {
                            setConfig(prev => ({
                              ...prev,
                              catalogs: prev.catalogs.map(c =>
                                c.id === 'trakt.upnext'
                                  ? { ...c, metadata: { ...c.metadata, useShowPosterForUpNext: checked } }
                                  : c
                              )
                            }));
                          }}
                        />
                      </div>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    This catalog will show the next episode to watch for each show in your Trakt watched list.
                  </p>
                </CardContent>
              </Card>
            )}

            {/* My Recently Aired */}
            {isConnected && (
              <Card>
                <CardHeader>
                  <CardTitle>My Recently Aired</CardTitle>
                  <CardDescription>All unwatched aired episodes for your in-progress shows</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex gap-2">
                    <Button
                      onClick={handleAddUnwatched}
                      variant="outline"
                      className="flex-1"
                      disabled={!!unwatchedCatalog}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add Recently Aired
                    </Button>
                  </div>
                  {unwatchedCatalog && (
                    <div className="space-y-2 border-t pt-4">
                      <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                        <span className="font-medium">My Recently Aired</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleRemoveUnwatched}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Groups by show and lists every unwatched aired episode in the videos section. Updates automatically based on your Trakt activity.
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Airing Today */}
            {isConnected && (
              <Card>
                <CardHeader>
                  <CardTitle>Airing Soon</CardTitle>
                  <CardDescription>Shows airing in the next 24 hours from your tracked shows</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex gap-2">
                    <Button
                      onClick={handleAddCalendar}
                      variant="outline"
                      className="flex-1"
                      disabled={!!config.catalogs.find(c => c.id === 'trakt.calendar')}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add Calendar
                    </Button>
                  </div>
                  
                  {config.catalogs.find(c => c.id === 'trakt.calendar') && (
                    <div className="space-y-2 border-t pt-4">
                      <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                        <span className="font-medium">Airing Soon</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleRemoveCalendar}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  )}

                  <p className="text-xs text-muted-foreground">
                    Shows episodes airing in the next 24 hours from shows you're tracking on Trakt. Automatically updates based on your configured timezone.
                  </p>
                </CardContent>
              </Card>
            )}

          {/* Custom Lists */}
          {isConnected && (
            <Card>
              <CardHeader>
                <CardTitle>Custom Lists</CardTitle>
                <CardDescription>Import public Trakt lists</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="custom-list-url">List URL</Label>
                  <div className="flex gap-2">
                    <Input
                      id="custom-list-url"
                      placeholder="https://trakt.tv/users/username/lists/list-slug"
                      value={customListUrl}
                      onChange={(e) => setCustomListUrl(e.target.value)}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Catalog Type</Label>
                  <div className="flex gap-2">
                    <Button 
                      onClick={() => setCustomListType('all')} 
                      variant={customListType === 'all' ? 'default' : 'outline'}
                      className="flex-1"
                    >
                      Unified
                    </Button>
                    <Button 
                      onClick={() => setCustomListType('split')} 
                      variant={customListType === 'split' ? 'default' : 'outline'}
                      className="flex-1"
                    >
                      Split by Type
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Unified: Movies and series together. Split: Separate catalogs for each type.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="custom-list-sort-by">Sort By</Label>
                    <Select value={customListSortBy} onValueChange={setCustomListSortBy}>
                      <SelectTrigger id="custom-list-sort-by">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <TooltipProvider>
                          {SORT_OPTIONS.map(option => (
                            <SelectItem key={option.value} value={option.value}>
                              <span className="flex items-center gap-1">
                                {option.label}
                                {option.vip && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span role="img" aria-label="VIP" className="ml-1">💎</span>
                                    </TooltipTrigger>
                                    <TooltipContent side="right">
                                      VIP Only: Requires Trakt VIP subscription
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </span>
                            </SelectItem>
                          ))}
                        </TooltipProvider>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="custom-list-sort-how">Sort Direction</Label>
                    <Select value={customListSortHow} onValueChange={(value) => setCustomListSortHow(value as 'asc' | 'desc')}>
                      <SelectTrigger id="custom-list-sort-how">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="asc">Ascending</SelectItem>
                        <SelectItem value="desc">Descending</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <Button onClick={handleAddCustomList} disabled={!customListUrl.trim()} className="w-full">
                  <Plus className="mr-2 h-4 w-4" />
                  Add List
                </Button>

                {/*traktCatalogs.filter(c => !c.id.startsWith("trakt.watchlist")).length > 0 && (
                  <Card className="mt-6">
                    <CardHeader>
                      <CardTitle>Imported Lists</CardTitle>
                      <CardDescription>Manage your imported Trakt lists</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-3">
                        {traktCatalogs
                          .filter(c => !c.id.startsWith("trakt.watchlist"))
                          .map((catalog) => (
                            <div key={catalog.id} className="flex items-center justify-between p-3 border rounded-lg">
                              <div className="flex-1">
                                <h4 className="font-medium">{catalog.name}</h4>
                                <div className="flex items-center gap-2 mt-1">
                                  {(catalog as any).metadata?.itemCount !== undefined && (
                                    <Badge variant="outline" className="text-xs">
                                      {(catalog as any).metadata.itemCount} items
                                    </Badge>
                                  )}
                                  {(catalog as any).metadata?.privacy && (
                                    <Badge variant="secondary" className="text-xs capitalize">
                                      {(catalog as any).metadata.privacy}
                                    </Badge>
                                  )}
                                                                   {(catalog as any).metadata?.author && (
                                    <Badge variant="default" className="text-xs">
                                      @{(catalog as any).metadata.author}
                                    </Badge>
                                  )}
                                </div>
                                {(catalog as any).metadata?.description && (
                                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                                    {(catalog as any).metadata.description}
                                  </p>
                                )}
                              </div>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setConfig(prev => ({
                                    ...prev,
                                    catalogs: prev.catalogs.filter(c => c.id !== catalog.id),
                                  }));
                                  toast.success(`Removed: ${catalog.name}`);
                                }}
                                className="text-destructive hover:text-destructive ml-3"
                              >
                                <Trash2 className="w-4 h-4 mr-1" />
                                Remove
                              </Button>
                            </div>
                          ))}
                      </div>
                    </CardContent>
                  </Card>
                )*/}
              </CardContent>
            </Card>
          )}
        </div>



        <DialogFooter>
          <Button onClick={onClose} variant="outline">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
