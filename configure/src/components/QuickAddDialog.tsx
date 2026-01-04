import { useState, useCallback, useEffect } from 'react';
import { useConfig, CatalogConfig } from '@/contexts/ConfigContext';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Loader2, Plus, AlertCircle, Link, Search } from 'lucide-react';
import { toast } from "sonner";
import { parseQuickAddUrl, ParsedUrl } from '@/utils/urlParser';
import { 
  createMDBListCatalog, 
  createTraktCatalog, 
  createLetterboxdCatalog, 
  createCustomManifestCatalog,
  getMdbListType 
} from '@/utils/catalogUtils';
import { apiCache } from '@/utils/apiCache';

interface QuickAddDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface SelectableItem {
  id: string;
  name: string;
  type?: 'movie' | 'series' | 'all';
  itemCount?: number;
  author?: string;
}

type QuickAddStep = 'input' | 'selection' | 'loading';

export function QuickAddDialog({ isOpen, onClose }: QuickAddDialogProps) {
  const { config, setConfig, catalogTTL } = useConfig();
  
  // State
  const [url, setUrl] = useState('');
  const [parsedUrl, setParsedUrl] = useState<ParsedUrl | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<QuickAddStep>('input');
  
  // Selection state for multi-item imports
  const [items, setItems] = useState<SelectableItem[]>([]);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [searchFilter, setSearchFilter] = useState('');
  
  // Store raw list data for proper catalog creation
  const [rawListData, setRawListData] = useState<Map<string, any>>(new Map());
  
  // For manifest catalogs
  const [manifest, setManifest] = useState<any>(null);

  // Reset state when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setUrl('');
      setParsedUrl(null);
      setError(null);
      setStep('input');
      setItems([]);
      setSelectedItems(new Set());
      setSearchFilter('');
      setRawListData(new Map());
      setManifest(null);
      setIsLoading(false);
    }
  }, [isOpen]);

  // Handle URL change and parse
  const handleUrlChange = useCallback((newUrl: string) => {
    setUrl(newUrl);
    setError(null);
    
    if (!newUrl.trim()) {
      setParsedUrl(null);
      return;
    }
    
    const parsed = parseQuickAddUrl(newUrl);
    setParsedUrl(parsed);
    
    if (parsed.service === 'unknown') {
      setError('URL not recognized. Supported: MDBList lists/users, Trakt lists/users, Letterboxd lists/watchlists, or manifest.json URLs');
    }
  }, []);

  // Get service badge color
  const getServiceBadgeVariant = (service: string): "default" | "secondary" | "destructive" | "outline" => {
    switch (service) {
      case 'mdblist': return 'default';
      case 'trakt': return 'secondary';
      case 'letterboxd': return 'outline';
      case 'manifest': return 'secondary';
      default: return 'destructive';
    }
  };

  // Get service display name
  const getServiceDisplayName = (service: string): string => {
    switch (service) {
      case 'mdblist': return 'MDBList';
      case 'trakt': return 'Trakt';
      case 'letterboxd': return 'Letterboxd';
      case 'manifest': return 'Custom Manifest';
      default: return 'Unknown';
    }
  };

  // Get service icon path
  const getServiceIcon = (service: string | undefined): string | null => {
    switch (service) {
      case 'mdblist': return '/mdblist_icon.png';
      case 'trakt': return '/trakt_icon.png';
      case 'letterboxd': return '/letterboxd_icon.png';
      case 'manifest': return '/manifest_icon.png';
      default: return null;
    }
  };

  // Handle item selection
  const handleItemSelection = (itemId: string, checked: boolean) => {
    const newSelection = new Set(selectedItems);
    if (checked) {
      newSelection.add(itemId);
    } else {
      newSelection.delete(itemId);
    }
    setSelectedItems(newSelection);
  };

  // Select all items
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedItems(new Set(items.map(item => item.id)));
    } else {
      setSelectedItems(new Set());
    }
  };

  // Check if catalog already exists
  const catalogExists = (catalogId: string): boolean => {
    return config.catalogs.some(c => c.id === catalogId);
  };

  // Filter items based on search
  const filteredItems = items.filter(item => 
    item.name.toLowerCase().includes(searchFilter.toLowerCase())
  );

  // ============================================================================
  // MDBList Handler
  // ============================================================================
  const handleMDBList = async () => {
    if (!parsedUrl || parsedUrl.service !== 'mdblist') return;
    
    const apiKey = config.apiKeys.mdblist;
    if (!apiKey) {
      setError('MDBList API key required. Please configure it in the MDBList Integration settings.');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      if (parsedUrl.type === 'single-list' && parsedUrl.username && parsedUrl.listSlug) {
        // Single list - add directly
        const response = await fetch(
          `/api/mdblist/lists/${encodeURIComponent(parsedUrl.username)}/${encodeURIComponent(parsedUrl.listSlug)}?apikey=${apiKey}`
        );
        
        if (!response.ok) {
          throw new Error(`Failed to fetch list (Status: ${response.status})`);
        }

        const [list] = await response.json();
        const catalogId = `mdblist.${list.id}`;
        
        if (catalogExists(catalogId)) {
          toast.info(`List "${list.name}" is already in your catalog list.`);
          onClose();
          return;
        }

        const newCatalog = createMDBListCatalog({
          list,
          cacheTTL: catalogTTL,
          displayTypeOverrides: config.displayTypeOverrides,
        });

        setConfig(prev => ({
          ...prev,
          catalogs: [...prev.catalogs, newCatalog],
        }));

        toast.success("List Added", { 
          description: `The list "${list.name}" has been added to your catalogs.` 
        });
        onClose();
        
      } else if (parsedUrl.type === 'user-profile' && parsedUrl.username) {
        // User profile - fetch lists and show selection
        const response = await fetch(
          `/api/mdblist/lists/user?apikey=${apiKey}&username=${encodeURIComponent(parsedUrl.username)}`
        );
        
        if (!response.ok) {
          if (response.status === 404) {
            throw new Error(`User "${parsedUrl.username}" not found or has no public lists`);
          }
          throw new Error(`Failed to fetch lists (Status: ${response.status})`);
        }

        const userLists = await response.json();
        if (!Array.isArray(userLists) || userLists.length === 0) {
          toast.info("No lists found", {
            description: `User "${parsedUrl.username}" has no public lists available`
          });
          return;
        }

        // Store raw list data for later use
        const listDataMap = new Map<string, any>();
        userLists.forEach((list: any) => {
          listDataMap.set(String(list.id), list);
        });
        setRawListData(listDataMap);

        // Convert to selectable items
        const selectableItems: SelectableItem[] = userLists.map((list: any) => ({
          id: String(list.id),
          name: list.name,
          type: getMdbListType(list),
          itemCount: list.items,
          author: list.user_name || parsedUrl.username,
        }));

        setItems(selectableItems);
        setStep('selection');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unknown error occurred';
      setError(message);
      toast.error("Error", { description: message });
    } finally {
      setIsLoading(false);
    }
  };

  // Import selected MDBList items
  const importSelectedMDBListItems = async () => {
    if (selectedItems.size === 0) {
      toast.error("Please select at least one list to import.");
      return;
    }

    setIsLoading(true);

    try {
      const listsToAdd: CatalogConfig[] = [];
      
      for (const itemId of selectedItems) {
        const catalogId = `mdblist.${itemId}`;
        if (catalogExists(catalogId)) continue;

        // Use raw list data if available, otherwise fall back to item data
        const rawList = rawListData.get(itemId);
        const item = items.find(i => i.id === itemId);
        
        if (!rawList && !item) continue;

        // Create catalog using raw list data for proper type detection
        const newCatalog = createMDBListCatalog({
          list: rawList || {
            id: itemId,
            name: item?.name,
            items: item?.itemCount,
            user_name: item?.author,
          },
          cacheTTL: catalogTTL,
          displayTypeOverrides: config.displayTypeOverrides,
        });

        listsToAdd.push(newCatalog);
      }

      if (listsToAdd.length > 0) {
        setConfig(prev => ({
          ...prev,
          catalogs: [...prev.catalogs, ...listsToAdd],
        }));

        toast.success("Lists imported successfully", {
          description: `${listsToAdd.length} list(s) added to your catalogs`
        });
      } else {
        toast.info("No new lists added", {
          description: "All selected lists are already in your catalogs"
        });
      }

      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unknown error occurred';
      toast.error("Error importing lists", { description: message });
    } finally {
      setIsLoading(false);
    }
  };

  // ============================================================================
  // Trakt Handler
  // ============================================================================
  const handleTrakt = async () => {
    if (!parsedUrl || parsedUrl.service !== 'trakt') return;

    setIsLoading(true);
    setError(null);

    try {
      if (parsedUrl.type === 'single-list' && parsedUrl.username && parsedUrl.listSlug) {
        // Single list - add directly
        const response = await fetch(
          `/api/trakt/users/${encodeURIComponent(parsedUrl.username)}/lists/${encodeURIComponent(parsedUrl.listSlug)}`
        );
        
        if (!response.ok) {
          throw new Error(`Failed to fetch list (Status: ${response.status})`);
        }

        const listData = await response.json();
        const numericListId = listData?.ids?.trakt;
        const catalogId = numericListId 
          ? `trakt.list.${numericListId}` 
          : `trakt.${parsedUrl.username}.${parsedUrl.listSlug}`;
        
        if (catalogExists(catalogId)) {
          toast.info(`List "${listData.name}" is already in your catalog list.`);
          onClose();
          return;
        }

        const newCatalog = createTraktCatalog({
          list: listData,
          username: parsedUrl.username,
          displayTypeOverrides: config.displayTypeOverrides,
        });

        setConfig(prev => ({
          ...prev,
          catalogs: [...prev.catalogs, newCatalog],
        }));

        toast.success("List Added", { 
          description: `The list "${listData.name}" has been added to your catalogs.` 
        });
        onClose();
        
      } else if (parsedUrl.type === 'user-profile' && parsedUrl.username) {
        // User profile - fetch lists and show selection
        const cacheKey = `trakt_user_lists_${parsedUrl.username}`;
        const userLists = await apiCache.cachedFetch(
          cacheKey,
          async () => {
            const response = await fetch(`/api/trakt/users/${encodeURIComponent(parsedUrl.username!)}/lists`);
            
            if (!response.ok) {
              if (response.status === 404) {
                throw new Error(`User "${parsedUrl.username}" not found or has no public lists`);
              }
              throw new Error(`Failed to fetch lists (Status: ${response.status})`);
            }

            return await response.json();
          },
          10 * 60 * 1000 // Cache for 10 minutes
        );

        if (!Array.isArray(userLists) || userLists.length === 0) {
          toast.info("No lists found", {
            description: `User "${parsedUrl.username}" has no public lists available`
          });
          return;
        }

        // Store raw list data for later use
        const listDataMap = new Map<string, any>();
        userLists.forEach((list: any) => {
          const listId = String(list.ids?.trakt || list.ids?.slug);
          listDataMap.set(listId, list);
        });
        setRawListData(listDataMap);

        // Convert to selectable items
        const selectableItems: SelectableItem[] = userLists.map((list: any) => ({
          id: String(list.ids?.trakt || list.ids?.slug),
          name: list.name,
          type: 'all' as const,
          itemCount: list.item_count,
          author: list.user?.username || parsedUrl.username,
        }));

        setItems(selectableItems);
        setStep('selection');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unknown error occurred';
      setError(message);
      toast.error("Error", { description: message });
    } finally {
      setIsLoading(false);
    }
  };

  // Import selected Trakt items
  const importSelectedTraktItems = async () => {
    if (selectedItems.size === 0) {
      toast.error("Please select at least one list to import.");
      return;
    }

    setIsLoading(true);

    try {
      const listsToAdd: CatalogConfig[] = [];
      
      for (const itemId of selectedItems) {
        const catalogId = `trakt.list.${itemId}`;
        if (catalogExists(catalogId)) continue;

        // Use raw list data if available
        const rawList = rawListData.get(itemId);
        const item = items.find(i => i.id === itemId);
        
        if (!rawList && !item) continue;

        const newCatalog = createTraktCatalog({
          list: rawList || {
            ids: { trakt: itemId },
            name: item?.name,
            item_count: item?.itemCount,
            user: { username: item?.author },
          },
          username: rawList?.user?.username || item?.author,
          displayTypeOverrides: config.displayTypeOverrides,
        });

        listsToAdd.push(newCatalog);
      }

      if (listsToAdd.length > 0) {
        setConfig(prev => ({
          ...prev,
          catalogs: [...prev.catalogs, ...listsToAdd],
        }));

        toast.success("Lists imported successfully", {
          description: `${listsToAdd.length} list(s) added to your catalogs`
        });
      } else {
        toast.info("No new lists added", {
          description: "All selected lists are already in your catalogs"
        });
      }

      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unknown error occurred';
      toast.error("Error importing lists", { description: message });
    } finally {
      setIsLoading(false);
    }
  };

  // ============================================================================
  // Letterboxd Handler
  // ============================================================================
  const handleLetterboxd = async () => {
    if (!parsedUrl || parsedUrl.service !== 'letterboxd') return;

    setIsLoading(true);
    setError(null);

    try {
      // Extract identifier from Letterboxd
      const extractResponse = await fetch('/api/letterboxd/extract-identifier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: parsedUrl.url })
      });

      if (!extractResponse.ok) {
        const error = await extractResponse.json();
        throw new Error(error.error || 'Failed to extract Letterboxd identifier');
      }

      const { identifier, isWatchlist } = await extractResponse.json();
      const catalogId = `letterboxd.${identifier}`;

      if (catalogExists(catalogId)) {
        toast.info("This Letterboxd list is already in your catalogs");
        onClose();
        return;
      }

      // Fetch list metadata from StremThru
      const listResponse = await fetch('/api/letterboxd/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, isWatchlist })
      });

      if (!listResponse.ok) {
        const error = await listResponse.json();
        throw new Error(error.error || 'Failed to fetch list from StremThru');
      }

      const listData = await listResponse.json();
      const listTitle = listData.data?.title || (isWatchlist ? 'Watchlist' : 'Letterboxd List');
      const itemCount = listData.data?.items?.length || 0;

      const newCatalog = createLetterboxdCatalog({
        identifier,
        title: listTitle,
        itemCount,
        isWatchlist,
        url: parsedUrl.url,
        cacheTTL: catalogTTL,
        displayTypeOverrides: config.displayTypeOverrides,
      });

      setConfig(prev => ({
        ...prev,
        catalogs: [...prev.catalogs, newCatalog]
      }));

      toast.success("List added successfully", {
        description: `${listTitle} with ${itemCount} items has been added to your catalogs`
      });

      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unknown error occurred';
      setError(message);
      toast.error("Error", { description: message });
    } finally {
      setIsLoading(false);
    }
  };

  // ============================================================================
  // Custom Manifest Handler
  // ============================================================================
  const handleManifest = async () => {
    if (!parsedUrl || parsedUrl.service !== 'manifest') return;

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(parsedUrl.url);
      if (!response.ok) {
        throw new Error(`Failed to fetch manifest (Status: ${response.status})`);
      }

      const manifestData = await response.json();
      
      if (!manifestData.catalogs || !Array.isArray(manifestData.catalogs)) {
        throw new Error("Invalid manifest format: missing catalogs array");
      }

      setManifest(manifestData);

      // Convert catalogs to selectable items
      const selectableItems: SelectableItem[] = manifestData.catalogs.map((catalog: any) => ({
        id: `${catalog.type}:${catalog.id}`,
        name: catalog.name,
        type: catalog.type as 'movie' | 'series',
      }));

      setItems(selectableItems);
      setStep('selection');

      toast.success("Manifest loaded successfully", {
        description: `Found ${manifestData.catalogs.length} available catalogs`
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unknown error occurred';
      setError(message);
      toast.error("Error", { description: message });
    } finally {
      setIsLoading(false);
    }
  };

  // Import selected manifest catalogs
  const importSelectedManifestCatalogs = async () => {
    if (selectedItems.size === 0 || !manifest || !parsedUrl) {
      toast.error("Please select at least one catalog to import.");
      return;
    }

    setIsLoading(true);

    try {
      const catalogsToAdd: CatalogConfig[] = [];
      
      for (const itemKey of selectedItems) {
        const colonIndex = itemKey.indexOf(':');
        const type = itemKey.substring(0, colonIndex);
        const id = itemKey.substring(colonIndex + 1);
        const catalog = manifest.catalogs.find((c: any) => c.type === type && c.id === id);
        
        if (!catalog) continue;

        const newCatalog = createCustomManifestCatalog({
          manifest,
          catalog,
          manifestUrl: parsedUrl.url,
          cacheTTL: catalogTTL,
          displayTypeOverrides: config.displayTypeOverrides,
        });

        if (!catalogExists(newCatalog.id)) {
          catalogsToAdd.push(newCatalog);
        }
      }

      if (catalogsToAdd.length > 0) {
        setConfig(prev => ({
          ...prev,
          catalogs: [...prev.catalogs, ...catalogsToAdd],
        }));

        toast.success("Catalogs imported successfully", {
          description: `${catalogsToAdd.length} catalog(s) added to your addon`
        });
      } else {
        toast.info("No new catalogs added", {
          description: "All selected catalogs are already in your addon"
        });
      }

      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unknown error occurred';
      toast.error("Error importing catalogs", { description: message });
    } finally {
      setIsLoading(false);
    }
  };

  // Main submit handler
  const handleSubmit = async () => {
    if (!parsedUrl || parsedUrl.service === 'unknown') return;

    switch (parsedUrl.service) {
      case 'mdblist':
        await handleMDBList();
        break;
      case 'trakt':
        await handleTrakt();
        break;
      case 'letterboxd':
        await handleLetterboxd();
        break;
      case 'manifest':
        await handleManifest();
        break;
    }
  };

  // Import selected items based on service
  const handleImportSelected = async () => {
    if (!parsedUrl) return;

    switch (parsedUrl.service) {
      case 'mdblist':
        await importSelectedMDBListItems();
        break;
      case 'trakt':
        await importSelectedTraktItems();
        break;
      case 'manifest':
        await importSelectedManifestCatalogs();
        break;
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            {parsedUrl && parsedUrl.service !== 'unknown' && getServiceIcon(parsedUrl.service) ? (
              <img 
                src={getServiceIcon(parsedUrl.service)!} 
                alt={getServiceDisplayName(parsedUrl.service)} 
                className="h-6 w-6 object-contain"
              />
            ) : (
              <Link className="h-6 w-6 text-muted-foreground" />
            )}
            <DialogTitle>Quick Add Catalog</DialogTitle>
          </div>
          <DialogDescription>
            Paste a URL to quickly add catalogs from MDBList, Trakt, Letterboxd, or custom manifests.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {step === 'input' && (
            <>
              {/* URL Input */}
              <div className="space-y-3">
                <Label htmlFor="quick-add-url">Paste URL</Label>
                <Input
                  id="quick-add-url"
                  placeholder="https://mdblist.com/lists/username/list-name"
                  value={url}
                  onChange={(e) => handleUrlChange(e.target.value)}
                  disabled={isLoading}
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-bwignore
                  data-form-type="other"
                />
                
                {/* Service Detection Badge */}
                {parsedUrl && parsedUrl.service !== 'unknown' && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Detected:</span>
                    <Badge variant={getServiceBadgeVariant(parsedUrl.service)}>
                      {getServiceDisplayName(parsedUrl.service)}
                    </Badge>
                    {parsedUrl.type === 'user-profile' && (
                      <Badge variant="outline">User Profile</Badge>
                    )}
                    {parsedUrl.type === 'single-list' && (
                      <Badge variant="outline">Single List</Badge>
                    )}
                    {parsedUrl.type === 'watchlist' && (
                      <Badge variant="outline">Watchlist</Badge>
                    )}
                  </div>
                )}

                {/* Error Message */}
                {error && (
                  <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
                    <AlertCircle className="h-5 w-5 text-destructive mt-0.5 flex-shrink-0" />
                    <p className="text-sm text-destructive">{error}</p>
                  </div>
                )}
              </div>

              {/* Supported URLs Info */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Supported URLs</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-xs text-muted-foreground">
                  <p><strong>MDBList:</strong> mdblist.com/lists/username/list-name or mdblist.com/users/username</p>
                  <p><strong>Trakt:</strong> trakt.tv/users/username/lists/list-slug or trakt.tv/users/username</p>
                  <p><strong>Letterboxd:</strong> letterboxd.com/username/list/list-name or letterboxd.com/username/watchlist</p>
                  <p><strong>Custom Manifest:</strong> Any URL ending with /manifest.json</p>
                </CardContent>
              </Card>

              {/* Submit Button */}
              <Button
                onClick={handleSubmit}
                disabled={!parsedUrl || parsedUrl.service === 'unknown' || isLoading || !url.trim()}
                className="w-full"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <Plus className="mr-2 h-4 w-4" />
                    {parsedUrl?.type === 'single-list' || parsedUrl?.type === 'watchlist' 
                      ? 'Add Catalog' 
                      : 'Load Catalogs'}
                  </>
                )}
              </Button>
            </>
          )}

          {step === 'selection' && (
            <>
              {/* Back button */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setStep('input');
                  setItems([]);
                  setSelectedItems(new Set());
                  setSearchFilter('');
                  setManifest(null);
                }}
              >
                ← Back to URL input
              </Button>

              {/* Selection Header */}
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium">Select items to import</h3>
                  <p className="text-sm text-muted-foreground">
                    {selectedItems.size} of {items.length} selected
                  </p>
                </div>
                <div className="flex items-center space-x-2">
                  <Switch
                    id="select-all"
                    checked={selectedItems.size === items.length && items.length > 0}
                    onCheckedChange={handleSelectAll}
                  />
                  <Label htmlFor="select-all" className="text-sm cursor-pointer">
                    Select all
                  </Label>
                </div>
              </div>

              {/* Search Filter */}
              {items.length > 5 && (
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Filter lists..."
                    value={searchFilter}
                    onChange={(e) => setSearchFilter(e.target.value)}
                    className="pl-9"
                  />
                </div>
              )}

              {/* Items List */}
              <div className="space-y-2 max-h-60 overflow-y-auto border rounded-lg p-2">
                {filteredItems.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No lists match "{searchFilter}"
                  </p>
                ) : (
                  filteredItems.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center space-x-3 p-3 border rounded-lg hover:bg-muted/50"
                    >
                      <Switch
                        id={`item-${item.id}`}
                        checked={selectedItems.has(item.id)}
                        onCheckedChange={(checked) => handleItemSelection(item.id, checked)}
                      />
                      <div className="flex-1 min-w-0">
                        <Label htmlFor={`item-${item.id}`} className="font-medium cursor-pointer">
                          {item.name}
                        </Label>
                        <div className="flex items-center gap-2 mt-1">
                          {item.type && (
                            <Badge variant="outline" className="text-xs capitalize">
                              {item.type}
                            </Badge>
                          )}
                          {item.itemCount !== undefined && (
                            <span className="text-xs text-muted-foreground">
                              {item.itemCount} items
                            </span>
                          )}
                          {item.author && (
                            <span className="text-xs text-muted-foreground">
                              by {item.author}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Import Button */}
              <Button
                onClick={handleImportSelected}
                disabled={selectedItems.size === 0 || isLoading}
                className="w-full"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Importing...
                  </>
                ) : (
                  <>
                    <Plus className="mr-2 h-4 w-4" />
                    Import {selectedItems.size} Selected
                  </>
                )}
              </Button>
            </>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
