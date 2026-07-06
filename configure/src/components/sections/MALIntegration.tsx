import { useState, useEffect } from 'react';
import { useConfig, CatalogConfig } from '@/contexts/ConfigContext';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ExternalLink, CheckCircle2, XCircle, Loader2, Link2, KeyRound, Sparkles, PlayCircle, List, Plus, Trash2 } from 'lucide-react';
import { toast } from "sonner";

const MAL_LIST_CATALOGS = [
  { id: 'mal.userlist.watching', label: 'Watching' },
  { id: 'mal.userlist.completed', label: 'Completed' },
  { id: 'mal.userlist.plan_to_watch', label: 'Plan to Watch' },
  { id: 'mal.userlist.on_hold', label: 'On Hold' },
  { id: 'mal.userlist.dropped', label: 'Dropped' },
  { id: 'mal.suggestions', label: 'Suggestions' },
] as const;

interface MALIntegrationProps {
  isOpen: boolean;
  onClose: () => void;
}

export function MALIntegration({ isOpen, onClose }: MALIntegrationProps) {
  const { config, setConfig, auth } = useConfig();
  const [tempTokenId, setTempTokenId] = useState(config.apiKeys?.malTokenId || "");
  const [isConnected, setIsConnected] = useState(!!config.apiKeys?.malTokenId);
  const [disconnecting, setDisconnecting] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [loadingUsername, setLoadingUsername] = useState(false);

  const authUrl = "/mal/auth";

  useEffect(() => {
    if (isOpen) {
      setIsConnected(!!config.apiKeys?.malTokenId);
      setTempTokenId(config.apiKeys?.malTokenId || "");

      if (config.apiKeys?.malTokenId) {
        setLoadingUsername(true);
        fetch("/api/oauth/token/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tokenId: config.apiKeys.malTokenId }),
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
  }, [isOpen, config.apiKeys?.malTokenId]);

  const handleConnect = () => {
    window.open(authUrl, "_blank", "width=600,height=700");
    toast.info("Complete the authorization in the new window and paste the Token ID below");
  };

  const handleSave = async () => {
    if (!tempTokenId.trim()) {
      toast.error("Please enter a valid Token ID");
      return;
    }

    try {
      const response = await fetch("/api/oauth/token/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenId: tempTokenId.trim() }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.provider === 'mal') {
          setUsername(data.username);

          setConfig(prev => ({
            ...prev,
            malWatchTracking: true,
            apiKeys: {
              ...prev.apiKeys,
              malTokenId: tempTokenId.trim(),
            },
          }));

          setIsConnected(true);
          toast.success(`Connected as @${data.username}`);
        } else {
          toast.error("Invalid MyAnimeList token");
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
      // For guests/imported configs without authenticated user context,
      // clear local MAL linkage without hitting the backend.
      if (!auth.userUUID) {
        setConfig(prev => ({
          ...prev,
          malWatchTracking: false,
          apiKeys: {
            ...prev.apiKeys,
            malTokenId: undefined,
          },
        }));
        setTempTokenId("");
        setIsConnected(false);
        setUsername(null);
        toast.success("MyAnimeList account disconnected");
        return;
      }

      const response = await fetch("/mal/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userUUID: auth.userUUID
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to disconnect");
      }

      setTempTokenId("");
      setIsConnected(false);
      setUsername(null);

      setConfig(prev => ({
        ...prev,
        malWatchTracking: false,
        apiKeys: {
          ...prev.apiKeys,
          malTokenId: undefined,
        },
      }));

      toast.success("MyAnimeList account disconnected");
    } catch (error: any) {
      console.error("Disconnect error:", error);
      toast.error(error.message || "Failed to disconnect MyAnimeList");
    } finally {
      setDisconnecting(false);
    }
  };

  const handleTrackingChange = (checked: boolean) => {
    setConfig(prev => ({ ...prev, malWatchTracking: checked }));
  };

  const isListCatalogAdded = (catalogId: string) =>
    config.catalogs.some(c => c.id === catalogId);

  const toggleListCatalog = (catalogId: string, label: string) => {
    if (isListCatalogAdded(catalogId)) {
      setConfig(prev => ({
        ...prev,
        catalogs: prev.catalogs.filter(c => c.id !== catalogId),
      }));
      toast.success(`Removed MAL ${label} catalog`);
    } else {
      const newCatalog: CatalogConfig = {
        id: catalogId,
        type: 'anime',
        name: `MAL ${label}`,
        enabled: true,
        showInHome: true,
        source: 'mal',
      };
      setConfig(prev => ({
        ...prev,
        catalogs: [...prev.catalogs, newCatalog],
      }));
      toast.success(`Added MAL ${label} catalog`);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <img
              src="/mal_icon.png"
              alt="MyAnimeList"
              className="w-6 h-6 rounded"
            />
            MyAnimeList Integration
          </DialogTitle>
          <DialogDescription>
            Connect your MyAnimeList account to automatically sync your anime watch progress.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Connection Status */}
          <Card className="bg-gradient-to-br from-indigo-500/10 via-card/80 to-card/80 border-indigo-400/20">
            <CardHeader className="flex-row items-start gap-3 sm:gap-4 space-y-0 p-4 sm:p-6">
              <div className="shrink-0 h-10 w-10 rounded-lg bg-indigo-500/15 text-indigo-300 flex items-center justify-center ring-1 ring-indigo-400/20">
                <Link2 className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0 space-y-1.5">
                <CardTitle>Connection Status</CardTitle>
                <CardDescription>Link your MyAnimeList account to sync watch progress.</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {isConnected ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-green-600">
                    <CheckCircle2 className="h-5 w-5" />
                    <span className="font-medium">Connected</span>
                    {loadingUsername ? (
                      <Loader2 className="h-4 w-4 animate-spin ml-2" />
                    ) : username && (
                      <span className="text-muted-foreground">as @{username}</span>
                    )}
                  </div>
                  <Button
                    variant="destructive"
                    onClick={handleDisconnect}
                    disabled={disconnecting}
                  >
                    {disconnecting ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Disconnecting...
                      </>
                    ) : (
                      "Disconnect MyAnimeList"
                    )}
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <XCircle className="h-5 w-5" />
                    <span>Not connected</span>
                  </div>
                  <div className="space-y-3">
                    <Button onClick={handleConnect} className="w-full sm:w-auto">
                      <ExternalLink className="h-4 w-4 mr-2" />
                      Connect with MyAnimeList
                    </Button>
                    <p className="text-sm text-muted-foreground">
                      After authorizing, copy the Token ID from the success page and paste it below.
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Token Input */}
          {!isConnected && (
            <Card className="bg-gradient-to-br from-indigo-500/10 via-card/80 to-card/80 border-indigo-400/20">
              <CardHeader className="flex-row items-start gap-3 sm:gap-4 space-y-0 p-4 sm:p-6">
                <div className="shrink-0 h-10 w-10 rounded-lg bg-indigo-500/15 text-indigo-300 flex items-center justify-center ring-1 ring-indigo-400/20">
                  <KeyRound className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0 space-y-1.5">
                  <CardTitle>Enter Token ID</CardTitle>
                  <CardDescription>
                    Paste the Token ID you received after authorizing with MyAnimeList.
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-col sm:flex-row gap-2">
                  <Input
                    placeholder="Paste your Token ID here"
                    value={tempTokenId}
                    onChange={(e) => setTempTokenId(e.target.value)}
                    className="min-w-0"
                  />
                  <Button onClick={handleSave} disabled={!tempTokenId.trim()} className="w-full sm:w-auto shrink-0">
                    Save
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Watch Tracking Toggle */}
          {isConnected && (
            <Card className="bg-gradient-to-br from-indigo-500/10 via-card/80 to-card/80 border-indigo-400/20">
              <CardHeader className="flex-row items-start gap-3 sm:gap-4 space-y-0 p-4 sm:p-6">
                <div className="shrink-0 h-10 w-10 rounded-lg bg-indigo-500/15 text-indigo-300 flex items-center justify-center ring-1 ring-indigo-400/20">
                  <PlayCircle className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0 space-y-1.5">
                  <CardTitle>Watch Tracking</CardTitle>
                  <CardDescription>Update your MAL list as you watch anime in Stremio.</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between p-3 rounded-lg hover:bg-accent/50 transition-colors">
                  <div className="mr-4">
                    <Label htmlFor="mal-watch-tracking" className="font-medium">MAL Tracking</Label>
                    <p className="text-sm text-muted-foreground">Sync anime watch progress to MyAnimeList.</p>
                  </div>
                  <Switch id="mal-watch-tracking" checked={!!config.malWatchTracking} onCheckedChange={handleTrackingChange} />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Anime List Catalogs */}
          {isConnected && (
            <Card className="bg-gradient-to-br from-indigo-500/10 via-card/80 to-card/80 border-indigo-400/20">
              <CardHeader className="flex-row items-start gap-3 sm:gap-4 space-y-0 p-4 sm:p-6">
                <div className="shrink-0 h-10 w-10 rounded-lg bg-indigo-500/15 text-indigo-300 flex items-center justify-center ring-1 ring-indigo-400/20">
                  <List className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0 space-y-1.5">
                  <CardTitle>My Anime Lists</CardTitle>
                  <CardDescription>Add your MAL lists (sorted by last updated) and personalized suggestions as browsable catalogs.</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {MAL_LIST_CATALOGS.map(({ id, label }) => {
                    const added = isListCatalogAdded(id);
                    return (
                      <div key={id} className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-medium truncate">{label}</span>
                          {added && (
                            <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                          )}
                        </div>
                        <Button
                          variant={added ? "destructive" : "outline"}
                          size="sm"
                          onClick={() => toggleListCatalog(id, label)}
                          className="shrink-0"
                        >
                          {added ? (
                            <>
                              <Trash2 className="h-4 w-4 mr-1" />
                              Remove
                            </>
                          ) : (
                            <>
                              <Plus className="h-4 w-4 mr-1" />
                              Add Catalog
                            </>
                          )}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Features Info */}
          <Card className="bg-gradient-to-br from-indigo-500/10 via-card/80 to-card/80 border-indigo-400/20">
            <CardHeader className="flex-row items-start gap-3 sm:gap-4 space-y-0 p-4 sm:p-6">
              <div className="shrink-0 h-10 w-10 rounded-lg bg-indigo-500/15 text-indigo-300 flex items-center justify-center ring-1 ring-indigo-400/20">
                <Sparkles className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0 space-y-1.5">
                <CardTitle>Features</CardTitle>
                <CardDescription>What gets enabled once you're connected.</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 mt-0.5 text-green-500 shrink-0" />
                  <span>Automatically track anime episodes you watch</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 mt-0.5 text-green-500 shrink-0" />
                  <span>Progress syncs to your MyAnimeList profile</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 mt-0.5 text-green-500 shrink-0" />
                  <span>Anime status automatically updates (Watching → Completed)</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 mt-0.5 text-green-500 shrink-0" />
                  <span>Anime not on your list yet are added automatically</span>
                </li>
              </ul>
            </CardContent>
          </Card>
        </div>
      </DialogContent>
    </Dialog>
  );
}
