// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useState, useEffect } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { CatalogConfig } from '@/contexts/config';
import { isMovieLensExploreId } from '@/lib/movielensCatalogIds';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ExternalLink, CheckCircle2, Loader2, Plus, RefreshCw, Sparkles, Bookmark, CalendarClock, Star, ListVideo, Award, History } from 'lucide-react';
import { toast } from "sonner";

interface MovieLensIntegrationProps {
  isOpen: boolean;
  onClose: () => void;
}

export function MovieLensIntegration({ isOpen, onClose }: MovieLensIntegrationProps) {
  const { config, setConfig, auth } = useConfig();
  const [isConnected, setIsConnected] = useState(!!config.apiKeys?.movieLensCredId);
  const [username, setUsername] = useState<string | null>(null);
  const [userNameInput, setUserNameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lists, setLists] = useState<any[] | null>(null);
  const [loadingLists, setLoadingLists] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const credId = config.apiKeys?.movieLensCredId;
    setIsConnected(!!credId);
    if (credId && !username) {
      fetch("/api/oauth/token/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenId: credId }),
      })
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data?.provider === 'movielens') setUsername(data.username);
        })
        .catch(() => {});
    }
  }, [isOpen, config.apiKeys?.movieLensCredId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleConnect = async () => {
    if (!userNameInput.trim() || !passwordInput) {
      toast.error("Please enter your MovieLens username and password");
      return;
    }
    setConnecting(true);
    try {
      const res = await fetch("/api/auth/movielens/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userName: userNameInput.trim(), password: passwordInput }),
      });
      const data = await res.json();
      if (res.ok && data.credId) {
        setConfig(prev => ({
          ...prev,
          apiKeys: { ...prev.apiKeys, movieLensCredId: data.credId },
        }));
        setIsConnected(true);
        setUsername(data.userName);
        setPasswordInput('');
        toast.success(`Connected as ${data.userName}. Save your config, then run "Import ratings".`);
      } else {
        toast.error(data.error || "Could not connect to MovieLens");
      }
    } catch {
      toast.error("Could not reach the server");
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = () => {
    setConfig(prev => {
      const apiKeys = { ...prev.apiKeys };
      delete apiKeys.movieLensCredId;
      return { ...prev, apiKeys };
    });
    setIsConnected(false);
    setUsername(null);
    toast.success("MovieLens disconnected. Its catalogs will disappear after you save.");
  };

  const handleSyncNow = async () => {
    if (!auth.authenticated || !auth.userUUID) {
      toast.error("Save your configuration first, then sync");
      return;
    }
    setSyncing(true);
    try {
      const res = await fetch(`/api/movielens/sync/${auth.userUUID}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: auth.password, credId: config.apiKeys?.movieLensCredId }),
      });
      const data = await res.json();
      if (res.ok) {
        const parts = Object.entries(data.perSource || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
        toast.success(
          `MovieLens took ${data.successCount || 0} new ratings and had ${data.alreadyRatedCount || 0} already`,
          parts ? { description: `Sent from ${parts}` } : undefined
        );
      } else if (res.status === 429) {
        const mins = Math.ceil((data.nextAllowedInSeconds || 0) / 60);
        toast.info(`Synced recently, try again in about ${mins} min`);
      } else if (res.status === 400 && (data.error || '').includes('No MovieLens account')) {
        toast.error("Save your configuration first. The server only sees your MovieLens connection after you save.");
      } else {
        toast.error(data.error || "Sync failed");
      }
    } catch {
      toast.error("Could not reach the server");
    } finally {
      setSyncing(false);
    }
  };

  const handleLoadLists = async () => {
    if (!auth.authenticated || !auth.userUUID) {
      toast.error("Save your configuration first, then load your lists");
      return;
    }
    setLoadingLists(true);
    try {
      const res = await fetch(`/api/movielens/lists/${auth.userUUID}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: auth.password }),
      });
      const data = await res.json();
      if (res.ok) {
        setLists(data.lists || []);
        if (!data.lists?.length) toast.info("No lists found on your MovieLens account");
      } else {
        toast.error(data.error || "Could not load lists");
      }
    } catch {
      toast.error("Could not reach the server");
    } finally {
      setLoadingLists(false);
    }
  };

  const addCatalog = (id: string, name: string, metadata?: Record<string, unknown>) => {
    const isExplore = isMovieLensExploreId(id);
    const taken = config.catalogs.some(c => c.id === id);
    if (!isExplore && taken) {
      toast.info(`${name} is already added.`);
      return;
    }
    // Explore presets may be added repeatedly; only later copies need a suffix.
    const uniqueId = isExplore && taken ? `${id}.${Date.now().toString(36)}` : id;
    const newCatalog: CatalogConfig = {
      id: uniqueId,
      type: 'movie',
      name,
      enabled: true,
      showInHome: true,
      source: 'movielens' as any,
      ...(metadata && { metadata }),
    } as CatalogConfig;
    setConfig(prev => ({ ...prev, catalogs: [...prev.catalogs, newCatalog] }));
    toast.success(`Added ${name}`);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <img src="https://movielens.org/favicon.ico" alt="MovieLens" className="h-5 w-5 rounded" />
            MovieLens Integration
          </DialogTitle>
          <DialogDescription>
            Personalized movie recommendations powered by your ratings.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!isConnected ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Connect your account</CardTitle>
                <CardDescription>
                  No account yet?{' '}
                  <a href="https://movielens.org/register" target="_blank" rel="noopener noreferrer" className="underline inline-flex items-center gap-1">
                    Create one at movielens.org <ExternalLink className="h-3 w-3" />
                  </a>
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="ml-username">Username or email</Label>
                    <Input id="ml-username" value={userNameInput} onChange={e => setUserNameInput(e.target.value)} autoComplete="off" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="ml-password">Password</Label>
                    <Input id="ml-password" type="password" value={passwordInput} onChange={e => setPasswordInput(e.target.value)} autoComplete="new-password" />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  MovieLens has no app authorization, so this server stores your password (encrypted)
                  to keep the session alive. Please use a unique password for MovieLens.
                </p>
                <Button onClick={handleConnect} disabled={connecting} className="w-full sm:w-auto">
                  {connecting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Connect
                </Button>
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardContent className="pt-4 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-green-500" />
                    <span className="text-sm">Connected{username ? ` as ${username}` : ''}</span>
                  </div>
                  <Button variant="outline" size="sm" onClick={handleDisconnect}>Disconnect</Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Import your ratings</CardTitle>
                  <CardDescription>
                    Pulls your movie ratings from connected Trakt, Simkl and MDBList accounts into
                    MovieLens so recommendations reflect your taste. Re-syncs run automatically.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button onClick={handleSyncNow} disabled={syncing} variant="secondary" className="w-full sm:w-auto">
                    {syncing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                    Import ratings now
                  </Button>
                  {!auth.authenticated && (
                    <p className="text-xs text-muted-foreground mt-2">Save your configuration first to enable importing.</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-2">
                    Remember to save your configuration so MovieLens catalogs appear in the addon.
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Add catalogs</CardTitle>
                  <CardDescription>Sort and year filters live in each catalog's gear settings.</CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Button variant="outline" className="justify-start" onClick={() => addCatalog('movielens.explore.toppicks', 'MovieLens Top Picks')}>
                    <Sparkles className="h-4 w-4 mr-2" /> Top Picks for You <Plus className="h-4 w-4 ml-auto" />
                  </Button>
                  <Button variant="outline" className="justify-start" onClick={() => addCatalog('movielens.watchlist', 'MovieLens Watchlist')}>
                    <Bookmark className="h-4 w-4 mr-2" /> Your Watchlist <Plus className="h-4 w-4 ml-auto" />
                  </Button>
                  <Button variant="outline" className="justify-start" onClick={() => addCatalog('movielens.explore.toppicks.recent', 'New Releases for You', { maxDaysAgo: 180 })}>
                    <CalendarClock className="h-4 w-4 mr-2" /> New Releases for You <Plus className="h-4 w-4 ml-auto" />
                  </Button>
                  <Button variant="outline" className="justify-start" onClick={() => addCatalog('movielens.explore.highestrated', 'Highest Rated by Users', { sortBy: 'avgRating' })}>
                    <Star className="h-4 w-4 mr-2" /> Highest Rated by Users <Plus className="h-4 w-4 ml-auto" />
                  </Button>
                  <Button variant="outline" className="justify-start" onClick={() => addCatalog('movielens.explore.myrated.score', 'Your Rated Collection', { sortBy: 'userRating', includeRated: true })}>
                    <Award className="h-4 w-4 mr-2" /> Your Rated Collection <Plus className="h-4 w-4 ml-auto" />
                  </Button>
                  <Button variant="outline" className="justify-start" onClick={() => addCatalog('movielens.explore.myrated.date', 'Your Rated Collection by Date', { sortBy: 'userRatedDate', includeRated: true })}>
                    <History className="h-4 w-4 mr-2" /> Your Rated Collection by Date <Plus className="h-4 w-4 ml-auto" />
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Your Lists</CardTitle>
                  <CardDescription>Custom lists you've created on MovieLens.</CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Button variant="secondary" className="sm:col-span-2 sm:justify-self-start" onClick={handleLoadLists} disabled={loadingLists}>
                    {loadingLists ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                    {lists === null ? 'Load my lists' : 'Refresh lists'}
                  </Button>
                  {lists?.map(list => (
                    <Button
                      key={list.listId}
                      variant="outline"
                      className="justify-start"
                      onClick={() => addCatalog(`movielens.list.${list.listId}`, list.title, { listUserId: list.userId })}
                    >
                      <ListVideo className="h-4 w-4 mr-2" /> {list.title} <Plus className="h-4 w-4 ml-auto" />
                    </Button>
                  ))}
                  {lists?.length === 0 && (
                    <p className="text-xs text-muted-foreground sm:col-span-2">No lists on your MovieLens account yet.</p>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
