import React, { useState, useEffect } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { CatalogConfig } from '@/contexts/config';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ExternalLink, CheckCircle2, XCircle, Loader2, ChevronDown, Plus } from 'lucide-react';
import { toast } from "sonner";
import { apiCache } from '@/utils/apiCache';

interface SimklIntegrationProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SimklIntegration({ isOpen, onClose }: SimklIntegrationProps) {
  const [simklClientId, setSimklClientId] = useState<string>("");
  
  useEffect(() => {
    fetch("/api/config")
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data && data.simkl) setSimklClientId(data.simkl);
      });
  }, []);

  const { config, setConfig, auth } = useConfig();
  const [tempTokenId, setTempTokenId] = useState(config.apiKeys?.simklTokenId || "");
  const [isConnected, setIsConnected] = useState(!!config.apiKeys?.simklTokenId);
  const [disconnecting, setDisconnecting] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [loadingUsername, setLoadingUsername] = useState(false);
  const [userStats, setUserStats] = useState<any>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [statsCollapsed, setStatsCollapsed] = useState(true);

  const authUrl = "/api/auth/simkl/authorize";

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

  useEffect(() => {
    if (isOpen) {
      setIsConnected(!!config.apiKeys?.simklTokenId);
      setTempTokenId(config.apiKeys?.simklTokenId || "");
      
      if (config.apiKeys?.simklTokenId) {
        setLoadingUsername(true);
        fetch("/api/oauth/token/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tokenId: config.apiKeys.simklTokenId }),
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
  }, [isOpen, config.apiKeys?.simklTokenId]);

  // Fetch Simkl user stats when connected
  useEffect(() => {
    if (isConnected && config.apiKeys?.simklTokenId && simklClientId) {
      setLoadingStats(true);
      const cacheKey = `simkl_stats_${config.apiKeys.simklTokenId}`;
      apiCache.cachedFetch(
        cacheKey,
        async () => {
          const response = await fetch("/api/simkl/users/stats", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tokenId: config.apiKeys.simklTokenId }),
          });
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
  }, [isConnected, config.apiKeys?.simklTokenId, simklClientId]);

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
        if (data.provider === 'simkl') {
          setUsername(data.username);
          
          setConfig(prev => ({
            ...prev,
            apiKeys: {
              ...prev.apiKeys,
              simklTokenId: tempTokenId.trim(),
            },
          }));

          setIsConnected(true);
          toast.success(`Connected as @${data.username}`);
        } else {
          toast.error("Invalid Simkl token");
        }
      } else {
        toast.error("Invalid token ID");
      }
    } catch (error) {
      console.error("Token validation error:", error);
      toast.error("Failed to validate token");
    }
  };

  // Handlers to add trending catalogs
  const handleAddTrendingCatalog = (type: 'movies' | 'shows' | 'anime') => {
    const id = `simkl.trending.${type}`;
    if (config.catalogs.some(c => c.id === id)) {
      toast.info(`Trending ${type} catalog already added.`);
      return;
    }
    const catalogType = type === 'movies' ? 'movie' : type === 'anime' ? 'anime' : 'series';
    const displayType = getDisplayTypeOverride(catalogType, config.displayTypeOverrides);
    const newCatalog: CatalogConfig = {
      id,
      type: catalogType,
      name: `Simkl Trending ${type.charAt(0).toUpperCase() + type.slice(1)}`,
      enabled: true,
      showInHome: true,
      source: 'simkl' as any,
      metadata: { interval: 'today' },
      ...(displayType && { displayType })
    };
    setConfig(prev => ({ ...prev, catalogs: [...prev.catalogs, newCatalog] }));
    toast.success(`Added Simkl Trending ${type}`);
  };

  const handleAddDvdReleasesCatalog = () => {
    const id = 'simkl.dvd.movies';
    if (config.catalogs.some(c => c.id === id)) {
      toast.info('Simkl DVD Releases catalog already added.');
      return;
    }
    const displayType = getDisplayTypeOverride('movie', config.displayTypeOverrides);
    const newCatalog: CatalogConfig = {
      id,
      type: 'movie',
      name: 'Simkl DVD Releases',
      enabled: true,
      showInHome: true,
      source: 'simkl' as any,
      ...(displayType && { displayType })
    };
    setConfig(prev => ({ ...prev, catalogs: [...prev.catalogs, newCatalog] }));
    toast.success('Added Simkl DVD Releases');
  };

  // Handlers to add watchlist catalogs
  const handleAddWatchlistCatalog = (type: 'movies' | 'shows' | 'anime', status: 'watching' | 'plantowatch' | 'hold' | 'completed' | 'dropped') => {
    const id = `simkl.watchlist.${type}.${status}`;
    if (config.catalogs.some(c => c.id === id)) {
      toast.info(`Watchlist ${type} ${status} catalog already added.`);
      return;
    }
    const catalogType = type === 'movies' ? 'movie' : type === 'anime' ? 'anime' : 'series';
    const displayType = getDisplayTypeOverride(catalogType, config.displayTypeOverrides);
    const statusDisplayNames: Record<string, string> = {
      'watching': 'Watching',
      'plantowatch': 'Plan to Watch',
      'hold': 'On Hold',
      'completed': 'Completed',
      'dropped': 'Dropped'
    };
    const newCatalog: CatalogConfig = {
      id,
      type: catalogType,
      name: `Simkl ${statusDisplayNames[status]} ${type.charAt(0).toUpperCase() + type.slice(1)}`,
      enabled: true,
      showInHome: true,
      source: 'simkl' as any,
      metadata: { status },
      ...(displayType && { displayType })
    };
    setConfig(prev => ({ ...prev, catalogs: [...prev.catalogs, newCatalog] }));
    toast.success(`Added Simkl ${statusDisplayNames[status]} ${type}`);
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
            simklTokenId: undefined,
          },
        }));
        setTempTokenId("");
        setIsConnected(false);
        setUsername(null);
        toast.success("Simkl account disconnected");
        setDisconnecting(false);
        return;
      }

      // For registered users, call the backend to clean up database
      const response = await fetch("/api/auth/simkl/disconnect", {
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
      toast.success("Simkl account disconnected");
      
      window.location.reload();
    } catch (error) {
      console.error("Disconnect error:", error);
      toast.error(error instanceof Error ? error.message : "Failed to disconnect Simkl");
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl w-full max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <img 
              src="https://us.simkl.in/img_favicon/v2/favicon-192x192.png" 
              alt="Simkl" 
              className="h-7 w-7 rounded object-contain" 
            />
            <DialogTitle>Simkl Integration</DialogTitle>
          </div>
          <DialogDescription>
            Connect your Simkl account to import watchlists and sync your viewing history
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
                    <Label>Step 1: Authorize Simkl</Label>
                    <Button onClick={handleConnect} className="w-full" disabled={!simklClientId}>
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Authorize with Simkl
                    </Button>
                    {!simklClientId && (
                      <p className="text-xs text-red-500 mt-2">
                        Instance owner has not yet set up the Simkl integration.
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Opens a new window. You'll receive a Token ID to paste below.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="simkl-token">Step 2: Paste Token ID</Label>
                    <Input
                      id="simkl-token"
                      placeholder="Paste your Simkl Token ID here"
                      value={tempTokenId}
                      onChange={(e) => setTempTokenId(e.target.value)}
                    />
                  </div>

                  <Button onClick={handleSave} disabled={!tempTokenId.trim() || !simklClientId} className="w-full">
                    Connect Simkl
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                    <div className="flex items-center gap-3">
                      <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
                      <div>
                        <p className="font-medium text-green-900 dark:text-green-100">Connected to Simkl</p>
                        {loadingUsername ? (
                          <div className="flex items-center gap-2 mt-1">
                            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                            <p className="text-xs text-muted-foreground">Loading...</p>
                          </div>
                        ) : username ? (
                          <p className="text-xs text-muted-foreground">@{username}</p>
                        ) : null}
                      </div>
                    </div>
                    <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={disconnecting}>
                      {disconnecting ? 'Disconnecting...' : 'Disconnect'}
                    </Button>
                  </div>

                  {/* Simkl User Stats Card */}
                  {isConnected && username && (
                    <Card className="mb-4">
                      <CardHeader className="cursor-pointer" onClick={() => setStatsCollapsed(!statsCollapsed)}>
                        <div className="flex items-center justify-between">
                          <div>
                            <CardTitle>Simkl Stats</CardTitle>
                            <CardDescription>Overview of your Simkl activity</CardDescription>
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
                                      <span className="text-xs text-muted-foreground">Plan to Watch</span>
                                      <span className="font-bold text-sm">{formatNumber(userStats.movies?.plantowatch?.count || 0)}</span>
                                    </div>
                                    <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                      <span className="text-xs text-muted-foreground">Not Interested</span>
                                      <span className="font-bold text-sm">{formatNumber(userStats.movies?.notinteresting?.count || 0)}</span>
                                    </div>
                                    <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                      <span className="text-xs text-muted-foreground">Completed</span>
                                      <span className="font-bold text-sm">{formatNumber(userStats.movies?.completed?.count || 0)}</span>
                                    </div>
                                    <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                      <span className="text-xs text-muted-foreground">Hours</span>
                                      <span className="font-bold text-sm">{formatNumber(Math.round((userStats.movies?.total_mins || 0) / 60))}</span>
                                    </div>
                                  </div>
                                </div>

                                {/* TV Shows */}
                                <div className="space-y-3">
                                  <h3 className="font-semibold text-sm text-muted-foreground">TV Shows</h3>
                                  <div className="space-y-2">
                                    <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                      <span className="text-xs text-muted-foreground">Watching</span>
                                      <span className="font-bold text-sm">{formatNumber(userStats.tv?.watching?.count || 0)}</span>
                                    </div>
                                    <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                      <span className="text-xs text-muted-foreground">On Hold</span>
                                      <span className="font-bold text-sm">{formatNumber(userStats.tv?.hold?.count || 0)}</span>
                                    </div>
                                    <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                      <span className="text-xs text-muted-foreground">Plan to Watch</span>
                                      <span className="font-bold text-sm">{formatNumber(userStats.tv?.plantowatch?.count || 0)}</span>
                                    </div>
                                    <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                      <span className="text-xs text-muted-foreground">Completed</span>
                                      <span className="font-bold text-sm">{formatNumber(userStats.tv?.completed?.count || 0)}</span>
                                    </div>
                                  </div>
                                </div>

                                {/* Episodes */}
                                <div className="space-y-3">
                                  <h3 className="font-semibold text-sm text-muted-foreground">Episodes</h3>
                                  <div className="space-y-2">
                                    <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                      <span className="text-xs text-muted-foreground">Watched</span>
                                      <span className="font-bold text-sm">{formatNumber(userStats.tv?.watching?.watched_episodes_count || 0)}</span>
                                    </div>
                                    <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                      <span className="text-xs text-muted-foreground">Left to Watch</span>
                                      <span className="font-bold text-sm">{formatNumber(userStats.tv?.watching?.left_to_watch_episodes || 0)}</span>
                                    </div>
                                    <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                      <span className="text-xs text-muted-foreground">Hours Watched</span>
                                      <span className="font-bold text-sm">{formatNumber(Math.round((userStats.tv?.total_mins || 0) / 60))}</span>
                                    </div>
                                    <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                      <span className="text-xs text-muted-foreground">Hours Left</span>
                                      <span className="font-bold text-sm">{formatNumber(Math.round((userStats.tv?.watching?.left_to_watch_mins || 0) / 60))}</span>
                                    </div>
                                  </div>
                                </div>

                                {/* Anime */}
                                <div className="space-y-3">
                                  <h3 className="font-semibold text-sm text-muted-foreground">Anime</h3>
                                  <div className="space-y-2">
                                    <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                      <span className="text-xs text-muted-foreground">Watching</span>
                                      <span className="font-bold text-sm">{formatNumber(userStats.anime?.watching?.count || 0)}</span>
                                    </div>
                                    <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                      <span className="text-xs text-muted-foreground">On Hold</span>
                                      <span className="font-bold text-sm">{formatNumber(userStats.anime?.hold?.count || 0)}</span>
                                    </div>
                                    <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                      <span className="text-xs text-muted-foreground">Plan to Watch</span>
                                      <span className="font-bold text-sm">{formatNumber(userStats.anime?.plantowatch?.count || 0)}</span>
                                    </div>
                                    <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                      <span className="text-xs text-muted-foreground">Completed</span>
                                      <span className="font-bold text-sm">{formatNumber(userStats.anime?.completed?.count || 0)}</span>
                                    </div>
                                  </div>
                                </div>
                              </div>

                              {/* Total Time & Last Week Section */}
                              <div className="pt-4 border-t">
                                <h3 className="font-semibold text-sm text-muted-foreground mb-3">Time Spent</h3>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                  <div className="flex justify-between items-center p-3 rounded-lg bg-muted/40">
                                    <span className="text-sm text-muted-foreground">Total Hours</span>
                                    <span className="font-bold text-base">{formatNumber(Math.round((userStats.total_mins || 0) / 60))}</span>
                                  </div>
                                  {userStats.watched_last_week && (
                                    <div className="flex justify-between items-center p-3 rounded-lg bg-muted/40">
                                      <span className="text-sm text-muted-foreground">Last Week</span>
                                      <span className="font-bold text-base">{formatNumber(Math.round((userStats.watched_last_week.total_mins || 0) / 60))} hours</span>
                                    </div>
                                  )}
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

                  

                  <Card>
                    <CardHeader>
                      <CardTitle>Watchlist Catalogs</CardTitle>
                      <CardDescription>Add watchlist catalogs for movies, shows, and anime by status</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="space-y-3">
                        <div>
                          <p className="text-sm font-medium mb-2">Movies</p>
                          <div className="grid grid-cols-2 gap-2">
                            <Button 
                              onClick={() => handleAddWatchlistCatalog('movies', 'plantowatch')} 
                              variant="outline" 
                              size="sm"
                              disabled={!isConnected || config.catalogs.some(c => c.id === 'simkl.watchlist.movies.plantowatch')}
                            >
                              <Plus className="mr-2 h-3 w-3" />
                              Plan to Watch
                            </Button>
                            <Button 
                              onClick={() => handleAddWatchlistCatalog('movies', 'completed')} 
                              variant="outline" 
                              size="sm"
                              disabled={!isConnected || config.catalogs.some(c => c.id === 'simkl.watchlist.movies.completed')}
                            >
                              <Plus className="mr-2 h-3 w-3" />
                              Completed
                            </Button>
                            <Button 
                              onClick={() => handleAddWatchlistCatalog('movies', 'hold')} 
                              variant="outline" 
                              size="sm"
                              disabled={!isConnected || config.catalogs.some(c => c.id === 'simkl.watchlist.movies.hold')}
                            >
                              <Plus className="mr-2 h-3 w-3" />
                              On Hold
                            </Button>
                            <Button 
                              onClick={() => handleAddWatchlistCatalog('movies', 'dropped')} 
                              variant="outline" 
                              size="sm"
                              disabled={!isConnected || config.catalogs.some(c => c.id === 'simkl.watchlist.movies.dropped')}
                              className="col-span-2"
                            >
                              <Plus className="mr-2 h-3 w-3" />
                              Dropped
                            </Button>
                          </div>
                        </div>

                        <div>
                          <p className="text-sm font-medium mb-2">Shows</p>
                          <div className="grid grid-cols-2 gap-2">
                            <Button 
                              onClick={() => handleAddWatchlistCatalog('shows', 'watching')} 
                              variant="outline" 
                              size="sm"
                              disabled={!isConnected || config.catalogs.some(c => c.id === 'simkl.watchlist.shows.watching')}
                            >
                              <Plus className="mr-2 h-3 w-3" />
                              Watching
                            </Button>
                            <Button 
                              onClick={() => handleAddWatchlistCatalog('shows', 'plantowatch')} 
                              variant="outline" 
                              size="sm"
                              disabled={!isConnected || config.catalogs.some(c => c.id === 'simkl.watchlist.shows.plantowatch')}
                            >
                              <Plus className="mr-2 h-3 w-3" />
                              Plan to Watch
                            </Button>
                            <Button 
                              onClick={() => handleAddWatchlistCatalog('shows', 'completed')} 
                              variant="outline" 
                              size="sm"
                              disabled={!isConnected || config.catalogs.some(c => c.id === 'simkl.watchlist.shows.completed')}
                            >
                              <Plus className="mr-2 h-3 w-3" />
                              Completed
                            </Button>
                            <Button 
                              onClick={() => handleAddWatchlistCatalog('shows', 'hold')} 
                              variant="outline" 
                              size="sm"
                              disabled={!isConnected || config.catalogs.some(c => c.id === 'simkl.watchlist.shows.hold')}
                            >
                              <Plus className="mr-2 h-3 w-3" />
                              On Hold
                            </Button>
                            <Button 
                              onClick={() => handleAddWatchlistCatalog('shows', 'dropped')} 
                              variant="outline" 
                              size="sm"
                              disabled={!isConnected || config.catalogs.some(c => c.id === 'simkl.watchlist.shows.dropped')}
                              className="col-span-2"
                            >
                              <Plus className="mr-2 h-3 w-3" />
                              Dropped
                            </Button>
                          </div>
                        </div>

                        <div>
                          <p className="text-sm font-medium mb-2">Anime</p>
                          <div className="grid grid-cols-2 gap-2">
                            <Button 
                              onClick={() => handleAddWatchlistCatalog('anime', 'watching')} 
                              variant="outline" 
                              size="sm"
                              disabled={!isConnected || config.catalogs.some(c => c.id === 'simkl.watchlist.anime.watching')}
                            >
                              <Plus className="mr-2 h-3 w-3" />
                              Watching
                            </Button>
                            <Button 
                              onClick={() => handleAddWatchlistCatalog('anime', 'plantowatch')} 
                              variant="outline" 
                              size="sm"
                              disabled={!isConnected || config.catalogs.some(c => c.id === 'simkl.watchlist.anime.plantowatch')}
                            >
                              <Plus className="mr-2 h-3 w-3" />
                              Plan to Watch
                            </Button>
                            <Button 
                              onClick={() => handleAddWatchlistCatalog('anime', 'completed')} 
                              variant="outline" 
                              size="sm"
                              disabled={!isConnected || config.catalogs.some(c => c.id === 'simkl.watchlist.anime.completed')}
                            >
                              <Plus className="mr-2 h-3 w-3" />
                              Completed
                            </Button>
                            <Button 
                              onClick={() => handleAddWatchlistCatalog('anime', 'hold')} 
                              variant="outline" 
                              size="sm"
                              disabled={!isConnected || config.catalogs.some(c => c.id === 'simkl.watchlist.anime.hold')}
                            >
                              <Plus className="mr-2 h-3 w-3" />
                              On Hold
                            </Button>
                            <Button 
                              onClick={() => handleAddWatchlistCatalog('anime', 'dropped')} 
                              variant="outline" 
                              size="sm"
                              disabled={!isConnected || config.catalogs.some(c => c.id === 'simkl.watchlist.anime.dropped')}
                              className="col-span-2"
                            >
                              <Plus className="mr-2 h-3 w-3" />
                              Dropped
                            </Button>
                          </div>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        These catalogs show your Simkl watchlist items by status. Page size must match your SimKL settings.
                      </p>
                    </CardContent>
                  </Card>
                </div>
              )}
              {}
              <Card>
                <CardHeader>
                  <CardTitle>Trending & Calendar</CardTitle>
                  <CardDescription>Add trending catalogs or view upcoming releases</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex gap-2">
                    <Button
                      onClick={() => handleAddTrendingCatalog('movies')}
                      variant="outline"
                      className="flex-1"
                      disabled={config.catalogs.some(c => c.id === 'simkl.trending.movies')}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Trending Movies
                    </Button>
                    <Button
                      onClick={() => handleAddTrendingCatalog('shows')}
                      variant="outline"
                      className="flex-1"
                      disabled={config.catalogs.some(c => c.id === 'simkl.trending.shows')}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Trending Shows
                    </Button>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => handleAddTrendingCatalog('anime')}
                      variant="outline"
                      className="flex-1"
                      disabled={config.catalogs.some(c => c.id === 'simkl.trending.anime')}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Trending Anime
                    </Button>
                    <Button
                      onClick={() => {
                        const newCatalog: CatalogConfig = {
                          id: "simkl.calendar.anime",
                          type: "anime",
                          name: "Simkl Anime Airing Soon",
                          enabled: true,
                          showInHome: true,
                          source: "simkl",
                          metadata: { airingSoonDays: 1 }
                        };
                        setConfig(prev => ({ ...prev, catalogs: [...prev.catalogs, newCatalog] }));
                        toast.success("Added Simkl Anime Airing Soon");
                      }}
                      variant="outline"
                      className="flex-1"
                      disabled={config.catalogs.some(c => c.id === 'simkl.calendar.anime')}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Airing Soon (Anime)
                    </Button>
                    <Button
                      onClick={() => {
                        const newCatalog: CatalogConfig = {
                          id: "simkl.calendar.series",
                          type: "series",
                          name: "Simkl TV Airing Soon",
                          enabled: true,
                          showInHome: true,
                          source: "simkl",
                          metadata: { airingSoonDays: 1 }
                        };
                        setConfig(prev => ({ ...prev, catalogs: [...prev.catalogs, newCatalog] }));
                        toast.success("Added Simkl TV Airing Soon");
                      }}
                      variant="outline"
                      className="flex-1"
                      disabled={config.catalogs.some(c => c.id === 'simkl.calendar.series')}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Airing Soon (Series)
                    </Button>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={handleAddDvdReleasesCatalog}
                      variant="outline"
                      className="flex-1"
                      disabled={config.catalogs.some(c => c.id === 'simkl.dvd.movies')}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      DVD Releases
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Trending catalogs update automatically. Airing Soon shows TV and Anime episodes releasing in your timezone.
                  </p>
                </CardContent>
              </Card>
            </CardContent>
          </Card>
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
