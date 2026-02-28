import React, { useState, useCallback, useEffect } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { ChevronDown, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from "sonner";
import { apiCache } from '@/utils/apiCache';
import { getGenresBySelection, GenreSelection } from '@/data/genres';
import { getMdbListType, createMDBListCatalog } from '@/utils/catalogUtils';
import type { CatalogConfig } from '@/contexts/ConfigContext';

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
  const [topLists, setTopLists] = useState<any[]>([]);
  const [selectedTopLists, setSelectedTopLists] = useState<Set<string>>(new Set());
  const [isLoadingTopLists, setIsLoadingTopLists] = useState(false);

  const [externalLists, setExternalLists] = useState<any[]>([]);
  const [selectedExternalLists, setSelectedExternalLists] = useState<Set<string>>(new Set());
  const [isLoadingExternalLists, setIsLoadingExternalLists] = useState(false);
  const [externalUnifiedSettings, setExternalUnifiedSettings] = useState<Record<string, boolean>>({});

  const [userListSort, setUserListSort] = useState<'ranked' | 'name' | 'created'>('ranked');
  const [watchlistUnified, setWatchlistUnified] = useState<boolean>(true);

  // User info state
  const [userInfo, setUserInfo] = useState<any>(null);
  const [loadingUserInfo, setLoadingUserInfo] = useState(false);
  const [userInfoCollapsed, setUserInfoCollapsed] = useState(false);
  
  // Fetch user info when dialog opens with valid key
  useEffect(() => {
    if (isOpen && isValid && tempKey) {
      setLoadingUserInfo(true);
      const cacheKey = `mdblist_user_${tempKey.substring(0, 8)}`;
      apiCache.cachedFetch(
        cacheKey,
        async () => {
          const response = await fetch(`/api/mdblist/user?apikey=${encodeURIComponent(tempKey)}`);
          return response.ok ? await response.json() : null;
        },
        15 * 60 * 1000 // Cache for 15 minutes
      )
        .then(data => setUserInfo(data))
        .catch(() => setUserInfo(null))
        .finally(() => setLoadingUserInfo(false));
    } else {
      setUserInfo(null);
    }
  }, [isOpen, isValid, tempKey]);

  // Helper function to get display type override
  const getDisplayTypeOverride = (
    type: 'movie' | 'series',
    displayTypeOverrides?: Record<string, string>
  ): string | undefined => {
    if (!displayTypeOverrides) return undefined;
    return displayTypeOverrides[type];
  };
  
  // Function to import selected top lists
  const importSelectedTopLists = useCallback(async () => {
    if (selectedTopLists.size === 0) {
      toast.error("Please select at least one top list to import.");
      return;
    }

    try {
      setConfig(prev => {
        let newCatalogs = [...prev.catalogs];
        let newListsAddedCount = 0;

        selectedTopLists.forEach(listId => {
          const list = topLists.find(l => l.id === listId);
          if (!list) return;

          const catalogId = `mdblist.${list.id}`;

          // Check if catalog already exists
          if (!newCatalogs.some(c => c.id === catalogId)) {
            const newCatalog = createMDBListCatalog({
              list,
              sort: defaultSort,
              order: defaultOrder,
              cacheTTL: defaultCacheTTL,
              genreSelection: defaultGenreSelection,
              displayTypeOverrides: prev.displayTypeOverrides,
            });
            newCatalogs.push(newCatalog);
            newListsAddedCount++;
          }
        });

        return {
          ...prev,
          catalogs: newCatalogs,
        };
      });

      toast.success("Top lists imported successfully", {
        description: `${selectedTopLists.size} top list(s) added to your catalogs`
      });

      // Reset selection
      setSelectedTopLists(new Set());
    } catch (error) {
      console.error("Error importing top lists:", error);
      toast.error("Failed to import top lists", {
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
    }
  }, [selectedTopLists, topLists, setConfig, defaultSort, defaultOrder, defaultCacheTTL, defaultGenreSelection]);

  const fetchExternalUserLists = useCallback(async () => {
    if (!tempKey) {
      toast.error("Please enter your MDBList API key first.");
      return;
    }

    setIsLoadingExternalLists(true);
    try {
      const response = await fetch(`/api/mdblist/external/lists/user?apikey=${tempKey}`);
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(`User not found or has no public external lists`);
        }
        throw new Error(`Failed to fetch lists (Status: ${response.status})`);
      }

      const userLists = await response.json();
      if (!Array.isArray(userLists)) {
        throw new Error("Invalid response format from MDBList API");
      }

      if (userLists.length === 0) {
        toast.info("No external lists found", {
          description: `You have no public external lists available`
        });
        setExternalLists([]);
      } else {
        const initialUnifiedSettings: Record<string, boolean> = {};
        userLists.forEach((list: any) => {
          initialUnifiedSettings[list.id] = true; // Default all to unified
        });
        setExternalUnifiedSettings(initialUnifiedSettings);        
        setExternalLists(userLists);
        setSelectedExternalLists(new Set());
        toast.success("External lists loaded", {
          description: `Found ${userLists.length} list(s)`
        });
      }
    } catch (error) {
      console.error("Error fetching external user lists:", error);
      toast.error("Failed to load external user lists", {
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
      setExternalLists([]);
    } finally {
      setIsLoadingExternalLists(false);
    }
  }, [tempKey]);

  const handleExternalListSelection = (listId: string, checked: boolean) => {
    const newSelection = new Set(selectedExternalLists);
    if (checked) {
      newSelection.add(listId);
    } else {
      newSelection.delete(listId);
    }
    setSelectedExternalLists(newSelection);
  };

  const importSelectedExternalLists = useCallback(async () => {
    if (selectedExternalLists.size === 0) {
      toast.error("Please select at least one external list to import.");
      return;
    }

    try {
      setConfig(prev => {
        let newCatalogs = [...prev.catalogs];
        selectedExternalLists.forEach(listId => {
          const list = externalLists.find(l => l.id === listId);
          if (!list) return;

          const listType = getMdbListType(list);
          const sourceUrl = `https://api.mdblist.com/external/lists/${list.id}/items`;

          if (listType === 'all' && externalUnifiedSettings[list.id] === false) {
            // Create separate movie and series catalogs
            const movieCatalogId = `mdblist.${list.id}.movies`;
            const seriesCatalogId = `mdblist.${list.id}.series`;
              
            if (!newCatalogs.some(c => c.id === movieCatalogId)) {
              const movieCatalog = createMDBListCatalog({
                list: { ...list, id: `${list.id}.movies`, name: `${list.name} (Movies)` },
                sort: defaultSort,
                order: defaultOrder,
                cacheTTL: defaultCacheTTL,
                genreSelection: defaultGenreSelection,
                displayTypeOverrides: prev.displayTypeOverrides,
                sourceUrl,
              });
              // Override type to movie for split catalog
              movieCatalog.type = 'movie';
              movieCatalog.id = movieCatalogId;
              newCatalogs.push(movieCatalog);
            }
            
            if (!newCatalogs.some(c => c.id === seriesCatalogId)) {
              const seriesCatalog = createMDBListCatalog({
                list: { ...list, id: `${list.id}.series`, name: `${list.name} (Series)` },
                sort: defaultSort,
                order: defaultOrder,
                cacheTTL: defaultCacheTTL,
                genreSelection: defaultGenreSelection,
                displayTypeOverrides: prev.displayTypeOverrides,
                sourceUrl,
              });
              // Override type to series for split catalog
              seriesCatalog.type = 'series';
              seriesCatalog.id = seriesCatalogId;
              newCatalogs.push(seriesCatalog);
            }
          } else {
            // Create a single catalog (either unified 'all' or specific 'movie'/'series')
            const catalogId = `mdblist.${list.id}`;
            if (!newCatalogs.some(c => c.id === catalogId)) {
              const newCatalog = createMDBListCatalog({
                list,
                sort: defaultSort,
                order: defaultOrder,
                cacheTTL: defaultCacheTTL,
                genreSelection: defaultGenreSelection,
                displayTypeOverrides: prev.displayTypeOverrides,
                sourceUrl,
              });
              newCatalogs.push(newCatalog);
            }
          }
        });

        return { ...prev, catalogs: newCatalogs };
      });

      toast.success("External lists imported successfully", {
        description: `${selectedExternalLists.size} list(s) processed and added to your catalogs`
      });
      setSelectedExternalLists(new Set());
      
    } catch (error) {
      console.error("Error importing external user lists:", error);
      toast.error("Failed to import external user lists", {
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
    }
  }, [selectedExternalLists, externalLists, setConfig, defaultSort, defaultOrder, defaultCacheTTL, defaultGenreSelection, externalUnifiedSettings]);

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
      const response = await fetch(`/api/mdblist/lists/user?apikey=${tempKey}&username=${username}&sort=${userListSort}`);
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
          list.name && (list.name.toLowerCase().includes('wearers') || list.name.toLowerCase().includes('digital bits'))
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

  const handleImportTopLists = useCallback(async () => {
    if (!tempKey) {
      toast.error("Please enter your MDBList API key first.");
      return;
    }

    setIsLoadingTopLists(true);
    try {
      const response = await fetch(`/api/mdblist/lists/top?apikey=${tempKey}`);
      if (!response.ok) {
        throw new Error("Failed to fetch top lists");
      }

      const topLists = await response.json();
      if (!Array.isArray(topLists)) {
        throw new Error("Unexpected response format");
      }

      const listsWithUser = topLists.map((list: any) => ({
        ...list,
        user: list.user_name || "Unknown",
        username: list.user_name || "unknown",
        userDescription: `Top list by ${list.user_name || "Unknown"}`
      }));

      setTopLists(listsWithUser);
      setSelectedTopLists(new Set());

      toast.success("Top lists loaded", {
        description: `Found ${listsWithUser.length} top list(s)`
      });
    } catch (error) {
      console.error("Error fetching top lists:", error);
      toast.error("Failed to load top lists", {
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
      setPopularLists([]);
    } finally {
      setIsLoadingTopLists(false);
    }
  }, [tempKey]);

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
      const response = await fetch(`/api/mdblist/lists/user?apikey=${tempKey}&username=${encodeURIComponent(customUsername.trim())}&sort=${userListSort}`);
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

          const catalogId = `mdblist.${list.id}`;
          
          // Check if catalog already exists
          if (!newCatalogs.some(c => c.id === catalogId)) {
            const newCatalog = createMDBListCatalog({
              list,
              sort: defaultSort,
              order: defaultOrder,
              cacheTTL: defaultCacheTTL,
              genreSelection: defaultGenreSelection,
              displayTypeOverrides: prev.displayTypeOverrides,
            });
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

          const catalogId = `mdblist.${list.id}`;
          
          // Check if catalog already exists
          if (!newCatalogs.some(c => c.id === catalogId)) {
            const newCatalog = createMDBListCatalog({
              list,
              sort: defaultSort,
              order: defaultOrder,
              cacheTTL: defaultCacheTTL,
              genreSelection: defaultGenreSelection,
              displayTypeOverrides: prev.displayTypeOverrides,
            });
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
      const response = await fetch(`/api/mdblist/lists/user?apikey=${tempKey}`);
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
          const type = getMdbListType(list);
          const catalogId = `mdblist.${list.id}`;
          const catalogKey = `${catalogId}-${type}`;
          
          // Check if catalog already exists
          if (!existingMdbListIds.has(catalogKey)) {
            // Add new catalog at the end
            const newCatalog = createMDBListCatalog({
              list,
              sort: defaultSort,
              order: defaultOrder,
              cacheTTL: defaultCacheTTL,
              genreSelection: defaultGenreSelection,
              displayTypeOverrides: prev.displayTypeOverrides,
            });
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
      const parts = path.split('/').filter(p => p);
      if (parts.length < 3 || parts[0] !== 'lists') {
        throw new Error("Invalid MDBList URL format.");
      }
      const username = parts[1];
      const listname = parts.slice(2).join('/');

      const response = await fetch(`/api/mdblist/lists/${encodeURIComponent(username)}/${encodeURIComponent(listname)}?apikey=${tempKey}`);
      if (!response.ok) throw new Error(`Error fetching list (Status: ${response.status})`);

      const lists = await response.json();
      if (!Array.isArray(lists) || lists.length === 0) {
        throw new Error("No lists found in the response.");
      }
      
      setConfig(prev => {
        let newCatalogs: CatalogConfig[] = [];
        let addedCount = 0;
        let skippedCount = 0;

        lists.forEach((list: any) => {
          const newCatalog = createMDBListCatalog({
            list,
            sort: defaultSort,
            order: defaultOrder,
            cacheTTL: defaultCacheTTL,
            genreSelection: defaultGenreSelection,
            displayTypeOverrides: prev.displayTypeOverrides,
            listUrl: customListUrl,
          });

          // Prevent duplicates
          if (prev.catalogs.some(c => c.id === newCatalog.id)) {
            skippedCount++;
            return;
          }
          
          newCatalogs.push(newCatalog);
          addedCount++;
        });

        if (addedCount === 0) {
          toast.info(`List "${lists[0]?.name || 'Unknown'}" is already in your catalog list.`);
          return prev;
        }
        
        return { 
          ...prev, 
          catalogs: [...prev.catalogs, ...newCatalogs],
        };
      });

      const listName = lists[0]?.name || 'List';
      if (lists.length === 1) {
        toast.success("List Added", { description: `The list "${listName}" has been added to your catalogs.` });
      } else {
        toast.success("Lists Added", { description: `${lists.length} catalog(s) from "${listName}" have been added to your catalogs.` });
      }
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
          enableRatingPosters: true,
          metadata: {}
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
            enableRatingPosters: true,
            ...(movieDisplayType && { displayType: movieDisplayType }),
            metadata: {}
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
            enableRatingPosters: true,
            ...(seriesDisplayType && { displayType: seriesDisplayType }),
            metadata: {}
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

  const handleAddUpNext = () => {
    if (!isValid) {
      toast.error("Please enter and validate your MDBList API key first");
      return;
    }

    setConfig(prev => {
      const displayType = getDisplayTypeOverride('series', prev.displayTypeOverrides);

      const newCatalog: CatalogConfig = {
        id: "mdblist.upnext",
        type: "series",
        name: "MDBList Up Next",
        enabled: true,
        showInHome: true,
        source: "mdblist",
        cacheTTL: 300, // 5 minutes
        ...(displayType && { displayType }),
      };

      return {
        ...prev,
        catalogs: [...prev.catalogs, newCatalog],
      };
    });

    toast.success("Up Next catalog added");
  };

  const handleRemoveUpNext = () => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.filter(c => c.id !== "mdblist.upnext"),
    }));
    toast.success("Up Next catalog removed");
  };
  
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <img src="https://mdblist.com//static/mdblist_logo.png" alt="MDBList Logo" className="h-7 w-auto" />
            <DialogTitle>MDBList Integration</DialogTitle>
          </div>
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

          {/* User Info & Limits */}
          {isValid && (
            <Card>
              <CardHeader className="cursor-pointer" onClick={() => setUserInfoCollapsed(!userInfoCollapsed)}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {userInfo?.avatar_url && (
                      <img src={userInfo.avatar_url} alt="Avatar" className="h-8 w-8 rounded-full" />
                    )}
                    <div>
                      <CardTitle>Account & Limits</CardTitle>
                      <CardDescription>
                        {userInfo ? `${userInfo.username || 'User'}${userInfo.plan ? ` \u2022 ${userInfo.plan} plan` : ''}` : 'Your MDBList account info and usage limits'}
                      </CardDescription>
                    </div>
                  </div>
                  <ChevronDown
                    className={`w-5 h-5 transition-transform ${userInfoCollapsed ? 'rotate-180' : ''}`}
                  />
                </div>
              </CardHeader>
              {!userInfoCollapsed && (
                <CardContent>
                  {loadingUserInfo ? (
                    <div className="text-center text-muted-foreground py-8">Loading account info...</div>
                  ) : userInfo ? (
                    <div className="space-y-6">
                      {/* Account Info */}
                      <div className="space-y-3">
                        <h3 className="font-semibold text-sm text-muted-foreground">Account</h3>
                        <div className="space-y-2">
                          {userInfo.name && (
                            <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                              <span className="text-xs text-muted-foreground">Name</span>
                              <span className="font-bold text-sm">{userInfo.name}</span>
                            </div>
                          )}
                          <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                            <span className="text-xs text-muted-foreground">Plan</span>
                            <span className="font-bold text-sm capitalize">{userInfo.plan || 'Free'}</span>
                          </div>
                          {userInfo.is_supporter && (
                            <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                              <span className="text-xs text-muted-foreground">Supporter</span>
                              <Badge variant="secondary" className="text-xs">Supporter</Badge>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Limits */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {/* List Limits */}
                        <div className="space-y-3">
                          <h3 className="font-semibold text-sm text-muted-foreground">List Limits</h3>
                          <div className="space-y-2">
                            <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                              <span className="text-xs text-muted-foreground">Lists</span>
                              <span className="font-bold text-sm">{userInfo.limits?.lists ?? '—'}</span>
                            </div>
                            <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                              <span className="text-xs text-muted-foreground">External Lists</span>
                              <span className="font-bold text-sm">{userInfo.limits?.external_lists ?? '—'}</span>
                            </div>
                          </div>
                        </div>

                        {/* Catalog Queries */}
                        <div className="space-y-3">
                          <h3 className="font-semibold text-sm text-muted-foreground">Catalog Queries</h3>
                          <div className="space-y-2">
                            <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                              <span className="text-xs text-muted-foreground">Limit</span>
                              <span className="font-bold text-sm">{userInfo.limits?.catalog_queries ?? '—'}</span>
                            </div>
                            <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                              <span className="text-xs text-muted-foreground">Used</span>
                              <span className="font-bold text-sm">{userInfo.limits?.catalog_queries_used ?? 0}</span>
                            </div>
                            <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                              <span className="text-xs text-muted-foreground">Remaining</span>
                              <span className={`font-bold text-sm ${
                                userInfo.limits?.catalog_queries_remaining != null && userInfo.limits.catalog_queries_remaining <= 5
                                  ? 'text-destructive' : ''
                              }`}>
                                {userInfo.limits?.catalog_queries_remaining ?? '—'}
                              </span>
                            </div>
                            {userInfo.limits?.catalog_queries_first_expires_at && (
                              <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                                <span className="text-xs text-muted-foreground">Next Expiry</span>
                                <span className="font-bold text-sm">
                                  {new Date(userInfo.limits.catalog_queries_first_expires_at).toLocaleString()}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Rate Limits */}
                      <div className="space-y-3">
                        <h3 className="font-semibold text-sm text-muted-foreground">Rate Limits</h3>
                        <div className="grid grid-cols-2 gap-2">
                          <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                            <span className="text-xs text-muted-foreground">Limit</span>
                            <span className="font-bold text-sm">{userInfo.rate_limit ?? '—'}/s</span>
                          </div>
                          <div className="flex justify-between items-center p-2 rounded-lg bg-muted/40">
                            <span className="text-xs text-muted-foreground">Remaining</span>
                            <span className="font-bold text-sm">{userInfo.rate_limit_remaining ?? '—'}/s</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-center text-muted-foreground py-8">Unable to load account info.</div>
                  )}
                </CardContent>
              )}
            </Card>
          )}

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

          {/* Up Next Catalog Section */}
          {isValid && (
            <Card>
              <CardHeader>
                <CardTitle>Up Next</CardTitle>
                <CardDescription>Shows the next episode to watch for each show in your MDBList watched list</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2">
                  <Button
                    onClick={handleAddUpNext}
                    variant="outline"
                    className="flex-1"
                    disabled={!!config.catalogs.find(c => c.id === 'mdblist.upnext')}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Add Up Next
                  </Button>
                </div>
                {config.catalogs.find(c => c.id === 'mdblist.upnext') && (
                  <div className="space-y-2 border-t pt-4">
                    <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                      <span className="font-medium">MDBList Up Next</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleRemoveUpNext}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="flex items-center justify-between p-3 border rounded-lg">
                      <div className="space-y-0.5">
                        <label className="text-sm font-medium">Use Show Poster</label>
                        <p className="text-xs text-muted-foreground">Display show poster instead of episode thumbnail</p>
                      </div>
                      <Switch
                        checked={config.catalogs.find(c => c.id === 'mdblist.upnext')?.metadata?.useShowPosterForUpNext || false}
                        onCheckedChange={(checked) => {
                          setConfig(prev => ({
                            ...prev,
                            catalogs: prev.catalogs.map(c =>
                              c.id === 'mdblist.upnext'
                                ? { ...c, metadata: { ...c.metadata, useShowPosterForUpNext: checked } }
                                : c
                            )
                          }));
                        }}
                      />
                    </div>
                    <div className="flex items-center justify-between p-3 border rounded-lg">
                      <div className="space-y-0.5">
                        <label className="text-sm font-medium">Hide Unreleased Episodes</label>
                        <p className="text-xs text-muted-foreground">Exclude episodes airing today (they appear starting the next day)</p>
                      </div>
                      <Switch
                        checked={config.catalogs.find(c => c.id === 'mdblist.upnext')?.metadata?.hideUnreleased || false}
                        onCheckedChange={(checked) => {
                          setConfig(prev => ({
                            ...prev,
                            catalogs: prev.catalogs.map(c =>
                              c.id === 'mdblist.upnext'
                                ? { ...c, metadata: { ...c.metadata, hideUnreleased: checked } }
                                : c
                            )
                          }));
                        }}
                      />
                    </div>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  This catalog will show the next episode to watch for each show in your MDBList watched list.
                </p>
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

          {/* Top Lists Section */}
          {isValid && (
            <Card>
              <CardHeader>
                <CardTitle>Community Top Lists</CardTitle>
                <CardDescription>
                  Browse the most popular and trending lists from the MDBList community
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button
                  onClick={handleImportTopLists}
                  disabled={isLoadingTopLists}
                  variant="outline"
                  className="w-full h-auto p-4 flex flex-col items-start space-y-2"
                >
                  <div className="flex items-center space-x-2 w-full">
                    {isLoadingTopLists ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <div className="w-2 h-2 bg-blue-500 rounded-full" />
                    )}
                    <span className="font-medium">Browse Top Lists</span>
                  </div>
                  <p className="text-xs text-muted-foreground text-left">
                    Popular and trending lists from the MDBList community
                  </p>
                </Button>

                {/* Top Lists Display */}
                {topLists.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center space-x-3 p-3 border rounded-lg bg-muted/30">
                      <Switch
                        id="select-all-top"
                        checked={selectedTopLists.size === topLists.length && topLists.length > 0}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedTopLists(new Set(topLists.map(l => l.id)));
                          } else {
                            setSelectedTopLists(new Set());
                          }
                        }}
                      />
                      <Label htmlFor="select-all-top" className="font-medium cursor-pointer">
                        Select all top lists
                      </Label>
                      <Badge variant="outline" className="ml-auto">
                        {selectedTopLists.size}/{topLists.length}
                      </Badge>
                    </div>

                    <div className="grid grid-cols-1 gap-3 max-h-80 overflow-y-auto border rounded-lg p-3 bg-muted/20">
                      {topLists.map((list) => (
                        <div key={list.id} className="flex items-start space-x-3 p-3 border rounded-lg">
                          <Switch
                            id={`top-${list.id}`}
                            checked={selectedTopLists.has(list.id)}
                            onCheckedChange={(checked) => {
                              const newSelection = new Set(selectedTopLists);
                              if (checked) {
                                newSelection.add(list.id);
                              } else {
                                newSelection.delete(list.id);
                              }
                              setSelectedTopLists(newSelection);
                            }}
                          />
                          <div className="flex-1 min-w-0">
                            <Label htmlFor={`top-${list.id}`} className="font-medium cursor-pointer">
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

                    {selectedTopLists.size > 0 && (
                      <Button 
                        onClick={importSelectedTopLists} 
                        className="w-full"
                        disabled={selectedTopLists.size === 0}
                      >
                        Import {selectedTopLists.size} Selected List{selectedTopLists.size !== 1 ? 's' : ''}
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* External Lists Section */}
          {isValid && (
            <Card>
              <CardHeader>
                <CardTitle>Import My External Lists</CardTitle>
                <CardDescription>
                  Import your external lists from Trakt, IMDb, Letterboxd, etc.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
              <Button 
                onClick={fetchExternalUserLists} 
                disabled={isLoadingExternalLists} 
                variant="outline"
                className="w-full"
              >
                {isLoadingExternalLists ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Loading...
                  </>
                ) : (
                  "Load My External Lists"
                )}
              </Button>

              {/* External Lists Display */}
              {externalLists.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center space-x-3 p-3 border rounded-lg bg-muted/30">
                    <Switch
                      id="select-all-external"
                      checked={selectedExternalLists.size === externalLists.length && externalLists.length > 0}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setSelectedExternalLists(new Set(externalLists.map(l => l.id)));
                        } else {
                          setSelectedExternalLists(new Set());
                        }
                      }}
                    />
                    <Label htmlFor="select-all-external" className="font-medium cursor-pointer">
                      Select all my external lists
                    </Label>
                    <Badge variant="outline" className="ml-auto">
                      {selectedExternalLists.size}/{externalLists.length}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-1 gap-3 max-h-80 overflow-y-auto border rounded-lg p-3 bg-muted/20">
                    {externalLists.map((list) => {
                      const listType = getMdbListType(list);
                      const isMixedType = listType === 'all';

                      return (
                        <div key={list.id} className="flex items-start space-x-3 p-3 border rounded-lg">
                          <Switch
                            id={`external-${list.id}`}
                            checked={selectedExternalLists.has(list.id)}
                            onCheckedChange={(checked) => handleExternalListSelection(list.id, checked)}
                          />
                          <div className="flex-1 min-w-0">
                            <Label htmlFor={`external-${list.id}`} className="font-medium cursor-pointer">
                              {list.name}
                            </Label>
                            <div className="flex items-center gap-2 mt-1">
                              <Badge variant="outline" className="text-xs capitalize">
                                {listType}
                              </Badge>
                              <Badge variant="secondary" className="text-xs capitalize">
                                {list.source}
                              </Badge>
                              <Badge variant="secondary" className="text-xs">
                                by {list.user_name}
                              </Badge>
                              {list.items > 0 && (
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
                            {isMixedType && (
                              <div className="flex items-center justify-between mt-2 p-2 border rounded-md bg-muted/50">
                                <div className="space-y-0.5">
                                  <Label htmlFor={`unified-switch-${list.id}`} className="text-sm font-medium">Unified Format</Label>
                                  <p className="text-xs text-muted-foreground">
                                    {externalUnifiedSettings[list.id] ?? true
                                      ? "One catalog for all media types"
                                      : "Separate catalogs for movies & series"}
                                  </p>
                                </div>
                                <Switch
                                  id={`unified-switch-${list.id}`}
                                  checked={externalUnifiedSettings[list.id] ?? true}
                                  onCheckedChange={(checked) => {
                                    setExternalUnifiedSettings(prev => ({ ...prev, [list.id]: checked }));
                                  }}
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {selectedExternalLists.size > 0 && (
                    <Button 
                      onClick={importSelectedExternalLists} 
                      className="w-full"
                      disabled={selectedExternalLists.size === 0}
                    >
                      Import {selectedExternalLists.size} Selected List{selectedExternalLists.size !== 1 ? 's' : ''}
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

