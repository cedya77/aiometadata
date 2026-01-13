import React, { useState, useEffect } from 'react';
import { useConfig, CatalogConfig } from '@/contexts/ConfigContext';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ExternalLink, Trash2, Plus, Loader2, AlertCircle, LogIn, LogOut, CheckCircle } from 'lucide-react';
import { toast } from "sonner";
import { apiCache } from '@/utils/apiCache';

interface TMDBIntegrationProps {
  isOpen: boolean;
  onClose: () => void;
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

export function TMDBIntegration({ isOpen, onClose }: TMDBIntegrationProps) {
  const { config, setConfig, sessionId, setSessionId, auth } = useConfig();
  const [customListUrl, setCustomListUrl] = useState("");
  const [customListType, setCustomListType] = useState<'all' | 'split'>('all');
  const [listPreview, setListPreview] = useState<any>(null);
  const [listPreviewPending, setListPreviewPending] = useState(false);
  const [tmdbAuthLoading, setTmdbAuthLoading] = useState(false);
  const [tmdbAuthError, setTmdbAuthError] = useState('');

  const tmdbApiKey = config.apiKeys?.tmdb;
  const isValid = !!tmdbApiKey;

  // TMDB watchlist only supports split (movies and series separately)
  const hasWatchlistMovies = config.catalogs.some(c => c.id === 'tmdb.watchlist' && c.type === 'movie' && c.enabled !== false);
  const hasWatchlistSeries = config.catalogs.some(c => c.id === 'tmdb.watchlist' && c.type === 'series' && c.enabled !== false);
  const hasFavoritesMovies = config.catalogs.some(c => c.id === 'tmdb.favorites' && c.type === 'movie' && c.enabled !== false);
  const hasFavoritesSeries = config.catalogs.some(c => c.id === 'tmdb.favorites' && c.type === 'series' && c.enabled !== false);

  React.useEffect(() => {
    if (!isOpen) return;
    
    const hasOldCatalogs = config.catalogs.some(c => 
      (c.id === 'tmdb.watchlist' || c.id === 'tmdb.favorites') && 
      (c.enabled === false || (c.id === 'tmdb.watchlist' && c.type === 'all'))
    );
    
    if (hasOldCatalogs) {
      setConfig(prev => ({
        ...prev,
        catalogs: prev.catalogs.filter(c => {
          // Remove disabled TMDB watchlist and favorites
          // Also remove unified watchlist (TMDB doesn't support it)
          if ((c.id === 'tmdb.watchlist' || c.id === 'tmdb.favorites') && 
              (c.enabled === false || (c.id === 'tmdb.watchlist' && c.type === 'all'))) {
            return false;
          }
          return true;
        })
      }));
    }
  }, [isOpen, setConfig]);

  // Handle TMDB authentication callback via postMessage (from popup window)
  React.useEffect(() => {
    if (!isOpen) return;
    
    const handleMessage = async (event: MessageEvent) => {
      // Verify origin for security
      if (event.origin !== window.location.origin) return;
      
      if (event.data.type === 'tmdb_auth_success' && event.data.requestToken) {
        const requestToken = event.data.requestToken;
        
        if (!sessionId && tmdbApiKey) {
          setTmdbAuthLoading(true);
          setTmdbAuthError('');
          
          console.log('[TMDB Auth] Creating session from request token:', requestToken);
          
          try {
            // Create session from request token via backend proxy
            const response = await fetch('/api/tmdb/auth/session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                requestToken: requestToken,
                apikey: tmdbApiKey
              })
            });
            
            if (!response.ok) {
              const errorData = await response.json().catch(() => ({}));
              console.error('[TMDB Auth] Session creation failed:', errorData);
              throw new Error(errorData.error || 'Failed to create session');
            }
            
            const data = await response.json();
            console.log('[TMDB Auth] Session response:', data);
            
            if (data.success && data.session_id) {
              console.log('[TMDB Auth] Session created successfully:', data.session_id);
              setSessionId(data.session_id);
              toast.success("Successfully authenticated with TMDB!", {
                description: "Remember to save your configuration to persist the session"
              });
            } else {
              console.error('[TMDB Auth] Session creation response invalid:', data);
              throw new Error(data.status_message || 'Failed to create session with TMDB');
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Failed to create TMDB session";
            console.error('[TMDB Auth] Error:', error);
            setTmdbAuthError(errorMessage);
            toast.error(errorMessage);
          } finally {
            setTmdbAuthLoading(false);
          }
        }
      }
    };
    
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [isOpen, sessionId, tmdbApiKey, setSessionId]);

  const handleTmdbLogin = async () => {
    setTmdbAuthLoading(true);
    setTmdbAuthError('');

    if (!tmdbApiKey) {
      setTmdbAuthError("Please enter your TMDB API key first");
      toast.error("Please enter your TMDB API key in the Integrations tab first");
      setTmdbAuthLoading(false);
      return;
    }

    try {
      const response = await fetch('/api/tmdb/auth/request_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apikey: tmdbApiKey })
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to get request token');
      }
      
      const data = await response.json();
      
      if (!data.success || !data.request_token) {
        throw new Error('Failed to get request token from TMDB');
      }
      
      const requestToken = data.request_token;
      
      // Create a callback page URL that will handle the redirect
      const origin = window.location.origin;
      const callbackUrl = `${origin}/tmdb-callback.html?request_token=${requestToken}`;
      
      const tmdbAuthUrl = `https://www.themoviedb.org/authenticate/${requestToken}?redirect_to=${encodeURIComponent(callbackUrl)}`;
      
      // Open in popup window
      const width = 600;
      const height = 700;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      
      window.open(
        tmdbAuthUrl,
        'tmdb_auth',
        `width=${width},height=${height},left=${left},top=${top}`
      );
      
      toast.info("Complete the authorization in the popup window");
      setTmdbAuthLoading(false);
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "Failed to start TMDB authentication";
      setTmdbAuthError(errorMessage);
      toast.error(errorMessage);
      setTmdbAuthLoading(false);
    }
  };

  const handleTmdbLogout = () => {
    setSessionId("");
    toast.info("TMDB session cleared", {
      description: "Save your configuration to persist the change"
    });
  };

  // Extract TMDB list ID from URL or direct ID input
  const extractTmdbListId = (input: string): string | null => {
    if (!input) return null;
    
    const trimmed = input.trim();
    
    // Direct numeric ID (e.g., "28")
    if (/^\d+$/.test(trimmed)) {
      return trimmed;
    }
    
    // Slug format (e.g., "28-best-picture-winners-the-academy-awards")
    if (/^\d+[\w-]*$/.test(trimmed)) {
      return trimmed;
    }
    
    // TMDB list URL patterns:
    // https://www.themoviedb.org/list/123456
    // https://www.themoviedb.org/list/28-best-picture-winners-the-academy-awards
    // https://themoviedb.org/list/123456
    const urlMatch = input.match(/themoviedb\.org\/list\/([\d\w-]+)/);
    if (urlMatch) {
      return urlMatch[1];
    }
    
    return null;
  };

  const handlePreviewList = async () => {
    const listId = extractTmdbListId(customListUrl);
    
    if (!listId) {
      toast.error("Invalid TMDB list URL or ID", {
        description: "Please enter a valid list ID (e.g., 28), slug (e.g., 28-best-picture-winners), or URL"
      });
      return;
    }

    if (!tmdbApiKey) {
      toast.error("TMDB API key required", {
        description: "Please enter your TMDB API key in the Integrations tab first"
      });
      return;
    }

    setListPreviewPending(true);
    setListPreview(null);

    try {
      // Fetch list details from TMDB API via backend proxy
      const cacheKey = `tmdb_list_preview_${listId}`;
      const response = await apiCache.cachedFetch(
        cacheKey,
        async () => {
          const url = `/api/tmdb/list/${encodeURIComponent(listId)}?apikey=${encodeURIComponent(tmdbApiKey)}`;
          const res = await fetch(url);
          if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            throw new Error(errorData.error || `Failed to fetch list: ${res.status}`);
          }
          return await res.json();
        },
        5 * 60 * 1000 // Cache for 5 minutes
      );

      if (response) {
        const creator = typeof response.created_by === 'string' 
          ? response.created_by 
          : response.created_by?.username || 'Unknown';
        
        setListPreview({
          id: response.id,
          name: response.name,
          description: response.description || 'No description',
          item_count: response.item_count || 0,
          iso_639_1: response.iso_639_1,
          created_by: creator
        });
        toast.success("List preview loaded", {
          description: `${response.name} - ${response.item_count} items`
        });
      } else {
        throw new Error("Failed to fetch list details");
      }
    } catch (error: any) {
      console.error('Error fetching TMDB list:', error);
      toast.error("Failed to fetch list", {
        description: error.message || "Could not load list details from TMDB"
      });
      setListPreview(null);
    } finally {
      setListPreviewPending(false);
    }
  };

  const handleAddList = () => {
    if (!listPreview) {
      toast.error("Please preview the list first");
      return;
    }

    const listId = listPreview.id.toString();
    const existingList = config.catalogs.find(c => c.id === `tmdb.list.${listId}`);
    
    if (existingList) {
      toast.error("List already added", {
        description: "This TMDB list is already in your catalogs"
      });
      return;
    }

    if (customListType === 'all') {
      // Unified catalog for both movies and series
      const displayType = getDisplayTypeOverride('all', config.displayTypeOverrides);
      
      const newCatalog: CatalogConfig = {
        id: `tmdb.list.${listId}`,
        type: "all",
        name: listPreview.name || `TMDB List ${listId}`,
        enabled: true,
        showInHome: true,
        source: "tmdb",
        cacheTTL: 7200, // 2 hours default
        ...(displayType && { displayType }),
        metadata: {
          listId: listId,
          listName: listPreview.name,
          listDescription: listPreview.description,
          url: `https://www.themoviedb.org/list/${listId}`
        }
      };

      setConfig(prev => ({
        ...prev,
        catalogs: [...prev.catalogs, newCatalog],
      }));

      toast.success("List added", {
        description: `${listPreview.name} has been added to your catalogs`
      });
    } else {
      // Split into separate movie and series catalogs
      const movieDisplayType = getDisplayTypeOverride('movie', config.displayTypeOverrides);
      const seriesDisplayType = getDisplayTypeOverride('series', config.displayTypeOverrides);

      const movieCatalog: CatalogConfig = {
        id: `tmdb.list.${listId}.movies`,
        type: "movie",
        name: `${listPreview.name} (Movies)`,
        enabled: true,
        showInHome: true,
        source: "tmdb",
        cacheTTL: 7200,
        ...(movieDisplayType && { displayType: movieDisplayType }),
        metadata: {
          listId: listId,
          listName: listPreview.name,
          listDescription: listPreview.description,
          url: `https://www.themoviedb.org/list/${listId}`
        }
      };

      const seriesCatalog: CatalogConfig = {
        id: `tmdb.list.${listId}.series`,
        type: "series",
        name: `${listPreview.name} (Series)`,
        enabled: true,
        showInHome: true,
        source: "tmdb",
        cacheTTL: 7200,
        ...(seriesDisplayType && { displayType: seriesDisplayType }),
        metadata: {
          listId: listId,
          listName: listPreview.name,
          listDescription: listPreview.description,
          url: `https://www.themoviedb.org/list/${listId}`
        }
      };

      setConfig(prev => ({
        ...prev,
        catalogs: [...prev.catalogs, movieCatalog, seriesCatalog],
      }));

      toast.success("Lists added", {
        description: `${listPreview.name} has been split into Movies and Series catalogs`
      });
    }

    // Reset form
    setCustomListUrl("");
    setListPreview(null);
  };

  const handleRemoveList = (catalogId: string) => {
    const catalog = config.catalogs.find(c => c.id === catalogId);
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.filter(c => c.id !== catalogId),
    }));
    toast.success("List removed", {
      description: `${catalog?.name || 'List'} has been removed from your catalogs`
    });
  };

  const handleAddWatchlist = (type: 'movie' | 'series' = 'movie') => {
    if (!sessionId) {
      toast.error("Please authenticate with TMDB first");
      return;
    }

    const catalogId = `tmdb.watchlist`;
    
    if (config.catalogs.some(c => c.id === catalogId && c.type === type)) {
      toast.error("This watchlist catalog is already added");
      return;
    }

    const catalogName = `TMDB Watchlist`;
    const displayType = getDisplayTypeOverride(type, config.displayTypeOverrides);

    setConfig(prev => {
      const newCatalog: CatalogConfig = {
        id: catalogId,
        type: type,
        name: catalogName,
        enabled: true,
        showInHome: true,
        source: 'tmdb',
        ...(displayType && { displayType }),
      };

      return {
        ...prev,
        catalogs: [...prev.catalogs, newCatalog],
      };
    });

    toast.success(`TMDB Watchlist (${type === 'movie' ? 'Movies' : 'Series'}) added`);
  };

  const handleRemoveWatchlist = (type: 'movie' | 'series') => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.filter(c => !(c.id === 'tmdb.watchlist' && c.type === type)),
    }));
    toast.success(`TMDB Watchlist (${type === 'movie' ? 'Movies' : 'Series'}) removed`);
  };

  // Favorites handlers
  const handleAddFavorites = (type: 'movie' | 'series' = 'movie') => {
    if (!sessionId) {
      toast.error("Please authenticate with TMDB first");
      return;
    }

    const catalogId = `tmdb.favorites`;
    
    if (config.catalogs.some(c => c.id === catalogId && c.type === type)) {
      toast.error("This favorites catalog is already added");
      return;
    }

    const catalogName = `TMDB Favorites`;
    const displayType = getDisplayTypeOverride(type, config.displayTypeOverrides);

    setConfig(prev => {
      const newCatalog: CatalogConfig = {
        id: catalogId,
        type: type,
        name: catalogName,
        enabled: true,
        showInHome: true,
        source: 'tmdb',
        ...(displayType && { displayType }),
      };

      return {
        ...prev,
        catalogs: [...prev.catalogs, newCatalog],
      };
    });

    toast.success(`TMDB Favorites (${type === 'movie' ? 'Movies' : 'Series'}) added`);
  };

  const handleRemoveFavorites = (type: 'movie' | 'series') => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.filter(c => !(c.id === 'tmdb.favorites' && c.type === type)),
    }));
    toast.success(`TMDB Favorites (${type === 'movie' ? 'Movies' : 'Series'}) removed`);
  };

  // Get all TMDB list catalogs
  const tmdbListCatalogs = config.catalogs.filter(c => c.id.startsWith('tmdb.list.'));

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            TMDB Lists Integration
            <a
              href="https://www.themoviedb.org/list"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          </DialogTitle>
          <DialogDescription>
            Import and manage custom lists from The Movie Database (TMDB)
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {!isValid && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
              <AlertCircle className="h-5 w-5 text-yellow-500 flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium">TMDB API Key Required</p>
                <p className="text-xs text-muted-foreground">
                  Please add your TMDB API key in the Integrations tab to use this feature
                </p>
              </div>
            </div>
          )}

          {isValid && (
            <>
              {/* TMDB Authentication */}
              <Card>
                <CardHeader>
                  <CardTitle>TMDB Authentication</CardTitle>
                  <CardDescription>
                    Required for accessing watchlist, favorites, and user-specific features
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {tmdbAuthError && !sessionId && (
                    <div className="mb-3 p-2 rounded-md bg-destructive/10 border border-destructive/20 flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0" />
                      <span className="text-sm text-destructive">{tmdbAuthError}</span>
                    </div>
                  )}
                  {sessionId ? (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CheckCircle className="h-5 w-5 text-green-500" />
                        <span className="text-sm font-medium">Authenticated with TMDB</span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleTmdbLogout}
                        disabled={tmdbAuthLoading}
                      >
                        <LogOut className="h-4 w-4 mr-2" />
                        Logout
                      </Button>
                    </div>
                  ) : (
                    <Button
                      onClick={handleTmdbLogin}
                      disabled={tmdbAuthLoading || !tmdbApiKey}
                      className="w-full"
                    >
                      {tmdbAuthLoading ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Connecting...
                        </>
                      ) : (
                        <>
                          <LogIn className="h-4 w-4 mr-2" />
                          Login with TMDB
                        </>
                      )}
                    </Button>
                  )}
                  {!sessionId && (
                    <p className="text-xs text-muted-foreground mt-2">
                      Opens a popup window. Complete the authorization and the window will close automatically.
                    </p>
                  )}
                </CardContent>
              </Card>

              {/* Watchlist */}
              {sessionId && (
                <Card>
                  <CardHeader>
                    <CardTitle>TMDB Watchlist</CardTitle>
                    <CardDescription>
                      Import your personal watchlist from TMDB
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex gap-2">
                      <Button 
                        onClick={() => handleAddWatchlist('movie')} 
                        variant="outline" 
                        className="flex-1"
                        disabled={hasWatchlistMovies}
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Movies
                      </Button>
                      <Button 
                        onClick={() => handleAddWatchlist('series')} 
                        variant="outline" 
                        className="flex-1"
                        disabled={hasWatchlistSeries}
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Series
                      </Button>
                    </div>

                    {(hasWatchlistMovies || hasWatchlistSeries) && (
                      <div className="space-y-2 border-t pt-4">
                        {hasWatchlistMovies && (
                          <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                            <span className="font-medium">TMDB Watchlist</span>
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground">Movies</span>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleRemoveWatchlist('movie')}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        )}
                        {hasWatchlistSeries && (
                          <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                            <span className="font-medium">TMDB Watchlist</span>
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground">Series</span>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleRemoveWatchlist('series')}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Favorites */}
              {sessionId && (
                <Card>
                  <CardHeader>
                    <CardTitle>TMDB Favorites</CardTitle>
                    <CardDescription>
                      Import your favorite movies and series from TMDB
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex gap-2">
                      <Button 
                        onClick={() => handleAddFavorites('movie')} 
                        variant="outline" 
                        className="flex-1"
                        disabled={hasFavoritesMovies}
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Movies
                      </Button>
                      <Button 
                        onClick={() => handleAddFavorites('series')} 
                        variant="outline" 
                        className="flex-1"
                        disabled={hasFavoritesSeries}
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Series
                      </Button>
                    </div>

                    {(hasFavoritesMovies || hasFavoritesSeries) && (
                      <div className="space-y-2 border-t pt-4">
                        {hasFavoritesMovies && (
                          <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                            <span className="font-medium">TMDB Favorites</span>
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground">Movies</span>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleRemoveFavorites('movie')}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        )}
                        {hasFavoritesSeries && (
                          <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                            <span className="font-medium">TMDB Favorites</span>
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground">Series</span>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleRemoveFavorites('series')}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Add Custom List */}
              <Card>
                <CardHeader>
                  <CardTitle>Import TMDB List</CardTitle>
                  <CardDescription>
                    Enter a TMDB list URL or list ID to import it as a catalog
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="tmdb-list-url">TMDB List URL or ID</Label>
                    <Input
                      id="tmdb-list-url"
                      placeholder="28-best-picture-winners or https://www.themoviedb.org/list/28"
                      value={customListUrl}
                      onChange={(e) => setCustomListUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handlePreviewList();
                        }
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      Enter list ID/slug (e.g., 28 or 28-best-picture-winners) or full URL. Find lists at{' '}
                      <a
                        href="https://www.themoviedb.org/list"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        themoviedb.org/list
                      </a>
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="list-type">Catalog Type</Label>
                    <Select value={customListType} onValueChange={(value: 'all' | 'split') => setCustomListType(value)}>
                      <SelectTrigger id="list-type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Unified (Movies & Series)</SelectItem>
                        <SelectItem value="split">Split (Separate Catalogs)</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Choose whether to create a single catalog or separate catalogs for movies and series
                    </p>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      onClick={handlePreviewList}
                      disabled={!customListUrl || listPreviewPending}
                      variant="outline"
                      className="flex-1"
                    >
                      {listPreviewPending ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Loading...
                        </>
                      ) : (
                        "Preview List"
                      )}
                    </Button>
                    <Button
                      onClick={handleAddList}
                      disabled={!listPreview}
                      className="flex-1"
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add List
                    </Button>
                  </div>

                  {listPreview && (
                    <div className="p-4 rounded-lg border bg-muted/30 space-y-2">
                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <p className="font-medium">{listPreview.name}</p>
                          <p className="text-sm text-muted-foreground">{listPreview.description}</p>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground">
                            <span>{listPreview.item_count} items</span>
                            <span>•</span>
                            <span>Created by {listPreview.created_by}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Current Lists */}
              {tmdbListCatalogs.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Your TMDB Lists</CardTitle>
                    <CardDescription>
                      {tmdbListCatalogs.length} list{tmdbListCatalogs.length !== 1 ? 's' : ''} imported
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {tmdbListCatalogs.map((catalog) => (
                      <div
                        key={catalog.id}
                        className="flex items-center justify-between p-3 border rounded-lg bg-muted/30"
                      >
                        <div className="space-y-0.5">
                          <span className="font-medium">{catalog.name}</span>
                          <p className="text-xs text-muted-foreground">
                            Type: {catalog.type === 'all' ? 'Unified' : catalog.type}
                            {catalog.metadata?.listDescription && ` • ${catalog.metadata.listDescription}`}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveList(catalog.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </>
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

