import React, { useState, useEffect } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { applyDisconnectRemovals, persistIntegrationCredential } from '@/lib/integrationCredentials';
import { useSave } from '@/contexts/SaveContext';
import { CatalogConfig } from '@/contexts/config';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { ExternalLink, CheckCircle2, XCircle, Loader2, ChevronDown, Plus, Link2, BarChart3, Bookmark, TrendingUp, Sparkles, PlayCircle, Trash2, Download } from 'lucide-react';
import { toast } from "sonner";
import { apiCache } from '@/utils/apiCache';
import { DeviceAuthCard } from '@/components/DeviceAuthCard';
import { useDeviceAuth } from '@/hooks/useDeviceAuth';

interface SimklCustomList {
  id: string;
  name: string;
  description: string;
  mediaType: 'movies' | 'tv' | 'anime';
  privacy: string;
  itemCount: number;
}

interface SimklQuota {
  limit: number;
  remaining: number;
  resetsAt: number;
  pausedUntil?: number;
}

function formatResetIn(resetsAt: number): string {
  const minutes = Math.max(1, Math.round((resetsAt - Date.now()) / 60000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

interface SimklIntegrationProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SimklIntegration({ isOpen, onClose }: SimklIntegrationProps) {
  const [simklClientId, setSimklClientId] = useState<string>("");
  const [simklAuthMode, setSimklAuthMode] = useState<'oauth' | 'pin' | 'both'>('oauth');
  const [simklV2Available, setSimklV2Available] = useState(false);
  const [serverSyncMinutes, setServerSyncMinutes] = useState(30);
  
  useEffect(() => {
    fetch("/api/config")
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data && data.simkl) setSimklClientId(data.simkl);
        setSimklV2Available(Boolean(data?.simklV2));
        if (Number(data?.simklActivitiesTTL) > 0) setServerSyncMinutes(Math.max(1, Math.round(data.simklActivitiesTTL / 60)));
        if (data && (data.simklAuthMode === 'pin' || data.simklAuthMode === 'both' || data.simklAuthMode === 'oauth')) {
          setSimklAuthMode(data.simklAuthMode);
        }
      });
  }, []);

  const pinEnabled = simklAuthMode === 'pin' || simklAuthMode === 'both';
  const oauthEnabled = simklAuthMode === 'oauth' || simklAuthMode === 'both';

  const { config, setConfig, auth } = useConfig();
  const { markConfigPersisted, isDirty } = useSave();
  const [tempTokenId, setTempTokenId] = useState(config.apiKeys?.simklTokenId || "");
  const [isConnected, setIsConnected] = useState(!!config.apiKeys?.simklTokenId);
  const [disconnecting, setDisconnecting] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [loadingUsername, setLoadingUsername] = useState(false);
  const [authVersion, setAuthVersion] = useState<'v1' | 'v2' | null>(null);
  const [quota, setQuota] = useState<SimklQuota | null>(null);
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

  const loadTokenInfo = (tokenId: string) => {
    setLoadingUsername(true);
    fetch("/api/oauth/token/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenId }),
    })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.username) setUsername(data.username);
        setAuthVersion(data?.authVersion ?? null);
        setQuota(data?.quota ?? null);
      })
      .catch(() => setUsername(null))
      .finally(() => setLoadingUsername(false));
  };

  useEffect(() => {
    if (isOpen) {
      setIsConnected(!!config.apiKeys?.simklTokenId);
      setTempTokenId(config.apiKeys?.simklTokenId || "");
      
      if (config.apiKeys?.simklTokenId) {
        loadTokenInfo(config.apiKeys.simklTokenId);
      } else {
        setUsername(null);
        setAuthVersion(null);
        setQuota(null);
      }
    }
  }, [isOpen, config.apiKeys?.simklTokenId]);

  const [customLists, setCustomLists] = useState<SimklCustomList[]>([]);
  const [selectedCustomLists, setSelectedCustomLists] = useState<Set<string>>(new Set());
  const [isLoadingCustomLists, setIsLoadingCustomLists] = useState(false);

  const fetchCustomLists = async () => {
    const tokenId = config.apiKeys?.simklTokenId;
    if (!tokenId) {
      toast.error("Connect your Simkl account first.");
      return;
    }
    setIsLoadingCustomLists(true);
    try {
      const response = await fetch("/api/simkl/lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenId }),
      });
      if (!response.ok) throw new Error(`Failed to fetch lists (Status: ${response.status})`);
      const data = await response.json();
      if (data?.error === 'needs_v2') {
        toast.error("Reconnect Simkl to load custom lists", {
          description: "Custom lists need the newer Simkl connection. Disconnect Simkl above and connect it again."
        });
        setCustomLists([]);
        return;
      }
      if (data?.error === 'premium_only') {
        toast.error("Custom lists need Simkl PRO or VIP", {
          description: "Simkl only shares custom lists with PRO and VIP accounts."
        });
        setCustomLists([]);
        return;
      }
      const lists: SimklCustomList[] = Array.isArray(data?.lists) ? data.lists : [];
      setCustomLists(lists);
      setSelectedCustomLists(new Set());
      if (lists.length === 0) {
        toast.info("No custom lists found", { description: "Make one at simkl.com/lists." });
      } else {
        toast.success("Custom lists loaded", { description: `Found ${lists.length} list(s)` });
      }
    } catch (error) {
      toast.error("Failed to load custom lists", {
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
      setCustomLists([]);
    } finally {
      setIsLoadingCustomLists(false);
    }
  };

  const handleCustomListSelection = (listId: string, checked: boolean) => {
    const next = new Set(selectedCustomLists);
    if (checked) next.add(listId);
    else next.delete(listId);
    setSelectedCustomLists(next);
  };

  /** Returns how many were new: a list already in the catalogs is left as it is. */
  const addListCatalogs = (lists: SimklCustomList[]): number => {
    const toAdd = lists.filter(list => !config.catalogs.some(c => c.id === `simkl.list.${list.id}`));
    setConfig(prev => {
      const catalogs = [...prev.catalogs];
      for (const list of toAdd) {
        const id = `simkl.list.${list.id}`;
        if (catalogs.some(c => c.id === id)) continue;
        const catalogType = list.mediaType === 'movies' ? 'movie' : list.mediaType === 'anime' ? 'anime' : 'series';
        const displayType = getDisplayTypeOverride(catalogType, prev.displayTypeOverrides);
        catalogs.push({
          id,
          type: catalogType,
          name: list.name,
          enabled: true,
          showInHome: true,
          source: 'simkl' as any,
          metadata: {
            listId: list.id,
            listName: list.name,
            listDescription: list.description,
            mediatype: list.mediaType,
            itemCount: list.itemCount,
            privacy: list.privacy,
            isPublic: list.privacy === 'public',
          },
          ...(displayType && { displayType })
        });
      }
      return { ...prev, catalogs };
    });
    return toAdd.length;
  };

  const importSelectedCustomLists = () => {
    if (selectedCustomLists.size === 0) {
      toast.error("Please select at least one list to import.");
      return;
    }
    const added = addListCatalogs(customLists.filter(list => selectedCustomLists.has(list.id)));
    setSelectedCustomLists(new Set());
    toast.success(added ? `Imported ${added} list(s)` : "Those lists are already in your catalogs");
  };

  const [listLink, setListLink] = useState('');
  const [isAddingList, setIsAddingList] = useState(false);

  const addListByLink = async () => {
    const tokenId = config.apiKeys?.simklTokenId;
    if (!tokenId) {
      toast.error("Connect your Simkl account first.");
      return;
    }
    setIsAddingList(true);
    try {
      const response = await fetch("/api/simkl/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenId, list: listLink }),
      });
      const data = await response.json().catch(() => null);
      if (response.status === 400) {
        toast.error("That is not a Simkl list", { description: "Paste a simkl.com/lists link or the list's numeric id." });
        return;
      }
      if (!response.ok) throw new Error(data?.error || `Status ${response.status}`);
      if (data?.error === 'needs_v2') {
        toast.error("Reconnect Simkl to add custom lists", {
          description: "Custom lists need the newer Simkl connection. Disconnect Simkl above and connect it again."
        });
        return;
      }
      if (data?.error === 'premium_only') {
        toast.error("Custom lists need Simkl PRO or VIP", {
          description: "Simkl only shares custom lists with PRO and VIP accounts."
        });
        return;
      }
      if (data?.error === 'not_found' || !data?.list) {
        toast.error("No such list", { description: "It may be private, or the id may be wrong." });
        return;
      }
      const added = addListCatalogs([data.list]);
      setListLink('');
      toast.success(added ? `Added ${data.list.name}` : `${data.list.name} is already in your catalogs`, {
        ...(added && data.list.owner ? { description: `A list by ${data.list.owner}, ${data.list.itemCount} items` } : {}),
      });
    } catch (error) {
      toast.error("Could not add that list", {
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
    } finally {
      setIsAddingList(false);
    }
  };

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

  const applyToken = (tokenId: string, connectedUsername: string) => {
    setUsername(connectedUsername);
    setTempTokenId(tokenId);
    loadTokenInfo(tokenId);
    setConfig(prev => ({
      ...prev,
      apiKeys: {
        ...prev.apiKeys,
        simklTokenId: tokenId,
      },
    }));

    // Persisted straight away so navigating away cannot lose the connection
    // and cannot strand the credential row with nothing pointing at it.
    void persistIntegrationCredential({ provider: 'simkl', tokenId, userUUID: auth.userUUID, password: auth.password, authenticated: auth.authenticated })
      .then(result => { if (result.error) toast.warning(`Connected, but the link was not saved: ${result.error}`); });

    setIsConnected(true);
    toast.success(`Connected as @${connectedUsername}`);
  };

  // No callback URL here, the server talks to Simkl directly while the user
  // types the code on simkl.com/pin.
  const pinAuth = useDeviceAuth({
    startPath: "/api/auth/simkl/pin",
    statusPath: "/api/auth/simkl/pin/status",
    cancelPath: "/api/auth/simkl/pin/cancel",
    active: isOpen,
    providerLabel: "Simkl",
    onAuthorized: applyToken,
  });

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
          applyToken(tempTokenId.trim(), data.username);
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

  const handleAddRecipeCatalog = (recipe: string, type: 'movies' | 'shows' | 'anime', label: string) => {
    const id = `simkl.recipe.${recipe}.${type}`;
    if (config.catalogs.some(c => c.id === id)) {
      toast.info(`${label} catalog already added.`);
      return;
    }
    const catalogType = type === 'movies' ? 'movie' : type === 'anime' ? 'anime' : 'series';
    const displayType = getDisplayTypeOverride(catalogType, config.displayTypeOverrides);
    const newCatalog: CatalogConfig = {
      id,
      type: catalogType,
      name: `Simkl ${label}`,
      enabled: true,
      showInHome: true,
      source: 'simkl' as any,
      metadata: { interval: 'week' },
      ...(displayType && { displayType })
    };
    setConfig(prev => ({ ...prev, catalogs: [...prev.catalogs, newCatalog] }));
    toast.success(`Added Simkl ${label}`);
  };

  // Handlers to add watchlist catalogs
  const handleAddWatchlistCatalog = (type: 'movies' | 'shows' | 'anime' | 'all', status: 'watching' | 'plantowatch' | 'hold' | 'completed' | 'dropped') => {
    const id = `simkl.watchlist.${type}.${status}`;
    if (config.catalogs.some(c => c.id === id)) {
      toast.info(`Watchlist ${type} ${status} catalog already added.`);
      return;
    }
    const catalogType = type === 'all' ? 'all' : type === 'movies' ? 'movie' : type === 'anime' ? 'anime' : 'series';
    const displayType = type === 'all' ? undefined : getDisplayTypeOverride(catalogType, config.displayTypeOverrides);
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
      name: type === 'all' ? `Simkl ${statusDisplayNames[status]}` : `Simkl ${statusDisplayNames[status]} ${type.charAt(0).toUpperCase() + type.slice(1)}`,
      enabled: true,
      showInHome: true,
      source: 'simkl' as any,
      metadata: { status },
      ...(displayType && { displayType })
    };
    setConfig(prev => ({ ...prev, catalogs: [...prev.catalogs, newCatalog] }));
    toast.success(type === 'all' ? `Added Simkl ${statusDisplayNames[status]}` : `Added Simkl ${statusDisplayNames[status]} ${type}`);
  };

  const handleAddUpNext = () => {
    if (!isConnected) {
      toast.error('Please connect your Simkl account first');
      return;
    }
    setConfig(prev => {
      const displayType = getDisplayTypeOverride('series', prev.displayTypeOverrides);
      const newCatalog: CatalogConfig = {
        id: 'simkl.upnext',
        type: 'series',
        name: 'Simkl Up Next',
        enabled: true,
        showInHome: true,
        source: 'simkl' as any,
        cacheTTL: 300,
        metadata: { useShowPosterForUpNext: false, includeAnimeInUpNext: true },
        ...(displayType && { displayType }),
      };
      return { ...prev, catalogs: [...prev.catalogs, newCatalog] };
    });
    toast.success('Up Next catalog added');
  };

  const handleRemoveUpNext = () => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.filter(c => c.id !== 'simkl.upnext'),
    }));
    toast.success('Up Next catalog removed');
  };

  const handleAddAnimeUpNext = () => {
    if (!isConnected) {
      toast.error('Please connect your Simkl account first');
      return;
    }
    setConfig(prev => {
      const displayType = getDisplayTypeOverride('anime', prev.displayTypeOverrides);
      const newCatalog: CatalogConfig = {
        id: 'simkl.upnext.anime',
        type: 'anime',
        name: 'Simkl Anime Up Next',
        enabled: true,
        showInHome: true,
        source: 'simkl' as any,
        cacheTTL: 300,
        metadata: { useShowPosterForUpNext: false },
        ...(displayType && { displayType }),
      };
      // Two rows listing the same anime is never what the user wants, so adding
      // the dedicated row takes anime out of the combined one.
      const catalogs = prev.catalogs.map(c =>
        c.id === 'simkl.upnext'
          ? { ...c, metadata: { ...c.metadata, includeAnimeInUpNext: false } }
          : c
      );
      return { ...prev, catalogs: [...catalogs, newCatalog] };
    });
    toast.success('Anime Up Next catalog added');
  };

  const handleRemoveAnimeUpNext = () => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.filter(c => c.id !== 'simkl.upnext.anime'),
    }));
    toast.success('Anime Up Next catalog removed');
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
        body: JSON.stringify({ userUUID: auth.userUUID, password: auth.password }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || "Failed to disconnect");
      }
      
      setTempTokenId("");
      setIsConnected(false);
      setUsername(null);
      // Reloading dropped the session, which is held in memory only, so the
      // saved config comes back from the server and is adopted in place.
      // The server already saved these removals. If nothing else was pending, the page
      // now matches disk, so the baseline moves with it rather than claiming unsaved work.
      const next = applyDisconnectRemovals(config, data.removed);
      setConfig(next);
      if (isDirty === false) markConfigPersisted(next);
      toast.success("Simkl account disconnected");
    } catch (error) {
      console.error("Disconnect error:", error);
      toast.error(error instanceof Error ? error.message : "Failed to disconnect Simkl");
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
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
          <Card className="bg-gradient-to-br from-slate-500/10 via-card/80 to-card/80 border-slate-400/20">
            <CardHeader className="flex-row items-start gap-3 sm:gap-4 space-y-0 p-4 sm:p-6">
              <div className="shrink-0 h-10 w-10 rounded-lg bg-slate-500/15 text-slate-300 flex items-center justify-center ring-1 ring-slate-400/20">
                <Link2 className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0 space-y-1.5">
                <CardTitle>Connection Status</CardTitle>
              </div>
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

                  {pinEnabled && (
                    <div className="space-y-2">
                      <Label>Connect with a PIN</Label>
                      <DeviceAuthCard
                        code={pinAuth.code}
                        requesting={pinAuth.requesting}
                        disabled={!simklClientId}
                        startLabel="Get a Simkl PIN"
                        hint="Opens simkl.com/pin in a new tab. No public callback URL needed."
                        onStart={pinAuth.start}
                        onCancel={pinAuth.cancel}
                      />
                    </div>
                  )}

                  {oauthEnabled && (
                    <div className="space-y-2">
                      <Label>{pinEnabled ? "Or authorize in a browser window" : "Step 1: Authorize Simkl"}</Label>
                      <Button onClick={handleConnect} className="w-full" disabled={!simklClientId}>
                        <ExternalLink className="mr-2 h-4 w-4" />
                        Authorize with Simkl
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        Opens a new window. You'll receive a Token ID to paste below.
                      </p>
                    </div>
                  )}

                  {!simklClientId && (
                    <p className="text-xs text-red-500">
                      Instance owner has not yet set up the Simkl integration.
                    </p>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="simkl-token">
                      {oauthEnabled ? "Step 2: Paste Token ID" : "Already have a Token ID?"}
                    </Label>
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
                  <div className="flex flex-wrap items-center justify-between gap-3 p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 shrink-0" />
                      <div className="min-w-0">
                        <p className="font-medium text-green-900 dark:text-green-100">Connected to Simkl</p>
                        {loadingUsername ? (
                          <div className="flex items-center gap-2 mt-1">
                            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                            <p className="text-xs text-muted-foreground">Loading...</p>
                          </div>
                        ) : username ? (
                          <p className="text-xs text-muted-foreground truncate">@{username}</p>
                        ) : null}
                        {authVersion === 'v2' && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {!quota
                              ? 'Your daily Simkl allowance shows here after the next Simkl request'
                              : quota.pausedUntil && quota.pausedUntil > Date.now()
                                ? `Daily Simkl allowance used up, resets in ${formatResetIn(quota.pausedUntil)}`
                                : `${quota.remaining.toLocaleString()} of ${quota.limit.toLocaleString()} Simkl requests left today, resets in ${formatResetIn(quota.resetsAt)}`}
                          </p>
                        )}
                        {authVersion === 'v2' && (
                          <a
                            href="https://simkl.com/settings/connected-apps/"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-1"
                          >
                            Usage by app <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                    </div>
                    <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={disconnecting} className="shrink-0">
                      {disconnecting ? 'Disconnecting...' : 'Disconnect'}
                    </Button>
                  </div>

                  {authVersion === 'v2' && (
                    <div className="space-y-2 p-3 rounded-lg border border-border">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="simkl-sync-interval">Check Simkl for changes every (minutes)</Label>
                        {config.simklSyncInterval !== undefined && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-auto py-0.5 px-2 text-xs"
                            onClick={() => setConfig(prev => ({ ...prev, simklSyncInterval: undefined }))}
                          >
                            Use server default
                          </Button>
                        )}
                      </div>
                      <Input
                        id="simkl-sync-interval"
                        type="number"
                        min={1}
                        max={1440}
                        step={1}
                        placeholder={String(serverSyncMinutes)}
                        value={config.simklSyncInterval ?? ''}
                        onChange={(e) => {
                          const parsed = parseInt(e.target.value, 10);
                          setConfig(prev => ({ ...prev, simklSyncInterval: Number.isNaN(parsed) ? undefined : Math.min(Math.max(parsed, 1), 1440) }));
                        }}
                      />
                      <p className="text-xs text-muted-foreground">
                        {config.simklSyncInterval === undefined ? `Following the server default of ${serverSyncMinutes} minutes. ` : ''}
                        How quickly watchlist, Up Next and watched changes made on Simkl show up here. Each check uses one request from your daily Simkl allowance, and only happens while your catalogs are being browsed.
                      </p>
                    </div>
                  )}

                  {authVersion === 'v1' && simklV2Available && (
                    <p className="text-xs text-muted-foreground p-3 rounded-lg border border-border bg-muted/30">
                      This connection uses the older Simkl sign-in. Disconnect and connect again to switch to the new one, which gives you your own daily allowance and unlocks custom lists.
                    </p>
                  )}

                  {/* Simkl User Stats Card */}
                  {isConnected && username && (
                    <Card className="mb-4 bg-gradient-to-br from-sky-500/10 via-card/80 to-card/80 border-sky-400/20">
                      <CardHeader className="cursor-pointer" onClick={() => setStatsCollapsed(!statsCollapsed)}>
                        <div className="flex items-center justify-between gap-4">
                          <div className="flex items-start gap-4 flex-1">
                            <div className="shrink-0 h-10 w-10 rounded-lg bg-sky-500/15 text-sky-300 flex items-center justify-center ring-1 ring-sky-400/20">
                              <BarChart3 className="h-5 w-5" />
                            </div>
                            <div className="space-y-1.5">
                              <CardTitle>Simkl Stats</CardTitle>
                              <CardDescription>Overview of your Simkl activity</CardDescription>
                            </div>
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

                  

                  <Card className="bg-gradient-to-br from-violet-500/10 via-card/80 to-card/80 border-violet-400/20">
                    <CardHeader className="flex-row items-start gap-3 sm:gap-4 space-y-0 p-4 sm:p-6">
                      <div className="shrink-0 h-10 w-10 rounded-lg bg-violet-500/15 text-violet-300 flex items-center justify-center ring-1 ring-violet-400/20">
                        <Bookmark className="h-5 w-5" />
                      </div>
                      <div className="flex-1 min-w-0 space-y-1.5">
                        <CardTitle>Watchlist Catalogs</CardTitle>
                        <CardDescription>Add watchlist catalogs for movies, shows, and anime by status</CardDescription>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="space-y-3">
                        <div>
                          <p className="text-sm font-medium mb-2">All types</p>
                          <div className="grid grid-cols-2 gap-2">
                            <Button 
                              onClick={() => handleAddWatchlistCatalog('all', 'plantowatch')}
                              variant="outline" 
                              size="sm"
                              disabled={!isConnected || config.catalogs.some(c => c.id === 'simkl.watchlist.all.plantowatch')}
                            >
                              <Plus className="mr-2 h-3 w-3" />
                              Plan to Watch
                            </Button>
                          </div>
                        </div>
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

                  <Card className="bg-gradient-to-br from-violet-500/10 via-card/80 to-card/80 border-violet-400/20">
                    <CardHeader className="flex-row items-start gap-3 sm:gap-4 space-y-0 p-4 sm:p-6">
                      <div className="shrink-0 h-10 w-10 rounded-lg bg-violet-500/15 text-violet-300 flex items-center justify-center ring-1 ring-violet-400/20">
                        <Download className="h-5 w-5" />
                      </div>
                      <div className="flex-1 min-w-0 space-y-1.5">
                        <CardTitle>Custom Lists</CardTitle>
                        <CardDescription>Import the lists you made on Simkl, or add anyone's list by its link or id. Needs a Simkl PRO or VIP account.</CardDescription>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="simkl-list-link">Add a list by link or ID</Label>
                        <div className="flex gap-2">
                          <Input
                            id="simkl-list-link"
                            value={listLink}
                            onChange={(event) => setListLink(event.target.value)}
                            onKeyDown={(event) => { if (event.key === 'Enter' && listLink.trim() && !isAddingList) void addListByLink(); }}
                            placeholder="https://simkl.com/lists/137494"
                            disabled={!isConnected}
                          />
                          <Button onClick={addListByLink} disabled={!isConnected || isAddingList || !listLink.trim()}>
                            {isAddingList ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add'}
                          </Button>
                        </div>
                      </div>
                      <Button
                        onClick={fetchCustomLists}
                        disabled={isLoadingCustomLists || !isConnected}
                        variant="outline"
                        className="w-full"
                      >
                        {isLoadingCustomLists ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Loading...
                          </>
                        ) : (
                          "Load My Custom Lists"
                        )}
                      </Button>

                      {customLists.length > 0 && (
                        <div className="space-y-3">
                          <div className="flex items-center space-x-3 p-3 border rounded-lg bg-muted/30">
                            <Switch
                              id="select-all-simkl-lists"
                              checked={selectedCustomLists.size === customLists.length}
                              onCheckedChange={(checked) => {
                                setSelectedCustomLists(checked ? new Set(customLists.map(l => l.id)) : new Set());
                              }}
                            />
                            <Label htmlFor="select-all-simkl-lists" className="font-medium cursor-pointer">
                              Select all my custom lists
                            </Label>
                            <Badge variant="outline" className="ml-auto">
                              {selectedCustomLists.size}/{customLists.length}
                            </Badge>
                          </div>

                          <div className="grid grid-cols-1 gap-3 max-h-80 overflow-y-auto border rounded-lg p-3 bg-muted/20">
                            {customLists.map((list) => (
                              <div key={list.id} className="flex items-start space-x-3 p-3 border rounded-lg">
                                <Switch
                                  id={`simkl-list-${list.id}`}
                                  checked={selectedCustomLists.has(list.id)}
                                  onCheckedChange={(checked) => handleCustomListSelection(list.id, checked)}
                                />
                                <div className="flex-1 min-w-0">
                                  <Label htmlFor={`simkl-list-${list.id}`} className="font-medium cursor-pointer break-words">
                                    {list.name}
                                  </Label>
                                  <div className="flex flex-wrap items-center gap-2 mt-1">
                                    <Badge variant="outline" className="text-xs capitalize">
                                      {list.mediaType === 'tv' ? 'shows' : list.mediaType}
                                    </Badge>
                                    <Badge variant="secondary" className="text-xs capitalize">
                                      {list.privacy}
                                    </Badge>
                                    {list.itemCount > 0 && (
                                      <Badge variant="secondary" className="text-xs">
                                        {list.itemCount} items
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

                          {selectedCustomLists.size > 0 && (
                            <Button onClick={importSelectedCustomLists} className="w-full">
                              Import {selectedCustomLists.size} Selected List{selectedCustomLists.size !== 1 ? 's' : ''}
                            </Button>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card className="bg-gradient-to-br from-violet-500/10 via-card/80 to-card/80 border-violet-400/20">
                    <CardHeader className="flex-row items-start gap-3 sm:gap-4 space-y-0 p-4 sm:p-6">
                      <div className="shrink-0 h-10 w-10 rounded-lg bg-violet-500/15 text-violet-300 flex items-center justify-center ring-1 ring-violet-400/20">
                        <PlayCircle className="h-5 w-5" />
                      </div>
                      <div className="flex-1 min-w-0 space-y-1.5">
                        <CardTitle>Up Next</CardTitle>
                        <CardDescription>The next episode to watch for every show you have in progress</CardDescription>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <Button
                          onClick={handleAddUpNext}
                          variant="outline"
                          disabled={!isConnected || config.catalogs.some(c => c.id === 'simkl.upnext')}
                        >
                          <Plus className="mr-2 h-4 w-4" />
                          Add Up Next
                        </Button>
                        <Button
                          onClick={handleAddAnimeUpNext}
                          variant="outline"
                          disabled={!isConnected || config.catalogs.some(c => c.id === 'simkl.upnext.anime')}
                        >
                          <Plus className="mr-2 h-4 w-4" />
                          Add Anime Up Next
                        </Button>
                      </div>
                      {config.catalogs.some(c => c.id === 'simkl.upnext') && (
                        <div className="space-y-2 border-t pt-4">
                          <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                            <span className="font-medium">Simkl Up Next</span>
                            <Button variant="ghost" size="sm" onClick={handleRemoveUpNext}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                          <div className="flex items-center justify-between p-3 border rounded-lg">
                            <div className="space-y-0.5">
                              <label className="text-sm font-medium">Use Show Poster</label>
                              <p className="text-xs text-muted-foreground">Display show poster instead of episode thumbnail</p>
                            </div>
                            <Switch
                              checked={config.catalogs.find(c => c.id === 'simkl.upnext')?.metadata?.useShowPosterForUpNext || false}
                              onCheckedChange={(checked) => {
                                setConfig(prev => ({
                                  ...prev,
                                  catalogs: prev.catalogs.map(c =>
                                    c.id === 'simkl.upnext'
                                      ? { ...c, metadata: { ...c.metadata, useShowPosterForUpNext: checked } }
                                      : c
                                  )
                                }));
                              }}
                            />
                          </div>
                          <div className="flex items-center justify-between p-3 border rounded-lg">
                            <div className="space-y-0.5">
                              <label className="text-sm font-medium">Include Anime</label>
                              <p className="text-xs text-muted-foreground">
                                {config.catalogs.some(c => c.id === 'simkl.upnext.anime')
                                  ? 'Anime has its own row below, so leave this off to avoid listing it twice'
                                  : 'Mix anime you are watching into the same row'}
                              </p>
                            </div>
                            <Switch
                              checked={config.catalogs.find(c => c.id === 'simkl.upnext')?.metadata?.includeAnimeInUpNext !== false}
                              onCheckedChange={(checked) => {
                                setConfig(prev => ({
                                  ...prev,
                                  catalogs: prev.catalogs.map(c =>
                                    c.id === 'simkl.upnext'
                                      ? { ...c, metadata: { ...c.metadata, includeAnimeInUpNext: checked } }
                                      : c
                                  )
                                }));
                              }}
                            />
                          </div>
                        </div>
                      )}
                      {config.catalogs.some(c => c.id === 'simkl.upnext.anime') && (
                        <div className="space-y-2 border-t pt-4">
                          <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                            <span className="font-medium">Simkl Anime Up Next</span>
                            <Button variant="ghost" size="sm" onClick={handleRemoveAnimeUpNext}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                          <div className="flex items-center justify-between p-3 border rounded-lg">
                            <div className="space-y-0.5">
                              <label className="text-sm font-medium">Use Show Poster</label>
                              <p className="text-xs text-muted-foreground">Display show poster instead of episode thumbnail</p>
                            </div>
                            <Switch
                              checked={config.catalogs.find(c => c.id === 'simkl.upnext.anime')?.metadata?.useShowPosterForUpNext || false}
                              onCheckedChange={(checked) => {
                                setConfig(prev => ({
                                  ...prev,
                                  catalogs: prev.catalogs.map(c =>
                                    c.id === 'simkl.upnext.anime'
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
                        Anime follows your anime metadata provider, so the episode lands on the same page the rest of the addon would open.
                      </p>
                    </CardContent>
                  </Card>
                </div>
              )}
              {}
              <Card className="bg-gradient-to-br from-amber-500/10 via-card/80 to-card/80 border-amber-400/20">
                <CardHeader className="flex-row items-start gap-3 sm:gap-4 space-y-0 p-4 sm:p-6">
                  <div className="shrink-0 h-10 w-10 rounded-lg bg-amber-500/15 text-amber-300 flex items-center justify-center ring-1 ring-amber-400/20">
                    <TrendingUp className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <CardTitle>Trending & Calendar</CardTitle>
                    <CardDescription>Add trending catalogs or view upcoming releases</CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <Button
                      onClick={() => handleAddTrendingCatalog('movies')}
                      variant="outline"
                      disabled={config.catalogs.some(c => c.id === 'simkl.trending.movies')}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Trending Movies
                    </Button>
                    <Button
                      onClick={() => handleAddTrendingCatalog('shows')}
                      variant="outline"
                      disabled={config.catalogs.some(c => c.id === 'simkl.trending.shows')}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Trending Shows
                    </Button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <Button
                      onClick={() => handleAddTrendingCatalog('anime')}
                      variant="outline"
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
                      disabled={config.catalogs.some(c => c.id === 'simkl.calendar.series')}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Airing Soon (Series)
                    </Button>
                  </div>
                  <div>
                    <Button
                      onClick={handleAddDvdReleasesCatalog}
                      variant="outline"
                      className="w-full"
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
              <Card className="bg-gradient-to-br from-violet-500/10 via-card/80 to-card/80 border-violet-400/20">
                <CardHeader className="flex-row items-start gap-3 sm:gap-4 space-y-0 p-4 sm:p-6">
                  <div className="shrink-0 h-10 w-10 rounded-lg bg-violet-500/15 text-violet-300 flex items-center justify-center ring-1 ring-violet-400/20">
                    <Sparkles className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <CardTitle>Curated Picks</CardTitle>
                    <CardDescription>Hidden Gems — highly rated titles that are flying under the radar</CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Hidden Gems — highly rated, under the radar</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <Button
                        onClick={() => handleAddRecipeCatalog('hiddengems', 'movies', 'Hidden Gems (Movies)')}
                        variant="outline"
                        disabled={config.catalogs.some(c => c.id === 'simkl.recipe.hiddengems.movies')}
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Movies
                      </Button>
                      <Button
                        onClick={() => handleAddRecipeCatalog('hiddengems', 'shows', 'Hidden Gems (Shows)')}
                        variant="outline"
                        disabled={config.catalogs.some(c => c.id === 'simkl.recipe.hiddengems.shows')}
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Shows
                      </Button>
                      <Button
                        onClick={() => handleAddRecipeCatalog('hiddengems', 'anime', 'Hidden Gems (Anime)')}
                        variant="outline"
                        disabled={config.catalogs.some(c => c.id === 'simkl.recipe.hiddengems.anime')}
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Anime
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Binge-Worthy — finished series, low drop-off</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <Button
                        onClick={() => handleAddRecipeCatalog('marathon', 'shows', 'Binge-Worthy (Shows)')}
                        variant="outline"
                        disabled={config.catalogs.some(c => c.id === 'simkl.recipe.marathon.shows')}
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Shows
                      </Button>
                      <Button
                        onClick={() => handleAddRecipeCatalog('marathon', 'anime', 'Binge-Worthy (Anime)')}
                        variant="outline"
                        disabled={config.catalogs.some(c => c.id === 'simkl.recipe.marathon.anime')}
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Anime
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">More picks — movies only</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <Button
                        onClick={() => handleAddRecipeCatalog('quick', 'movies', 'Quick Watches')}
                        variant="outline"
                        disabled={config.catalogs.some(c => c.id === 'simkl.recipe.quick.movies')}
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Quick Watches (under 100 min)
                      </Button>
                      <Button
                        onClick={() => handleAddRecipeCatalog('boxoffice', 'movies', 'Box Office Hits')}
                        variant="outline"
                        disabled={config.catalogs.some(c => c.id === 'simkl.recipe.boxoffice.movies')}
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Box Office Hits
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Computed from the trending pool — no extra API calls. Defaults to this week.
                  </p>
                </CardContent>
              </Card>
            </CardContent>
          </Card>
        </div>

        <DialogFooter>
          <Button onClick={onClose} variant="outline" className="w-full sm:w-auto">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
