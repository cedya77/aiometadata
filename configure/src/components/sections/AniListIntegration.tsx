import { useState, useEffect, useCallback } from 'react';
import { useConfig, CatalogConfig } from '@/contexts/ConfigContext';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
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

  const isListAlreadyImported = useCallback((listName: string): boolean => {
    const catalogId = `anilist.${listName}`;
    return config.catalogs.some(c => c.id === catalogId);
  }, [config.catalogs]);

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
          const newCatalog: CatalogConfig = {
            id: catalogId,
            name: listName,
            type: 'anime',
            enabled: true,
            showInHome: true,
            source: 'anilist',
            // Include metadata (username, itemCount, isCustomList)
            metadata: {
              username: username || undefined,
              itemCount: list.entryCount,
              isCustomList: list.isCustomList,
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
      const response = await fetch("/anilist/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          userUUID: auth.userUUID,
          tokenId: config.apiKeys?.anilistTokenId 
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

          {/* Import Lists Section  */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <List className="h-5 w-5" />
                Import Lists as Catalogs
              </CardTitle>
              <CardDescription>
                Load your AniList anime lists and import them as browsable catalogs in Stremio.
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
                      const alreadyImported = isListAlreadyImported(list.name);
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
