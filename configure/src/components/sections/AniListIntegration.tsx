import { useState, useEffect, useCallback } from 'react';
import { useConfig, CatalogConfig } from '@/contexts/ConfigContext';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ExternalLink, CheckCircle2, XCircle, Loader2, List, Download } from 'lucide-react';
import { toast } from "sonner";

// Interface for AniList list data
interface AniListList {
  name: string;
  isCustomList: boolean;
  entryCount: number;
}

interface AniListIntegrationProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AniListIntegration({ isOpen, onClose }: AniListIntegrationProps) {
  const { config, setConfig, auth } = useConfig();
  const [tempTokenId, setTempTokenId] = useState(config.apiKeys?.anilistTokenId || "");
  const [isConnected, setIsConnected] = useState(!!config.apiKeys?.anilistTokenId);
  const [disconnecting, setDisconnecting] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [loadingUsername, setLoadingUsername] = useState(false);

  const [lists, setLists] = useState<AniListList[]>([]);
  const [selectedLists, setSelectedLists] = useState<Set<string>>(new Set());
  const [isLoadingLists, setIsLoadingLists] = useState(false);
  const [listsLoaded, setListsLoaded] = useState(false);

  // Sorting options for AniList lists
  const ANILIST_SORT_OPTIONS = [
    'ADDED_TIME', 'UPDATED_TIME', 'SCORE', 'STATUS', 'PROGRESS', 'MEDIA_POPULARITY', 'MEDIA_TITLE_ROMAJI', 'MEDIA_TITLE_ENGLISH', 'MEDIA_TITLE_NATIVE', 'STARTED_ON', 'FINISHED_ON', 'MEDIA_ID', 'PRIORITY', 'REPEAT', 'PROGRESS_VOLUMES'
  ] as const;
  const [sort, setSort] = useState<typeof ANILIST_SORT_OPTIONS[number]>('ADDED_TIME');
  const [sortDirection, setSortDirection] = useState<'asc'|'desc'>('desc');

  // Public username list fetching
  const [publicUsername, setPublicUsername] = useState("");
  const [publicLists, setPublicLists] = useState<AniListList[]>([]);
  const [selectedPublicLists, setSelectedPublicLists] = useState<Set<string>>(new Set());
  const [isLoadingPublicLists, setIsLoadingPublicLists] = useState(false);
  const [publicListsLoaded, setPublicListsLoaded] = useState(false);
  const [tokenExpiresAt, setTokenExpiresAt] = useState<number | null>(null);

  const authUrl = "/anilist/auth";

  useEffect(() => {
    if (isOpen) {
      setIsConnected(!!config.apiKeys?.anilistTokenId);
      setTempTokenId(config.apiKeys?.anilistTokenId || "");
      
      if (config.apiKeys?.anilistTokenId) {
        setLoadingUsername(true);
        fetch("/api/oauth/token/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tokenId: config.apiKeys.anilistTokenId }),
        })
          .then(res => res.ok ? res.json() : null)
          .then(data => {
            if (data?.username) setUsername(data.username);
            if (data?.expiresAt) setTokenExpiresAt(data.expiresAt);
          })
          .catch(() => setUsername(null))
          .finally(() => setLoadingUsername(false));
      } else {
        setUsername(null);
      }
    }
  }, [isOpen, config.apiKeys?.anilistTokenId]);

  const fetchAniListLists = useCallback(async () => {
    if (!config.apiKeys?.anilistTokenId) {
      toast.error("Please connect your AniList account first");
      return;
    }

    setIsLoadingLists(true);
    try {
      const response = await fetch("/api/anilist/lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenId: config.apiKeys.anilistTokenId }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to fetch lists (Status: ${response.status})`);
      }

      const data = await response.json();
      
      if (data.success && Array.isArray(data.lists)) {
        setLists(data.lists);
        setListsLoaded(true);
        setSelectedLists(new Set()); // Reset selection when loading new lists
        
        if (data.lists.length === 0) {
          toast.info("No lists found", {
            description: "Your AniList account has no anime lists"
          });
        } else {
          toast.success("Lists loaded", {
            description: `Found ${data.lists.length} list(s) from your AniList account`
          });
        }
      } else {
        throw new Error("Invalid response format from server");
      }
    } catch (error) {
      console.error("Error fetching AniList lists:", error);
      toast.error("Failed to load lists", {
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
      setLists([]);
      setListsLoaded(false);
    } finally {
      setIsLoadingLists(false);
    }
  }, [config.apiKeys?.anilistTokenId]);

  const handleListSelection = useCallback((listName: string, checked: boolean) => {
    setSelectedLists(prev => {
      const newSelection = new Set(prev);
      if (checked) {
        newSelection.add(listName);
      } else {
        newSelection.delete(listName);
      }
      return newSelection;
    });
  }, []);

  // Check if a list is already imported, scoped by optional owner username to avoid false positives across users
  const isListAlreadyImported = useCallback((listName: string, ownerUsername?: string): boolean => {
    const targetUser = ownerUsername?.toLowerCase().trim();
    return config.catalogs.some(c => {
      if (c.source !== 'anilist') return false;

      const metaUser = (c as any).metadata?.username?.toLowerCase?.();
      const metaListName = (c as any).metadata?.listName || c.name || '';

      // Normalize the catalog id without the provider prefix
      const idWithoutPrefix = c.id.startsWith('anilist.') ? c.id.slice('anilist.'.length) : c.id;

      // Match on list name using metadata first, fallback to id patterns
      const matchesList = metaListName === listName || idWithoutPrefix === listName || idWithoutPrefix.endsWith(`.${listName}`);

      // If we have a target user, require username match to consider it already imported
      if (targetUser) {
        return matchesList && metaUser === targetUser;
      }

      return matchesList;
    });
  }, [config.catalogs]);

  const fetchPublicUserLists = useCallback(async () => {
    const trimmedUsername = publicUsername.trim();
    if (!trimmedUsername) {
      toast.error("Please enter a username");
      return;
    }

    setIsLoadingPublicLists(true);
    setPublicListsLoaded(false);
    try {
      const response = await fetch(`/api/anilist/lists/by-username/${encodeURIComponent(trimmedUsername)}`);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to fetch lists (Status: ${response.status})`);
      }

      const data = await response.json();
      
      if (data.success && Array.isArray(data.lists)) {
        setPublicLists(data.lists);
        setPublicListsLoaded(true);
        setSelectedPublicLists(new Set()); // Reset selection when loading new lists
        
        if (data.lists.length === 0) {
          toast.info("No lists found", {
            description: `User ${trimmedUsername} has no public anime lists`
          });
        } else {
          toast.success("Lists loaded", {
            description: `Found ${data.lists.length} list(s) from @${data.username}`
          });
        }
      } else {
        throw new Error("Invalid response format from server");
      }
    } catch (error) {
      console.error("Error fetching public AniList lists:", error);
      toast.error("Failed to load lists", {
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
      setPublicLists([]);
      setPublicListsLoaded(false);
    } finally {
      setIsLoadingPublicLists(false);
    }
  }, [publicUsername]);

  const handlePublicListSelection = useCallback((listName: string, checked: boolean) => {
    setSelectedPublicLists(prev => {
      const newSelection = new Set(prev);
      if (checked) {
        newSelection.add(listName);
      } else {
        newSelection.delete(listName);
      }
      return newSelection;
    });
  }, []);

  const importSelectedLists = useCallback(() => {
    if (selectedLists.size === 0) {
      toast.error("No lists selected", {
        description: "Please select at least one list to import"
      });
      return;
    }

    try {
      let importedCount = 0;
      let skippedCount = 0;

      setConfig(prev => {
        const newCatalogs = [...prev.catalogs];

        selectedLists.forEach(listName => {
          const list = lists.find(l => l.name === listName);
          if (!list) return;

          const catalogId = `anilist.${listName}`;

          if (newCatalogs.some(c => c.id === catalogId)) {
            skippedCount++;
            return;
          }

          // Create CatalogConfig for each selected list
          const listUsername = username || undefined;
          const listUrl = listUsername ? `https://anilist.co/user/${listUsername}/animelist/${encodeURIComponent(listName)}` : undefined;
          
          const newCatalog: CatalogConfig = {
            id: catalogId,
            name: listName,
            type: 'anime',
            enabled: true,
            showInHome: true,
            source: 'anilist',
            sort,
            sortDirection,
            // Include metadata (username, itemCount, isCustomList, url)
            metadata: {
              username: listUsername,
              listName,
              itemCount: list.entryCount,
              isCustomList: list.isCustomList,
              ...(listUrl && { url: listUrl }),
            },
          };

          newCatalogs.push(newCatalog);
          importedCount++;
        });

        return {
          ...prev,
          catalogs: newCatalogs,
        };
      });

      // Show success/error toast notifications 
      if (importedCount > 0) {
        toast.success("Lists imported successfully", {
          description: `${importedCount} list(s) added to your catalogs${skippedCount > 0 ? `, ${skippedCount} already existed` : ''}`
        });
      } else if (skippedCount > 0) {
        toast.info("No new lists imported", {
          description: `All ${skippedCount} selected list(s) were already imported`
        });
      }

      // Reset selection after import
      setSelectedLists(new Set());
    } catch (error) {
      console.error("Error importing AniList lists:", error);
      toast.error("Failed to import lists", {
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
    }
  }, [selectedLists, lists, username, setConfig]);

  const importSelectedPublicLists = useCallback(() => {
    if (selectedPublicLists.size === 0) {
      toast.error("No lists selected", {
        description: "Please select at least one list to import"
      });
      return;
    }

    const trimmedUsername = publicUsername.trim();
    if (!trimmedUsername) {
      toast.error("Username is required");
      return;
    }

    try {
      let importedCount = 0;
      let skippedCount = 0;

      setConfig(prev => {
        const newCatalogs = [...prev.catalogs];

        selectedPublicLists.forEach(listName => {
          const list = publicLists.find(l => l.name === listName);
          if (!list) return;

          // Include username in the catalog id to avoid clashing with the logged-in user's lists
          const catalogId = `anilist.${trimmedUsername}.${listName}`;

          if (newCatalogs.some(c => c.id === catalogId)) {
            skippedCount++;
            return;
          }

          // Create CatalogConfig for each selected list
          const listUrl = `https://anilist.co/user/${trimmedUsername}/animelist/${encodeURIComponent(listName)}`;
          
          const newCatalog: CatalogConfig = {
            id: catalogId,
            name: `${listName} (@${trimmedUsername})`,
            type: 'anime',
            enabled: true,
            showInHome: true,
            source: 'anilist',
            sort,
            sortDirection,
            // Include metadata (username, itemCount, isCustomList, url)
            metadata: {
              username: trimmedUsername,
              listName,
              itemCount: list.entryCount,
              isCustomList: list.isCustomList,
              url: listUrl,
            },
          };

          newCatalogs.push(newCatalog);
          importedCount++;
        });

        return {
          ...prev,
          catalogs: newCatalogs,
        };
      });

      // Show success/error toast notifications 
      if (importedCount > 0) {
        toast.success("Lists imported successfully", {
          description: `${importedCount} list(s) added to your catalogs${skippedCount > 0 ? `, ${skippedCount} already existed` : ''}`
        });
      } else if (skippedCount > 0) {
        toast.info("No new lists imported", {
          description: `All ${skippedCount} selected list(s) were already imported`
        });
      }

      // Reset selection after import
      setSelectedPublicLists(new Set());
    } catch (error) {
      console.error("Error importing public AniList lists:", error);
      toast.error("Failed to import lists", {
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
    }
  }, [selectedPublicLists, publicLists, publicUsername, setConfig]);

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
        if (data.provider === 'anilist') {
          setUsername(data.username);
          
          setConfig(prev => ({
            ...prev,
            apiKeys: {
              ...prev.apiKeys,
              anilistTokenId: tempTokenId.trim(),
            },
          }));

          setIsConnected(true);
          toast.success(`Connected as @${data.username}`);
        } else {
          toast.error("Invalid AniList token");
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
      // clear local AniList linkage without hitting the backend.
      if (!auth.userUUID) {
        setConfig(prev => ({
          ...prev,
          apiKeys: {
            ...prev.apiKeys,
            anilistTokenId: undefined,
          },
        }));
        setTempTokenId("");
        setIsConnected(false);
        setUsername(null);
        toast.success("AniList account disconnected");
        return;
      }

      const response = await fetch("/anilist/disconnect", {
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
        apiKeys: {
          ...prev.apiKeys,
          anilistTokenId: undefined,
        },
      }));
      
      toast.success("AniList account disconnected");
    } catch (error: any) {
      console.error("Disconnect error:", error);
      toast.error(error.message || "Failed to disconnect AniList");
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <img 
              src="https://anilist.co/img/icons/android-chrome-512x512.png" 
              alt="AniList" 
              className="w-6 h-6"
            />
            AniList Integration
          </DialogTitle>
          <DialogDescription>
            Connect your AniList account to automatically sync your anime watch progress.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Connection Status */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Connection Status</CardTitle>
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
                  {tokenExpiresAt && (() => {
                    const daysLeft = Math.floor((tokenExpiresAt - Date.now()) / (1000 * 60 * 60 * 24));
                    if (daysLeft <= 0) {
                      return (
                        <div className="flex items-center gap-2 text-red-600 text-sm">
                          <XCircle className="h-4 w-4" />
                          <span>Token expired — please reconnect your AniList account.</span>
                        </div>
                      );
                    } else if (daysLeft <= 30) {
                      return (
                        <div className="flex items-center gap-2 text-yellow-600 text-sm">
                          <span>⚠️ Token expires in {daysLeft} day{daysLeft !== 1 ? 's' : ''} — you'll need to reconnect then.</span>
                        </div>
                      );
                    }
                    return null;
                  })()}
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
                      "Disconnect AniList"
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
                      Connect with AniList
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
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Enter Token ID</CardTitle>
                <CardDescription>
                  Paste the Token ID you received after authorizing with AniList.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2">
                  <Input
                    placeholder="Paste your Token ID here"
                    value={tempTokenId}
                    onChange={(e) => setTempTokenId(e.target.value)}
                  />
                  <Button onClick={handleSave} disabled={!tempTokenId.trim()}>
                    Save
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Features Info */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Features</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 mt-0.5 text-green-500 flex-shrink-0" />
                  <span>Automatically track anime episodes you watch</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 mt-0.5 text-green-500 flex-shrink-0" />
                  <span>Progress syncs to your AniList profile</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 mt-0.5 text-green-500 flex-shrink-0" />
                  <span>Anime status automatically updates (Watching → Completed)</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 mt-0.5 text-green-500 flex-shrink-0" />
                  <span>Import your anime lists as browsable catalogs</span>
                </li>
              </ul>
            </CardContent>
          </Card>

          {/* Trending Anime Catalog */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <List className="h-5 w-5" />
                Trending Anime
              </CardTitle>
              <CardDescription>
                Add a catalog of currently trending anime from AniList (no account required).
              </CardDescription>
            </CardHeader>
            <CardContent>
              {config.catalogs.some(c => c.id === 'anilist.trending') ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-green-600">
                    <CheckCircle2 className="h-5 w-5" />
                    <span className="font-medium">Trending catalog is already added</span>
                  </div>
                  <Button
                    variant="destructive"
                    onClick={() => {
                      setConfig(prev => ({
                        ...prev,
                        catalogs: prev.catalogs.filter(c => c.id !== 'anilist.trending')
                      }));
                      toast.success("Trending catalog removed");
                    }}
                  >
                    Remove Trending Catalog
                  </Button>
                </div>
              ) : (
                <Button
                  onClick={() => {
                    const newCatalog: CatalogConfig = {
                      id: 'anilist.trending',
                      name: 'AniList Trending',
                      type: 'anime',
                      enabled: true,
                      showInHome: true,
                      source: 'anilist',
                    };
                    setConfig(prev => ({
                      ...prev,
                      catalogs: [...prev.catalogs, newCatalog]
                    }));
                    toast.success("Trending catalog added");
                  }}
                  className="w-full sm:w-auto"
                >
                  <Download className="h-4 w-4 mr-2" />
                  Add Trending Catalog
                </Button>
              )}
            </CardContent>
          </Card>

          {/* Import Public User Lists Section */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <List className="h-5 w-5" />
                Import Lists by Username
              </CardTitle>
              <CardDescription>
                Fetch and import anime lists from any AniList user (public lists only).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Username Input */}
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Enter AniList username..."
                  value={publicUsername}
                  onChange={(e) => setPublicUsername(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && publicUsername.trim()) {
                      fetchPublicUserLists();
                    }
                  }}
                />
                <Button
                  onClick={fetchPublicUserLists}
                  disabled={!publicUsername.trim() || isLoadingPublicLists}
                  variant="outline"
                >
                  {isLoadingPublicLists ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Loading...
                    </>
                  ) : (
                    <>
                      <List className="h-4 w-4 mr-2" />
                      Fetch Lists
                    </>
                  )}
                </Button>
              </div>

              {/* Sorting controls for imported catalogs */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <span className="text-sm">Sort By</span>
                  <Select value={sort} onValueChange={(v) => setSort(v as typeof ANILIST_SORT_OPTIONS[number])}>
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select sort" />
                    </SelectTrigger>
                    <SelectContent>
                      {ANILIST_SORT_OPTIONS.map(opt => (
                        <SelectItem key={opt} value={opt}>{opt.replace(/_/g, ' ')}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <span className="text-sm">Direction</span>
                  <Select value={sortDirection} onValueChange={(v) => setSortDirection(v as 'asc'|'desc')}>
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select direction" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="asc">Ascending</SelectItem>
                      <SelectItem value="desc">Descending</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Public Lists Display */}
              {publicListsLoaded && publicLists.length > 0 && (
                <div className="space-y-3">
                  <div className="text-sm font-medium text-muted-foreground">
                    Select lists to import ({selectedPublicLists.size} selected)
                  </div>
                  <div className="border rounded-lg divide-y max-h-64 overflow-y-auto">
                    {publicLists.map((list) => {
                      const alreadyImported = isListAlreadyImported(list.name, publicUsername.trim());
                      return (
                        <div
                          key={list.name}
                          className="flex items-center justify-between p-3 hover:bg-muted/50"
                        >
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={selectedPublicLists.has(list.name)}
                              onCheckedChange={(checked) => handlePublicListSelection(list.name, checked)}
                              disabled={alreadyImported}
                            />
                            <div className="flex flex-col">
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{list.name}</span>
                                {list.isCustomList && (
                                  <Badge variant="secondary" className="text-xs">
                                    Custom
                                  </Badge>
                                )}
                                {alreadyImported && (
                                  <Badge variant="outline" className="text-xs text-green-600 border-green-600">
                                    Imported
                                  </Badge>
                                )}
                              </div>
                              <span className="text-xs text-muted-foreground">
                                {list.entryCount} {list.entryCount === 1 ? 'entry' : 'entries'}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {publicListsLoaded && publicLists.length === 0 && (
                <div className="text-sm text-muted-foreground text-center py-4">
                  No public anime lists found for this username.
                </div>
              )}

              {/* Import Selected Button */}
              {publicListsLoaded && publicLists.length > 0 && (
                <div className="flex justify-end pt-2">
                  <Button
                    onClick={importSelectedPublicLists}
                    disabled={selectedPublicLists.size === 0}
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Import Selected ({selectedPublicLists.size})
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Import Your Lists Section  */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <List className="h-5 w-5" />
                Import Your Lists
              </CardTitle>
              <CardDescription>
                Load your own AniList anime lists and import them as browsable catalogs in Stremio.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Load Lists Button */}
              <div className="flex items-center gap-3">
                <Button
                  onClick={fetchAniListLists}
                  disabled={!isConnected || isLoadingLists}
                  variant="outline"
                >
                  {isLoadingLists ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Loading Lists...
                    </>
                  ) : (
                    <>
                      <List className="h-4 w-4 mr-2" />
                      Load Lists
                    </>
                  )}
                </Button>
                {!isConnected && (
                  <span className="text-sm text-muted-foreground">
                    Connect your AniList account first
                  </span>
                )}
              </div>

              {/* Lists Display */}
              {listsLoaded && lists.length > 0 && (
                <div className="space-y-3">
                  <div className="text-sm font-medium text-muted-foreground">
                    Select lists to import ({selectedLists.size} selected)
                  </div>
                  <div className="border rounded-lg divide-y max-h-64 overflow-y-auto">
                    {lists.map((list) => {
                      const alreadyImported = isListAlreadyImported(list.name, username || undefined);
                      return (
                        <div
                          key={list.name}
                          className="flex items-center justify-between p-3 hover:bg-muted/50"
                        >
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={selectedLists.has(list.name)}
                              onCheckedChange={(checked) => handleListSelection(list.name, checked)}
                              disabled={alreadyImported}
                            />
                            <div className="flex flex-col">
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{list.name}</span>
                                {list.isCustomList && (
                                  <Badge variant="secondary" className="text-xs">
                                    Custom
                                  </Badge>
                                )}
                                {alreadyImported && (
                                  <Badge variant="outline" className="text-xs text-green-600 border-green-600">
                                    Imported
                                  </Badge>
                                )}
                              </div>
                              <span className="text-xs text-muted-foreground">
                                {list.entryCount} {list.entryCount === 1 ? 'entry' : 'entries'}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {listsLoaded && lists.length === 0 && (
                <div className="text-sm text-muted-foreground text-center py-4">
                  No anime lists found on your AniList account.
                </div>
              )}

              {/* Import Selected Button */}
              {listsLoaded && lists.length > 0 && (
                <div className="flex justify-end pt-2">
                  <Button
                    onClick={importSelectedLists}
                    disabled={selectedLists.size === 0}
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Import Selected ({selectedLists.size})
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
