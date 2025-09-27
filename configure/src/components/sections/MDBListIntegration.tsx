import React, { useState, useCallback } from 'react';
import { useConfig,  CatalogConfig} from '@/contexts/ConfigContext';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Loader2 } from 'lucide-react';
import { toast } from "sonner";

interface MDBListIntegrationProps {
  isOpen: boolean;
  onClose: () => void;
}

export function MDBListIntegration({ isOpen, onClose }: MDBListIntegrationProps) {
  const { config, setConfig } = useConfig();
  const [tempKey, setTempKey] = useState(config.apiKeys.mdblist || "");
  const [isValid, setIsValid] = useState(!!config.apiKeys.mdblist);
  const [isChecking, setIsChecking] = useState(false);
  const [customListUrl, setCustomListUrl] = useState("");
  const [defaultSort, setDefaultSort] = useState<'rank' | 'score' | 'usort' | 'score_average' | 'released' | 'releasedigital' | 'imdbrating' | 'imdbvotes' | 'last_air_date' | 'imdbpopular' | 'tmdbpopular' | 'rogerbert' | 'rtomatoes' | 'rtaudience' | 'metacritic' | 'myanimelist' | 'letterrating' | 'lettervotes' | 'budget' | 'revenue' | 'runtime' | 'title' | 'added' | 'random' | 'default'>('default');
  const [defaultOrder, setDefaultOrder] = useState<'asc' | 'desc'>('asc');

  const validateApiKey = useCallback(async (isRefresh = false) => {
    if (!tempKey) {
      toast.error("Please enter your MDBList API key.");
      return false;
    }

    setIsChecking(true);
    try {
      const response = await fetch(`https://api.mdblist.com/lists/user?apikey=${tempKey}`);
      if (!response.ok) {
        throw new Error(`API request failed (Status: ${response.status})`);
      }

      const listsFromApi = await response.json();
      if (!Array.isArray(listsFromApi)) {
        throw new Error("Invalid response format from MDBList API");
      }

      let newListsAddedCount = 0;
      let restoredListsCount = 0;

      setConfig(prev => {
        // Keep all existing catalogs in their current order
        let newCatalogs = [...prev.catalogs];
        
        // Get existing MDBList catalog IDs for quick lookup
        const existingMdbListIds = new Set(
          newCatalogs
            .filter(c => c.id.startsWith("mdblist."))
            .map(c => `${c.id}-${c.type}`)
        );

        // Process each list from the API
        listsFromApi.forEach((list: any) => {
          const type = list.mediatype === "movie" ? "movie" : "series";
          const catalogId = `mdblist.${list.id}`;
          const catalogKey = `${catalogId}-${type}`;
          
          // Check if catalog already exists
          if (!existingMdbListIds.has(catalogKey)) {
            // Add new catalog at the end
            const newCatalog: CatalogConfig = {
              id: catalogId,
              type,
              name: list.name,
              enabled: true,
              showInHome: true,
              source: 'mdblist',
              sort: defaultSort,
              order: defaultOrder,
            };
            newCatalogs.push(newCatalog);
            newListsAddedCount++;
          } else {
            // Catalog exists, update its properties but keep position
            const existingCatalogIndex = newCatalogs.findIndex(c => c.id === catalogId && c.type === type);
            if (existingCatalogIndex !== -1) {
              const existingCatalog = newCatalogs[existingCatalogIndex];
              // Only restore if it was disabled
              if (!existingCatalog.enabled) {
                newCatalogs[existingCatalogIndex] = {
                  ...existingCatalog,
                  enabled: true,
                  showInHome: true,
                  name: list.name, // Update name in case it changed
                };
                restoredListsCount++;
              } else {
                // Just update the name in case it changed
                newCatalogs[existingCatalogIndex] = {
                  ...existingCatalog,
                  name: list.name,
                };
              }
            }
          }
        });

        return {
          ...prev,
          catalogs: newCatalogs,
        };
      });

      if (isRefresh) {
        if (newListsAddedCount > 0 || restoredListsCount > 0) {
          const message = [];
          if (newListsAddedCount > 0) message.push(`${newListsAddedCount} new list(s) added`);
          if (restoredListsCount > 0) message.push(`${restoredListsCount} previously deleted list(s) restored`);
          
          toast.success("Lists Refreshed", {
            description: message.join(', ') + " to your catalogs."
          });
        } else {
          const currentMdbListCount = listsFromApi.length;
          toast.info("Lists Up to Date", {
            description: `No new lists found. Your ${currentMdbListCount} MDBList catalog(s) are already synced.`
          });
        }
      } else {
        toast.success(`Successfully imported ${listsFromApi.length} lists from your MDBList account.`);
      }
    
      setIsValid(true);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "An unknown error occurred.";
      toast.error("API Key Validation Failed", { description: message });
      setIsValid(false);
      return false;
    } finally {
      setIsChecking(false);
    }
  }, [setConfig, tempKey]);

  const handleSave = () => {
    if (isValid) {
      setConfig(prev => ({ ...prev, apiKeys: { ...prev.apiKeys, mdblist: tempKey } }));
      onClose(); // Close the dialog on save
    }
  };

  const handleAddCustomList = async () => {
    if (!tempKey) {
        toast.error("Please enter your MDBList API key first.");
        return;
    }
    try {
      const path = new URL(customListUrl).pathname;
      const listName = path.replace('/lists/', '');
      if (!listName) throw new Error("Invalid MDBList URL format.");

      const response = await fetch(`https://api.mdblist.com/lists/${listName}?apikey=${tempKey}`);
      if (!response.ok) throw new Error(`Error fetching list (Status: ${response.status})`);

      const [list] = await response.json();
      const type = list.mediatype === "movie" ? "movie" : "series";
      const newCatalog: CatalogConfig = {
        id: `mdblist.${list.id}`,
        type,
        name: list.name,
        enabled: true,
        showInHome: true,
        source: 'mdblist',
        sort: defaultSort,
        order: defaultOrder,
      };

      setConfig(prev => {
        // Prevent duplicates
        if (prev.catalogs.some(c => c.id === newCatalog.id)) {
            toast.info(`List "${list.name}" is already in your catalog list.`);
            return prev;
        }
        
        return { 
          ...prev, 
          catalogs: [...prev.catalogs, newCatalog],
        };
      });

      toast.success("List Added", { description: `The list "${list.name}" has been added to your catalogs.` });
      setCustomListUrl("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "An unknown error occurred.";
      toast.error("Error Adding List", { description: message });
    }
  };
  
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>MDBList Integration</DialogTitle>
          <DialogDescription>
            Import your public and private lists from MDBList.com to use as catalogs.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="mdblistkey">MDBList API Key</Label>
            <Input id="mdblistkey" value={tempKey} onChange={(e) => setTempKey(e.target.value)} placeholder="Enter your MDBList API key" />
            <a href="https://mdblist.com/preferences/#api_key_uid" target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground hover:underline">
              Where do I get this?
            </a>
          </div>
          
          {isValid && (
            <div className="space-y-4 pt-4 border-t border-border">
              <div className="space-y-2">
                <Label>Default Sort Options</Label>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="sort-select">Sort By</Label>
                    <Select value={defaultSort} onValueChange={(value: any) => setDefaultSort(value)}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select sort option" />
                      </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Use Default Sorting</SelectItem>
                <SelectItem value="rank">Rank</SelectItem>
                <SelectItem value="score">Score</SelectItem>
                <SelectItem value="usort">User Sort</SelectItem>
                <SelectItem value="score_average">Score Average</SelectItem>
                <SelectItem value="released">Release Date</SelectItem>
                <SelectItem value="releasedigital">Digital Release</SelectItem>
                <SelectItem value="imdbrating">IMDB Rating</SelectItem>
                <SelectItem value="imdbvotes">IMDB Votes</SelectItem>
                <SelectItem value="last_air_date">Last Air Date</SelectItem>
                <SelectItem value="imdbpopular">IMDB Popular</SelectItem>
                <SelectItem value="tmdbpopular">TMDB Popular</SelectItem>
                <SelectItem value="rogerbert">Roger Ebert</SelectItem>
                <SelectItem value="rtomatoes">Rotten Tomatoes</SelectItem>
                <SelectItem value="rtaudience">RT Audience</SelectItem>
                <SelectItem value="metacritic">Metacritic</SelectItem>
                <SelectItem value="myanimelist">MyAnimeList</SelectItem>
                <SelectItem value="letterrating">Letterboxd Rating</SelectItem>
                <SelectItem value="lettervotes">Letterboxd Votes</SelectItem>
                <SelectItem value="budget">Budget</SelectItem>
                <SelectItem value="revenue">Revenue</SelectItem>
                <SelectItem value="runtime">Runtime</SelectItem>
                <SelectItem value="title">Title</SelectItem>
                <SelectItem value="added">Date Added</SelectItem>
                <SelectItem value="random">Random</SelectItem>
              </SelectContent>
                    </Select>
                  </div>
                  {defaultSort !== 'default' && (
                    <div className="space-y-2">
                      <Label htmlFor="order-select">Order</Label>
                      <Select value={defaultOrder} onValueChange={(value: 'asc' | 'desc') => setDefaultOrder(value)}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select order" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="asc">Ascending</SelectItem>
                          <SelectItem value="desc">Descending</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              </div>
              <div className="text-xs text-muted-foreground mt-2">
                Note: Sort settings will apply to newly added lists. Changes take effect after saving your configuration.
              </div>
            </div>
          )}
          {isValid && (
            <div className="space-y-2 pt-4 border-t border-border">
              <Label htmlFor="customListUrl">Add Another User's Public List by URL</Label>
              <div className="flex items-center space-x-2">
                <Input id="customListUrl" value={customListUrl} onChange={(e) => setCustomListUrl(e.target.value)} placeholder="https://mdblist.com/lists/user/list-name" />
                <Button onClick={handleAddCustomList} variant="outline">Add</Button>
              </div>
            </div>
          )}
        </div>
        <DialogFooter className="sm:justify-between">
            <div>
              {isValid && (
                <Button variant="outline" onClick={() => validateApiKey(true)} disabled={isChecking}>
                  {isChecking ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Refreshing...</>) : ("Refresh My Lists")}
                </Button>
              )}
            </div>

            <div className="flex space-x-2">
                <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
                {isValid ? (
                  <Button onClick={handleSave}>Save & Close</Button>
                ) : (
                  <Button onClick={() => validateApiKey(false)} disabled={!tempKey || isChecking}>
                    {isChecking ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Checking...</>) : ("Check Key & Import My Lists")}
                  </Button>
                )}
            </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

