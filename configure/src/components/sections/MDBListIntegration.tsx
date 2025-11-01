import React, { useState, useCallback } from 'react';
import { useConfig,  CatalogConfig} from '@/contexts/ConfigContext';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Loader2 } from 'lucide-react';
import { toast } from "sonner";
import { getGenresBySelection, GenreSelection } from '@/data/genres';

interface MDBListIntegrationProps {
  isOpen: boolean;
  onClose: () => void;
}

export function MDBListIntegration({ isOpen, onClose }: MDBListIntegrationProps) {
  const { config, setConfig, catalogTTL } = useConfig();
  const [tempKey, setTempKey] = useState(config.apiKeys.mdblist || "");
  const [isValid, setIsValid] = useState(!!config.apiKeys.mdblist);
  const [isChecking, setIsChecking] = useState(false);
  const [customListUrl, setCustomListUrl] = useState("");
  const [customUsername, setCustomUsername] = useState("");
  const [customUserLists, setCustomUserLists] = useState<any[]>([]);
  const [selectedCustomLists, setSelectedCustomLists] = useState<Set<string>>(new Set());
  const [isLoadingCustomUser, setIsLoadingCustomUser] = useState(false);
  const [defaultSort, setDefaultSort] = useState<'rank' | 'score' | 'usort' | 'score_average' | 'released' | 'releasedigital' | 'imdbrating' | 'imdbvotes' | 'last_air_date' | 'imdbpopular' | 'tmdbpopular' | 'rogerbert' | 'rtomatoes' | 'rtaudience' | 'metacritic' | 'myanimelist' | 'letterrating' | 'lettervotes' | 'budget' | 'revenue' | 'runtime' | 'title' | 'added' | 'random' | 'default'>('default');
  const [defaultOrder, setDefaultOrder] = useState<'asc' | 'desc'>('asc');
  const [defaultCacheTTL, setDefaultCacheTTL] = useState<number>(catalogTTL);
  const [defaultGenreSelection, setDefaultGenreSelection] = useState<GenreSelection>('standard'); // Default to standard genres only
  const [popularLists, setPopularLists] = useState<any[]>([]);
  const [selectedPopularLists, setSelectedPopularLists] = useState<Set<string>>(new Set());
  const [isLoadingPopularLists, setIsLoadingPopularLists] = useState(false);
  const [userListSort, setUserListSort] = useState<'ranked' | 'name' | 'created'>('ranked');
  const [watchlistUnified, setWatchlistUnified] = useState<boolean>(true);

  const popularUsers = [
    { username: 'tvgeniekodi', name: 'Mr. Professor', description: 'Curated TV and movie lists' },
    { username: 'snoak', name: 'Snoak', description: 'Quality content collections' },
    { username: 'garycrawfordgc', name: 'Gary Crawford', description: 'Expert curated lists' },
    { username: 'danaramapyjama', name: 'Dan Pyjama', description: 'Curated film lists for Pyjama wearers' }
  ];

  const fetchPopularListsFromUser = useCallback(async (username: string, displayName: string) => {
    if (!tempKey) {
      toast.error("Please enter your MDBList API key first.");
      return;
    }

    setIsLoadingPopularLists(true);
    try {
      const response = await fetch(`https://api.mdblist.com/lists/user/${username}?apikey=${tempKey}&sort=${userListSort}`);
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(`User "${username}" not found or has no public lists`);
        }
        throw new Error(`Failed to fetch lists (Status: ${response.status})`);
      }

      const userLists = await response.json();
      if (!Array.isArray(userLists)) {
        throw new Error("Invalid response format from MDBList API");
      }

      let filteredLists = userLists;
      
      // For danaramapyjama, only include lists containing "wearers" in the name
      if (username === 'danaramapyjama') {
        filteredLists = userLists.filter((list: any) => 
          list.name && list.name.toLowerCase().includes('wearers')
        );
      }

      if (filteredLists.length === 0) {
        toast.info("No lists found", {
          description: username === 'danaramapyjama' 
            ? `No "wearers" lists found for ${displayName}`
            : `User "${displayName}" has no public lists available`
        });
        setPopularLists([]);
      } else {
        // Add user info to each list
        const listsWithUser = filteredLists.map((list: any) => ({
          ...list,
          user: displayName,
          username: username,
          userDescription: popularUsers.find(u => u.username === username)?.description || ""
        }));
        
        setPopularLists(listsWithUser);
        setSelectedPopularLists(new Set());
        
        toast.success("Popular lists loaded", {
          description: `Found ${filteredLists.length} list(s) from ${displayName}`
        });
      }
    } catch (error) {
      console.error("Error fetching popular lists:", error);
      toast.error("Failed to load popular lists", {
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
      setPopularLists([]);
    } finally {
      setIsLoadingPopularLists(false);
    }
  }, [tempKey]);

  const handlePopularListSelection = (listId: string, checked: boolean) => {
    const newSelection = new Set(selectedPopularLists);
    if (checked) {
      newSelection.add(listId);
    } else {
      newSelection.delete(listId);
    }
    setSelectedPopularLists(newSelection);
  };

  const fetchCustomUserLists = useCallback(async () => {
    if (!tempKey) {
      toast.error("Please enter your MDBList API key first.");
      return;
    }

    if (!customUsername.trim()) {
      toast.error("Please enter a username to fetch lists from.");
      return;
    }

    setIsLoadingCustomUser(true);
    try {
      const response = await fetch(`https://api.mdblist.com/lists/user/${customUsername.trim()}?apikey=${tempKey}&sort=${userListSort}`);
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(`User "${customUsername}" not found or has no public lists`);
        }
        throw new Error(`Failed to fetch lists (Status: ${response.status})`);
      }

      const userLists = await response.json();
      if (!Array.isArray(userLists)) {
        throw new Error("Invalid response format from MDBList API");
      }

      let filteredLists = userLists;
      
      // For danaramapyjama, only include lists containing "wearers" in the name
      if (customUsername.trim().toLowerCase() === 'danaramapyjama') {
        filteredLists = userLists.filter((list: any) => 
          list.name && list.name.toLowerCase().includes('wearers')
        );
      }

      if (filteredLists.length === 0) {
        toast.info("No lists found", {
          description: customUsername.trim().toLowerCase() === 'danaramapyjama'
            ? `No "wearers" lists found for ${customUsername}`
            : `User "${customUsername}" has no public lists available`
        });
        setCustomUserLists([]);
      } else {
        setCustomUserLists(filteredLists);
        setSelectedCustomLists(new Set());
        toast.success("User lists loaded", {
          description: `Found ${filteredLists.length} list(s) from ${customUsername}`
        });
      }
    } catch (error) {
      console.error("Error fetching custom user lists:", error);
      toast.error("Failed to load user lists", {
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
      setCustomUserLists([]);
    } finally {
      setIsLoadingCustomUser(false);
    }
  }, [tempKey, customUsername]);

  const handleCustomListSelection = (listId: string, checked: boolean) => {
    const newSelection = new Set(selectedCustomLists);
    if (checked) {
      newSelection.add(listId);
    } else {
      newSelection.delete(listId);
    }
    setSelectedCustomLists(newSelection);
  };

  const importSelectedCustomLists = useCallback(async () => {
    if (selectedCustomLists.size === 0) {
      toast.error("Please select at least one list to import.");
      return;
    }

    try {
      setConfig(prev => {
        let newCatalogs = [...prev.catalogs];
        let newListsAddedCount = 0;

        selectedCustomLists.forEach(listId => {
          const list = customUserLists.find(l => l.id === listId);
          if (!list) return;

          const type = list.mediatype === "movie" ? "movie" : "series";
          const catalogId = `mdblist.${list.id}`;
          
          // Check if catalog already exists
          if (!newCatalogs.some(c => c.id === catalogId)) {
            // Apply display type overrides if configured
            let displayType = undefined;
            if (prev.displayTypeOverrides) {
              if (type === 'movie' && prev.displayTypeOverrides.movie) {
                displayType = prev.displayTypeOverrides.movie;
              } else if (type === 'series' && prev.displayTypeOverrides.series) {
                displayType = prev.displayTypeOverrides.series;
              }
            }
            
            const newCatalog: CatalogConfig = {
              id: catalogId,
              type,
              name: list.name,
              enabled: true,
              showInHome: true,
              source: 'mdblist',
              sort: defaultSort,
              order: defaultOrder,
              cacheTTL: defaultCacheTTL,
              genreSelection: defaultGenreSelection,
              enableRPDB: true,
              ...(displayType && { displayType }),
            };
            newCatalogs.push(newCatalog);
            newListsAddedCount++;
          }
        });

        return {
          ...prev,
          catalogs: newCatalogs,
        };
      });

      toast.success("User lists imported successfully", {
        description: `${selectedCustomLists.size} list(s) added to your catalogs`
      });

      // Reset selection
      setSelectedCustomLists(new Set());
      
    } catch (error) {
      console.error("Error importing custom user lists:", error);
      toast.error("Failed to import user lists", {
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
    }
  }, [selectedCustomLists, customUserLists, customUsername, setConfig, defaultSort, defaultOrder, defaultCacheTTL, defaultGenreSelection]);

  const importSelectedPopularLists = useCallback(async () => {
    if (selectedPopularLists.size === 0) {
      toast.error("Please select at least one list to import.");
      return;
    }

    try {
      setConfig(prev => {
        let newCatalogs = [...prev.catalogs];
        let newListsAddedCount = 0;

        selectedPopularLists.forEach(listId => {
          const list = popularLists.find(l => l.id === listId);
          if (!list) return;

          const type = list.mediatype === "movie" ? "movie" : "series";
          const catalogId = `mdblist.${list.id}`;
          
          // Check if catalog already exists
          if (!newCatalogs.some(c => c.id === catalogId)) {
            // Apply display type overrides if configured
            let displayType = undefined;
            if (prev.displayTypeOverrides) {
              if (type === 'movie' && prev.displayTypeOverrides.movie) {
                displayType = prev.displayTypeOverrides.movie;
              } else if (type === 'series' && prev.displayTypeOverrides.series) {
                displayType = prev.displayTypeOverrides.series;
              }
            }
            
            const newCatalog: CatalogConfig = {
              id: catalogId,
              type,
              name: list.name,
              enabled: true,
              showInHome: true,
              source: 'mdblist',
              sort: defaultSort,
              order: defaultOrder,
              cacheTTL: defaultCacheTTL,
              genreSelection: defaultGenreSelection,
              enableRPDB: true,
              ...(displayType && { displayType }),
            };
            newCatalogs.push(newCatalog);
            newListsAddedCount++;
          }
        });

        return {
          ...prev,
          catalogs: newCatalogs,
        };
      });

      toast.success("Popular lists imported successfully", {
        description: `${selectedPopularLists.size} list(s) added to your catalogs`
      });

      // Reset selection
      setSelectedPopularLists(new Set());
      
    } catch (error) {
      console.error("Error importing popular lists:", error);
      toast.error("Failed to import popular lists", {
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
    }
  }, [selectedPopularLists, popularLists, setConfig, defaultSort, defaultOrder, defaultCacheTTL, defaultGenreSelection]);

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
            // Apply display type overrides if configured
            let displayType = undefined;
            if (prev.displayTypeOverrides) {
              if (type === 'movie' && prev.displayTypeOverrides.movie) {
                displayType = prev.displayTypeOverrides.movie;
              } else if (type === 'series' && prev.displayTypeOverrides.series) {
                displayType = prev.displayTypeOverrides.series;
              }
            }
            
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
              cacheTTL: defaultCacheTTL,
              genreSelection: defaultGenreSelection,
              enableRPDB: true,
              ...(displayType && { displayType }),
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
  }, [setConfig, tempKey, defaultSort, defaultOrder, defaultCacheTTL, defaultGenreSelection]);

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
      
      setConfig(prev => {
        // Apply display type overrides if configured
        let displayType = undefined;
        if (prev.displayTypeOverrides) {
          if (type === 'movie' && prev.displayTypeOverrides.movie) {
            displayType = prev.displayTypeOverrides.movie;
          } else if (type === 'series' && prev.displayTypeOverrides.series) {
            displayType = prev.displayTypeOverrides.series;
          }
        }
        
        const newCatalog: CatalogConfig = {
          id: `mdblist.${list.id}`,
          type,
          name: list.name,
          enabled: true,
          showInHome: true,
          source: 'mdblist',
          sort: defaultSort,
          order: defaultOrder,
          cacheTTL: defaultCacheTTL,
          genreSelection: defaultGenreSelection,
          ...(displayType && { displayType }),
        };

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

  const handleImportWatchlist = async () => {
    if (!tempKey) {
      toast.error("Please enter your MDBList API key first.");
      return;
    }

    try {
      if (watchlistUnified) {
        // Unified format: create single catalog
        const newCatalog: CatalogConfig = {
          id: 'mdblist.watchlist',
          type: 'all', // Unified watchlist shows both movies and series
          name: 'Watchlist',
          enabled: true,
          showInHome: true,
          source: 'mdblist',
          sourceUrl: `https://api.mdblist.com/watchlist/items?unified=true`,
          sort: defaultSort,
          order: defaultOrder,
          cacheTTL: defaultCacheTTL,
          genreSelection: defaultGenreSelection,
          enableRPDB: true
        };

        setConfig(prev => {
          // Prevent duplicates
          if (prev.catalogs.some(c => c.id === newCatalog.id)) {
            toast.info("Your MDBList watchlist is already in your catalog list.");
            return prev;
          }
          
          return { 
            ...prev, 
            catalogs: [...prev.catalogs, newCatalog],
          };
        });

        toast.success("Watchlist Added", { 
          description: "Your MDBList watchlist has been added to your catalogs." 
        });
      } else {
        // Non-unified format: create separate catalogs for movies and series
        setConfig(prev => {
          // Apply display type overrides if configured
          let movieDisplayType = undefined;
          let seriesDisplayType = undefined;
          if (prev.displayTypeOverrides) {
            if (prev.displayTypeOverrides.movie) {
              movieDisplayType = prev.displayTypeOverrides.movie;
            }
            if (prev.displayTypeOverrides.series) {
              seriesDisplayType = prev.displayTypeOverrides.series;
            }
          }

          const movieCatalog: CatalogConfig = {
            id: 'mdblist.watchlist.movies',
            type: 'movie',
            name: 'Watchlist (Movies)',
            enabled: true,
            showInHome: true,
            source: 'mdblist',
            sourceUrl: `https://api.mdblist.com/watchlist/items?unified=false`,
            sort: defaultSort,
            order: defaultOrder,
            cacheTTL: defaultCacheTTL,
            genreSelection: defaultGenreSelection,
            enableRPDB: true,
            ...(movieDisplayType && { displayType: movieDisplayType }),
          };

          const seriesCatalog: CatalogConfig = {
            id: 'mdblist.watchlist.series',
            type: 'series',
            name: 'Watchlist (Series)',
            enabled: true,
            showInHome: true,
            source: 'mdblist',
            sourceUrl: `https://api.mdblist.com/watchlist/items?unified=false`,
            sort: defaultSort,
            order: defaultOrder,
            cacheTTL: defaultCacheTTL,
            genreSelection: defaultGenreSelection,
            enableRPDB: true,
            ...(seriesDisplayType && { displayType: seriesDisplayType }),
          };

          // Check for existing catalogs
          const hasMovies = prev.catalogs.some(c => c.id === movieCatalog.id);
          const hasSeries = prev.catalogs.some(c => c.id === seriesCatalog.id);
          
          if (hasMovies && hasSeries) {
            toast.info("Your MDBList watchlist catalogs are already in your catalog list.");
            return prev;
          }
          
          const newCatalogs = [];
          if (!hasMovies) newCatalogs.push(movieCatalog);
          if (!hasSeries) newCatalogs.push(seriesCatalog);
          
          return { 
            ...prev, 
            catalogs: [...prev.catalogs, ...newCatalogs],
          };
        });

        toast.success("Watchlist Catalogs Added", { 
          description: "Your MDBList watchlist has been added as separate movie and series catalogs." 
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "An unknown error occurred.";
      toast.error("Error Adding Watchlist", { description: message });
    }
  };
  
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>MDBList Integration</DialogTitle>
          <DialogDescription>
            Import your public and private lists from MDBList.com to use as catalogs.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6 py-4">
          {/* API Key Section */}
          <Card>
            <CardHeader>
              <CardTitle>MDBList API Key</CardTitle>
              <CardDescription>
                Enter your MDBList API key to access public and private lists
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="mdblistkey">API Key</Label>
                <Input id="mdblistkey" value={tempKey} onChange={(e) => setTempKey(e.target.value)} placeholder="Enter your MDBList API key" />
                <a href="https://mdblist.com/preferences/#api_key_uid" target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground hover:underline">
                  Where do I get this?
                </a>
              </div>
            </CardContent>
          </Card>
          
          {isValid && (
            <Card>
              <CardHeader>
                <CardTitle>Default Settings</CardTitle>
                <CardDescription>
                  Configure default sort and cache settings for newly imported lists
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
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
              <div className="space-y-2">
                <Label htmlFor="default-cache-ttl">Default Cache TTL (seconds)</Label>
                <div className="flex items-center space-x-2">
                  <input
                    id="default-cache-ttl"
                    type="number"
                    value={defaultCacheTTL}
                    onChange={(e) => setDefaultCacheTTL(parseInt(e.target.value) || catalogTTL)}
                    min="300"
                    max="604800"
                    step="3600"
                    className="flex-1 px-3 py-2 border border-input bg-background rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                    placeholder={catalogTTL.toString()}
                  />
                  <span className="text-sm text-muted-foreground whitespace-nowrap">
                    ({Math.floor(defaultCacheTTL / 3600)}h {Math.floor((defaultCacheTTL % 3600) / 60)}m)
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  How long to cache newly added lists before refreshing. Range: 5 minutes to 7 days.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="genre-selection">Default Genre Selection</Label>
                <Select value={defaultGenreSelection} onValueChange={(value: GenreSelection) => setDefaultGenreSelection(value)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select genre set" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="standard">Standard Genres Only (44 genres)</SelectItem>
                    <SelectItem value="anime">Anime Genres Only (22 genres)</SelectItem>
                    <SelectItem value="all">All Genres (66 genres including anime)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Choose which genre set to use for newly added lists. Standard genres are recommended for most users.
                </p>
              </div>
                <div className="text-xs text-muted-foreground mt-2">
                  Note: Sort and cache settings will apply to newly added lists. Changes take effect after saving your configuration.
                </div>
              </CardContent>
            </Card>
          )}
          {/* Custom User Lists Section */}
          {isValid && (
            <Card>
              <CardHeader>
                <CardTitle>Import Lists from Any User</CardTitle>
                <CardDescription>
                  Enter any MDBList username to browse and import their public lists
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
              
              {/* Sort selector for user lists */}
              <div className="space-y-2">
                <Label htmlFor="user-list-sort">Sort User Lists By</Label>
                <Select value={userListSort} onValueChange={(value: 'ranked' | 'name' | 'created') => setUserListSort(value)}>
                  <SelectTrigger id="user-list-sort" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ranked">Ranked (Default)</SelectItem>
                    <SelectItem value="name">Name</SelectItem>
                    <SelectItem value="created">Date Created</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  This affects how lists are sorted when browsing any user's lists
                </p>
              </div>
              
              <div className="flex items-center space-x-2">
                <Input 
                  placeholder="Enter MDBList username (e.g., tvgeniekodi)" 
                  value={customUsername}
                  onChange={(e) => setCustomUsername(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      fetchCustomUserLists();
                    }
                  }}
                />
                <Button 
                  onClick={fetchCustomUserLists} 
                  disabled={isLoadingCustomUser || !customUsername.trim()} 
                  variant="outline"
                >
                  {isLoadingCustomUser ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Loading...
                    </>
                  ) : (
                    "Load User Lists"
                  )}
                </Button>
              </div>

              {/* Custom User Lists Display */}
              {customUserLists.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center space-x-3 p-3 border rounded-lg bg-muted/30">
                    <Switch
                      id="select-all-custom"
                      checked={selectedCustomLists.size === customUserLists.length && customUserLists.length > 0}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setSelectedCustomLists(new Set(customUserLists.map(l => l.id)));
                        } else {
                          setSelectedCustomLists(new Set());
                        }
                      }}
                    />
                    <Label htmlFor="select-all-custom" className="font-medium cursor-pointer">
                      Select all lists from {customUsername}
                    </Label>
                    <Badge variant="outline" className="ml-auto">
                      {selectedCustomLists.size}/{customUserLists.length}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-1 gap-3 max-h-80 overflow-y-auto border rounded-lg p-3 bg-muted/20">
                    {customUserLists.map((list) => (
                      <div key={list.id} className="flex items-start space-x-3 p-3 border rounded-lg">
                        <Switch
                          id={`custom-${list.id}`}
                          checked={selectedCustomLists.has(list.id)}
                          onCheckedChange={(checked) => handleCustomListSelection(list.id, checked)}
                        />
                        <div className="flex-1 min-w-0">
                          <Label htmlFor={`custom-${list.id}`} className="font-medium cursor-pointer">
                            {list.name}
                          </Label>
                          <div className="flex items-center gap-2 mt-1">
                            <Badge variant="outline" className="text-xs capitalize">
                              {list.mediatype}
                            </Badge>
                            <Badge variant="secondary" className="text-xs">
                              by {customUsername}
                            </Badge>
                            {list.items && (
                              <Badge variant="secondary" className="text-xs">
                                {list.items} items
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
                    <Button 
                      onClick={importSelectedCustomLists} 
                      className="w-full"
                      disabled={selectedCustomLists.size === 0}
                    >
                      Import {selectedCustomLists.size} Selected List{selectedCustomLists.size !== 1 ? 's' : ''} from {customUsername}
                    </Button>
                  )}
                </div>
              )}
              </CardContent>
            </Card>
          )}

          {/* Legacy: Add Single List by URL */}
          {isValid && (
            <Card>
              <CardHeader>
                <CardTitle>Add Single List by URL</CardTitle>
                <CardDescription>
                  Use this only for single lists. For multiple lists, use the "Import Lists from Any User" section above.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center space-x-2">
                  <Input id="customListUrl" value={customListUrl} onChange={(e) => setCustomListUrl(e.target.value)} placeholder="https://mdblist.com/lists/user/list-name" />
                  <Button onClick={handleAddCustomList} variant="outline">Add</Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Import My Watchlist Section */}
          {isValid && (
            <Card>
              <CardHeader>
                <CardTitle>Import My Watchlist</CardTitle>
                <CardDescription>
                  Import your personal MDBList watchlist as a catalog. This will create a catalog that shows items from your watchlist.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="watchlist-unified" className="text-sm font-medium">
                        Unified Format
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {watchlistUnified 
                          ? "Creates one catalog with all items (movies and shows mixed)"
                          : "Creates separate catalogs for movies and series"
                        }
                      </p>
                    </div>
                    <Switch
                      id="watchlist-unified"
                      checked={watchlistUnified}
                      onCheckedChange={setWatchlistUnified}
                    />
                  </div>
                  <div className="flex items-center space-x-2">
                    <Button 
                      onClick={handleImportWatchlist} 
                      disabled={!tempKey}
                      className="w-full"
                    >
                      Import My Watchlist
                    </Button>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    This will create a catalog showing items from your personal MDBList watchlist.
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Popular Lists Section */}
          {isValid && (
            <Card>
              <CardHeader>
                <CardTitle>Popular Lists from Featured Curators</CardTitle>
                <CardDescription>
                  Quick access to curated lists from popular MDBList curators
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                
                {/* Sort selector (shared with custom user lists) */}
                <div className="space-y-2">
                  <Label htmlFor="user-list-sort-popular">Sort User Lists By</Label>
                  <Select value={userListSort} onValueChange={(value: 'ranked' | 'name' | 'created') => setUserListSort(value)}>
                    <SelectTrigger id="user-list-sort-popular" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ranked">Ranked (Default)</SelectItem>
                      <SelectItem value="name">Name</SelectItem>
                      <SelectItem value="created">Date Created</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    This affects how lists are sorted when browsing curator lists
                  </p>
                </div>
                
                {/* Individual Curator Buttons */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {popularUsers.map((user) => (
                    <Button 
                      key={user.username}
                      onClick={() => fetchPopularListsFromUser(user.username, user.name)}
                      disabled={isLoadingPopularLists}
                      variant="outline"
                      className="h-auto p-4 flex flex-col items-start space-y-2"
                    >
                      <div className="flex items-center space-x-2 w-full">
                        {isLoadingPopularLists ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <div className="w-2 h-2 bg-green-500 rounded-full" />
                        )}
                        <span className="font-medium">{user.name}</span>
                      </div>
                      <p className="text-xs text-muted-foreground text-left">
                        {user.description}
                      </p>
                    </Button>
                  ))}
                </div>

              {/* Popular Lists Display */}
              {popularLists.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center space-x-3 p-3 border rounded-lg bg-muted/30">
                    <Switch
                      id="select-all-popular"
                      checked={selectedPopularLists.size === popularLists.length && popularLists.length > 0}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setSelectedPopularLists(new Set(popularLists.map(l => l.id)));
                        } else {
                          setSelectedPopularLists(new Set());
                        }
                      }}
                    />
                    <Label htmlFor="select-all-popular" className="font-medium cursor-pointer">
                      Select all popular lists
                    </Label>
                    <Badge variant="outline" className="ml-auto">
                      {selectedPopularLists.size}/{popularLists.length}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-1 gap-3 max-h-80 overflow-y-auto border rounded-lg p-3 bg-muted/20">
                    {popularLists.map((list) => (
                      <div key={list.id} className="flex items-start space-x-3 p-3 border rounded-lg">
                        <Switch
                          id={list.id}
                          checked={selectedPopularLists.has(list.id)}
                          onCheckedChange={(checked) => handlePopularListSelection(list.id, checked)}
                        />
                        <div className="flex-1 min-w-0">
                          <Label htmlFor={list.id} className="font-medium cursor-pointer">
                            {list.name}
                          </Label>
                          <div className="flex items-center gap-2 mt-1">
                            <Badge variant="outline" className="text-xs capitalize">
                              {list.mediatype}
                            </Badge>
                            <Badge variant="secondary" className="text-xs">
                              by {list.user}
                            </Badge>
                            {list.items && (
                              <Badge variant="secondary" className="text-xs">
                                {list.items} items
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

                  {selectedPopularLists.size > 0 && (
                    <Button 
                      onClick={importSelectedPopularLists} 
                      className="w-full"
                      disabled={selectedPopularLists.size === 0}
                    >
                      Import {selectedPopularLists.size} Selected List{selectedPopularLists.size !== 1 ? 's' : ''}
                    </Button>
                  )}
                </div>
              )}
              </CardContent>
            </Card>
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

