import React, { useState, useEffect, useCallback } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Loader2, Plus, Trash2, KeyRound, PlayCircle, Library, Sparkles } from 'lucide-react';
import { toast } from "sonner";
import { createPublicMetaDBUpNextCatalog, createPublicMetaDBListCatalog, createPublicMetaDBPickCatalog } from '@/utils/catalogUtils';

interface PublicMetaDBIntegrationProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PublicMetaDBIntegration({ isOpen, onClose }: PublicMetaDBIntegrationProps) {
  const { config, setConfig } = useConfig();
  const [tempKey, setTempKey] = useState(config.apiKeys.publicmetadb || "");
  const [isValid, setIsValid] = useState(!!config.apiKeys.publicmetadb);
  const [isChecking, setIsChecking] = useState(false);
  const [lists, setLists] = useState<any[]>([]);
  const [selectedLists, setSelectedLists] = useState<Set<string>>(new Set());
  const [isLoadingLists, setIsLoadingLists] = useState(false);
  const [picks, setPicks] = useState<any[]>([]);
  const [selectedPicks, setSelectedPicks] = useState<Set<string>>(new Set());
  const [isLoadingPicks, setIsLoadingPicks] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setTempKey(config.apiKeys.publicmetadb || "");
      setIsValid(!!config.apiKeys.publicmetadb);
    }
  }, [isOpen, config.apiKeys.publicmetadb]);

  const validateKey = useCallback(async () => {
    if (!tempKey) {
      toast.error("Please enter your PublicMetaDB API key.");
      return;
    }
    if (!tempKey.startsWith('pm-')) {
      toast.error("Invalid key format. Keys start with 'pm-'");
      return;
    }
    setIsChecking(true);
    try {
      const res = await fetch(`/api/publicmetadb/validate?apikey=${encodeURIComponent(tempKey)}`);
      const data = await res.json();
      if (data.valid) {
        setIsValid(true);
        setConfig(prev => ({
          ...prev,
          apiKeys: { ...prev.apiKeys, publicmetadb: tempKey }
        }));
        toast.success("PublicMetaDB API key validated successfully.");
      } else {
        setIsValid(false);
        toast.error("API Key Validation Failed", { description: "The provided key is invalid." });
      }
    } catch {
      toast.error("API Key Validation Failed", { description: "Could not reach the PublicMetaDB API." });
    } finally {
      setIsChecking(false);
    }
  }, [tempKey, setConfig]);

  const handleSave = () => {
    if (isValid) {
      setConfig(prev => ({ ...prev, apiKeys: { ...prev.apiKeys, publicmetadb: tempKey } }));
      onClose();
    }
  };

  const disconnect = () => {
    setConfig(prev => ({
      ...prev,
      apiKeys: { ...prev.apiKeys, publicmetadb: '' },
      publicmetadbWatchTracking: false,
      catalogs: prev.catalogs.filter(c => !c.id.startsWith('publicmetadb.')),
    }));
    setTempKey("");
    setIsValid(false);
    setLists([]);
    setSelectedLists(new Set());
    setPicks([]);
    setSelectedPicks(new Set());
    toast.success("PublicMetaDB disconnected. All PublicMetaDB catalogs have been removed.");
  };

  const loadLists = useCallback(async () => {
    const key = config.apiKeys.publicmetadb;
    if (!key) return;
    setIsLoadingLists(true);
    try {
      const res = await fetch(`/api/publicmetadb/lists?apikey=${encodeURIComponent(key)}&perPage=500`);
      const data = await res.json();
      const items = data.items || [];
      setLists(items);
      setSelectedLists(new Set());
      if (items.length === 0) {
        toast.info("No lists found", { description: "You have no lists on your PublicMetaDB account." });
      } else {
        toast.success("Lists loaded", { description: `Found ${items.length} list(s)` });
      }
    } catch {
      toast.error("Failed to load lists", { description: "Could not reach the PublicMetaDB API." });
    } finally {
      setIsLoadingLists(false);
    }
  }, [config.apiKeys.publicmetadb]);

  const handleListSelection = (listId: string, checked: boolean) => {
    const next = new Set(selectedLists);
    if (checked) next.add(listId);
    else next.delete(listId);
    setSelectedLists(next);
  };

  const [isImporting, setIsImporting] = useState(false);

  const detectListMediaType = async (listId: string): Promise<'movie' | 'series' | 'all'> => {
    try {
      const key = config.apiKeys.publicmetadb;
      if (!key) return 'all';
      const res = await fetch(`/api/publicmetadb/lists/${listId}/items?apikey=${encodeURIComponent(key)}&perPage=500`);
      const data = await res.json();
      const items = data.items || [];
      if (items.length === 0) return 'all';

      const hasMovies = items.some((i: any) => i.media_type === 'movie');
      const hasShows = items.some((i: any) => i.media_type === 'tv');

      if (hasMovies && hasShows) return 'all';
      if (hasMovies) return 'movie';
      if (hasShows) return 'series';
      return 'all';
    } catch {
      return 'all';
    }
  };

  const importSelectedLists = useCallback(async () => {
    if (selectedLists.size === 0) {
      toast.error("Please select at least one list to import.");
      return;
    }

    setIsImporting(true);
    try {
      const listsToImport: { list: any; mediaType: 'movie' | 'series' | 'all' }[] = [];

      for (const listId of selectedLists) {
        const list = lists.find(l => l.id === listId);
        if (!list) continue;
        const catalogId = `publicmetadb.list.${list.id}`;
        if (config.catalogs.some(c => c.id === catalogId)) continue;

        const mediaType = await detectListMediaType(list.id);
        listsToImport.push({ list, mediaType });
      }

      if (listsToImport.length === 0) {
        toast.info("Selected lists are already in your catalogs.");
        return;
      }

      setConfig(prev => ({
        ...prev,
        catalogs: [
          ...prev.catalogs,
          ...listsToImport.map(({ list, mediaType }) => createPublicMetaDBListCatalog(list, mediaType)),
        ],
      }));

      toast.success("Lists imported successfully", {
        description: `${listsToImport.length} list(s) added to your catalogs`
      });
      setSelectedLists(new Set());
    } catch {
      toast.error("Failed to import lists");
    } finally {
      setIsImporting(false);
    }
  }, [selectedLists, lists, setConfig, config.catalogs, config.apiKeys.publicmetadb]);

  const addedListIds = new Set(
    config.catalogs
      .filter(c => c.id.startsWith('publicmetadb.list.'))
      .map(c => c.id.replace('publicmetadb.list.', ''))
  );

  const addedPickIds = new Set(
    config.catalogs
      .filter(c => c.id.startsWith('publicmetadb.pick.'))
      .map(c => c.id.replace('publicmetadb.pick.', ''))
  );

  const loadPicks = useCallback(async () => {
    const key = config.apiKeys.publicmetadb;
    if (!key) return;
    setIsLoadingPicks(true);
    try {
      const res = await fetch(`/api/publicmetadb/picks?apikey=${encodeURIComponent(key)}`);
      const data = await res.json();
      const items = data.items || [];
      setPicks(items);
      setSelectedPicks(new Set());
      if (items.length === 0) {
        toast.info("No picks found", { description: "You have no picks on your PublicMetaDB account." });
      } else {
        toast.success("Picks loaded", { description: `Found ${items.length} pick(s)` });
      }
    } catch {
      toast.error("Failed to load picks", { description: "Could not reach the PublicMetaDB API." });
    } finally {
      setIsLoadingPicks(false);
    }
  }, [config.apiKeys.publicmetadb]);

  const handlePickSelection = (pickId: string, checked: boolean) => {
    const next = new Set(selectedPicks);
    if (checked) next.add(pickId);
    else next.delete(pickId);
    setSelectedPicks(next);
  };

  const [isImportingPicks, setIsImportingPicks] = useState(false);

  const importSelectedPicks = useCallback(async () => {
    if (selectedPicks.size === 0) {
      toast.error("Please select at least one pick to import.");
      return;
    }

    setIsImportingPicks(true);
    try {
      const picksToImport: any[] = [];
      for (const pickId of selectedPicks) {
        const pick = picks.find(p => p.id === pickId);
        if (!pick) continue;
        if (config.catalogs.some(c => c.id === `publicmetadb.pick.${pick.id}`)) continue;
        picksToImport.push(pick);
      }

      if (picksToImport.length === 0) {
        toast.info("Selected picks are already in your catalogs.");
        return;
      }

      setConfig(prev => ({
        ...prev,
        catalogs: [
          ...prev.catalogs,
          ...picksToImport.map(pick => createPublicMetaDBPickCatalog(pick)),
        ],
      }));

      toast.success("Picks imported successfully", {
        description: `${picksToImport.length} pick(s) added to your catalogs`
      });
      setSelectedPicks(new Set());
    } catch {
      toast.error("Failed to import picks");
    } finally {
      setIsImportingPicks(false);
    }
  }, [selectedPicks, picks, setConfig, config.catalogs]);

  const hasUpNext = config.catalogs.some(c => c.id === 'publicmetadb.upnext');

  const handleAddUpNext = () => {
    if (hasUpNext) return;
    setConfig(prev => ({
      ...prev,
      catalogs: [...prev.catalogs, createPublicMetaDBUpNextCatalog()],
    }));
    toast.success("Up Next catalog added to your catalogs.");
  };

  const handleRemoveUpNext = () => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.filter(c => c.id !== 'publicmetadb.upnext'),
    }));
    toast.success("Up Next catalog removed.");
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <div className="flex items-center gap-3">
            <DialogTitle>PublicMetaDB Integration</DialogTitle>
          </div>
          <DialogDescription>
            Connect your PublicMetaDB account for continue watching, lists, and watch tracking.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4 overflow-y-auto flex-1 min-h-0 pr-3">
          {/* API Key */}
          <Card className="bg-gradient-to-br from-zinc-500/10 via-card/80 to-card/80 border-zinc-400/20">
            <CardHeader className="flex-row items-start gap-3 sm:gap-4 space-y-0 p-4 sm:p-6">
              <div className="shrink-0 h-10 w-10 rounded-lg bg-zinc-500/15 text-zinc-200 flex items-center justify-center ring-1 ring-zinc-400/20">
                <KeyRound className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0 space-y-1.5">
                <CardTitle>PublicMetaDB API Key</CardTitle>
                <CardDescription>
                  Enter your PublicMetaDB API key to access your lists and watch tracking
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="pmdb-key">API Key</Label>
                <Input
                  id="pmdb-key"
                  type="password"
                  placeholder="pm-..."
                  value={tempKey}
                  onChange={(e) => setTempKey(e.target.value)}
                />
              </div>
              {isValid && (
                <Button variant="destructive" size="sm" onClick={disconnect}>
                  Disconnect
                </Button>
              )}
            </CardContent>
          </Card>

          {/* Up Next */}
          {isValid && (
            <Card className="bg-gradient-to-br from-zinc-500/10 via-card/80 to-card/80 border-zinc-400/20">
              <CardHeader className="flex-row items-start gap-3 sm:gap-4 space-y-0 p-4 sm:p-6">
                <div className="shrink-0 h-10 w-10 rounded-lg bg-zinc-500/15 text-zinc-200 flex items-center justify-center ring-1 ring-zinc-400/20">
                  <PlayCircle className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0 space-y-1.5">
                  <CardTitle>Up Next</CardTitle>
                  <CardDescription>
                    Shows the next episode to watch based on your PublicMetaDB watch progress
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button
                  onClick={handleAddUpNext}
                  variant="outline"
                  className="flex-1"
                  disabled={hasUpNext}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Add Up Next
                </Button>
                {hasUpNext && (
                  <div className="space-y-2 border-t pt-4">
                    <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                      <span className="font-medium">PublicMetaDB Up Next</span>
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
                        checked={config.catalogs.find(c => c.id === 'publicmetadb.upnext')?.metadata?.useShowPosterForUpNext || false}
                        onCheckedChange={(checked) => {
                          setConfig(prev => ({
                            ...prev,
                            catalogs: prev.catalogs.map(c =>
                              c.id === 'publicmetadb.upnext'
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
                  This catalog will show the next episode to watch based on your continue watching progress.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Your Lists */}
          {isValid && (
            <Card className="bg-gradient-to-br from-zinc-500/10 via-card/80 to-card/80 border-zinc-400/20">
              <CardHeader className="flex-row items-start gap-3 sm:gap-4 space-y-0 p-4 sm:p-6">
                <div className="shrink-0 h-10 w-10 rounded-lg bg-zinc-500/15 text-zinc-200 flex items-center justify-center ring-1 ring-zinc-400/20">
                  <Library className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0 space-y-1.5">
                  <CardTitle>Your Lists</CardTitle>
                  <CardDescription>
                    Browse and import your PublicMetaDB lists as catalogs
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button
                  onClick={loadLists}
                  disabled={isLoadingLists}
                  variant="outline"
                >
                  {isLoadingLists ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Loading...
                    </>
                  ) : (
                    "Load My Lists"
                  )}
                </Button>

                {lists.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center space-x-3 p-3 border rounded-lg bg-muted/30">
                      <Switch
                        id="select-all-pmdb"
                        checked={selectedLists.size === lists.filter(l => !addedListIds.has(l.id)).length && lists.filter(l => !addedListIds.has(l.id)).length > 0}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedLists(new Set(lists.filter(l => !addedListIds.has(l.id)).map(l => l.id)));
                          } else {
                            setSelectedLists(new Set());
                          }
                        }}
                      />
                      <Label htmlFor="select-all-pmdb" className="font-medium cursor-pointer">
                        Select all lists
                      </Label>
                      <Badge variant="outline" className="ml-auto">
                        {selectedLists.size}/{lists.filter(l => !addedListIds.has(l.id)).length}
                      </Badge>
                    </div>

                    <div className="grid grid-cols-1 gap-3 max-h-64 overflow-y-auto border rounded-lg p-3 bg-muted/20">
                      {lists.map((list) => {
                        const alreadyAdded = addedListIds.has(list.id);
                        return (
                          <div key={list.id} className={`flex items-start space-x-3 p-3 border rounded-lg ${alreadyAdded ? 'opacity-50' : ''}`}>
                            <Switch
                              id={`pmdb-list-${list.id}`}
                              checked={selectedLists.has(list.id) || alreadyAdded}
                              disabled={alreadyAdded}
                              onCheckedChange={(checked) => handleListSelection(list.id, checked)}
                            />
                            <div className="flex-1 min-w-0">
                              <Label htmlFor={`pmdb-list-${list.id}`} className="font-medium cursor-pointer">
                                {list.name}
                              </Label>
                              <div className="flex flex-wrap items-center gap-2 mt-1">
                                {list.type && (
                                  <Badge variant="outline" className="text-xs capitalize">
                                    {list.type}
                                  </Badge>
                                )}
                                {alreadyAdded && (
                                  <Badge variant="secondary" className="text-xs">Added</Badge>
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

                    {selectedLists.size > 0 && (
                      <Button
                        onClick={importSelectedLists}
                        className="w-full"
                        disabled={isImporting}
                      >
                        {isImporting ? (
                          <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Importing...</>
                        ) : (
                          <>Import {selectedLists.size} Selected List{selectedLists.size !== 1 ? 's' : ''}</>
                        )}
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Picks */}
          {isValid && (
            <Card className="bg-gradient-to-br from-zinc-500/10 via-card/80 to-card/80 border-zinc-400/20">
              <CardHeader className="flex-row items-start gap-3 sm:gap-4 space-y-0 p-4 sm:p-6">
                <div className="shrink-0 h-10 w-10 rounded-lg bg-zinc-500/15 text-zinc-200 flex items-center justify-center ring-1 ring-zinc-400/20">
                  <Sparkles className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0 space-y-1.5">
                  <CardTitle>Picks</CardTitle>
                  <CardDescription>
                    Personalized recommendation lists based on your taste profile
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button
                  onClick={loadPicks}
                  disabled={isLoadingPicks}
                  variant="outline"
                >
                  {isLoadingPicks ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Loading...
                    </>
                  ) : (
                    "Load My Picks"
                  )}
                </Button>

                {picks.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center space-x-3 p-3 border rounded-lg bg-muted/30">
                      <Switch
                        id="select-all-pmdb-picks"
                        checked={selectedPicks.size === picks.filter(p => !addedPickIds.has(p.id)).length && picks.filter(p => !addedPickIds.has(p.id)).length > 0}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedPicks(new Set(picks.filter(p => !addedPickIds.has(p.id)).map(p => p.id)));
                          } else {
                            setSelectedPicks(new Set());
                          }
                        }}
                      />
                      <Label htmlFor="select-all-pmdb-picks" className="font-medium cursor-pointer">
                        Select all picks
                      </Label>
                      <Badge variant="outline" className="ml-auto">
                        {selectedPicks.size}/{picks.filter(p => !addedPickIds.has(p.id)).length}
                      </Badge>
                    </div>

                    <div className="grid grid-cols-1 gap-3 max-h-64 overflow-y-auto border rounded-lg p-3 bg-muted/20">
                      {picks.map((pick) => {
                        const alreadyAdded = addedPickIds.has(pick.id);
                        return (
                          <div key={pick.id} className={`flex items-start space-x-3 p-3 border rounded-lg ${alreadyAdded ? 'opacity-50' : ''}`}>
                            <Switch
                              id={`pmdb-pick-${pick.id}`}
                              checked={selectedPicks.has(pick.id) || alreadyAdded}
                              disabled={alreadyAdded}
                              onCheckedChange={(checked) => handlePickSelection(pick.id, checked)}
                            />
                            <div className="flex-1 min-w-0">
                              <Label htmlFor={`pmdb-pick-${pick.id}`} className="font-medium cursor-pointer">
                                {pick.name}
                              </Label>
                              <div className="flex flex-wrap items-center gap-2 mt-1">
                                {pick.seed_type && (
                                  <Badge variant="outline" className="text-xs capitalize">
                                    {pick.seed_type}
                                  </Badge>
                                )}
                                {pick.filters?.media_types?.length > 0 && (
                                  <Badge variant="outline" className="text-xs capitalize">
                                    {pick.filters.media_types.map((t: string) => t === 'tv' ? 'series' : t).join(', ')}
                                  </Badge>
                                )}
                                {alreadyAdded && (
                                  <Badge variant="secondary" className="text-xs">Added</Badge>
                                )}
                              </div>
                              {pick.description && (
                                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                                  {pick.description}
                                </p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {selectedPicks.size > 0 && (
                      <Button
                        onClick={importSelectedPicks}
                        className="w-full"
                        disabled={isImportingPicks}
                      >
                        {isImportingPicks ? (
                          <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Importing...</>
                        ) : (
                          <>Import {selectedPicks.size} Selected Pick{selectedPicks.size !== 1 ? 's' : ''}</>
                        )}
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

        </div>

        <DialogFooter className="shrink-0 gap-2 sm:gap-0">
          <DialogClose asChild>
            <Button variant="ghost" className="w-full sm:w-auto">Cancel</Button>
          </DialogClose>
          {isValid ? (
            <Button onClick={handleSave} className="w-full sm:w-auto">Save & Close</Button>
          ) : (
            <Button onClick={validateKey} disabled={!tempKey || isChecking} className="w-full sm:w-auto">
              {isChecking ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Checking...</>) : ("Validate Key")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
