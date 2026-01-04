import React, { useState, useCallback } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Loader2, ExternalLink, AlertCircle } from 'lucide-react';
import { toast } from "sonner";
import { createLetterboxdCatalog } from '@/utils/catalogUtils';

interface LetterboxdIntegrationProps {
  isOpen: boolean;
  onClose: () => void;
}

export function LetterboxdIntegration({ isOpen, onClose }: LetterboxdIntegrationProps) {
  const { config, setConfig, catalogTTL } = useConfig();
  const [listUrl, setListUrl] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [defaultCacheTTL, setDefaultCacheTTL] = useState<number>(catalogTTL);

  const validateUrl = (url: string): { valid: boolean; isWatchlist: boolean; error?: string } => {
    try {
      const urlObj = new URL(url);
      
      if (!urlObj.hostname.includes('letterboxd.com')) {
        return { valid: false, isWatchlist: false, error: 'Not a Letterboxd URL' };
      }

      const pathParts = urlObj.pathname.split('/').filter(Boolean);

      // Check if it's a watchlist
      if (pathParts.length >= 2 && pathParts[1] === 'watchlist') {
        return { valid: true, isWatchlist: true };
      }

      // Check if it's a regular list
      if (pathParts.length >= 3 && pathParts[1] === 'list') {
        return { valid: true, isWatchlist: false };
      }

      return { valid: false, isWatchlist: false, error: 'Invalid Letterboxd URL format. Expected list or watchlist URL.' };
    } catch (error) {
      return { valid: false, isWatchlist: false, error: 'Invalid URL' };
    }
  };

  const handleAddList = useCallback(async () => {
    if (!listUrl.trim()) {
      toast.error("Please enter a Letterboxd URL");
      return;
    }

    const validation = validateUrl(listUrl);
    if (!validation.valid) {
      toast.error("Invalid URL", {
        description: validation.error || "Please enter a valid Letterboxd list or watchlist URL"
      });
      return;
    }

    setIsProcessing(true);

    try {
      // Step 1: Extract identifier from Letterboxd
      const extractResponse = await fetch('/api/letterboxd/extract-identifier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: listUrl })
      });

      if (!extractResponse.ok) {
        const error = await extractResponse.json();
        throw new Error(error.error || 'Failed to extract Letterboxd identifier');
      }

      const { identifier, isWatchlist } = await extractResponse.json();

      // Step 2: Fetch list metadata from StremThru
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

      // Step 3: Create catalog
      const catalogId = `letterboxd.${identifier}`;

      // Check if catalog already exists
      if (config.catalogs.some(c => c.id === catalogId)) {
        toast.error("List already added", {
          description: "This Letterboxd list is already in your catalogs"
        });
        setIsProcessing(false);
        return;
      }

      const newCatalog = createLetterboxdCatalog({
        identifier,
        title: listTitle,
        itemCount,
        isWatchlist,
        url: listUrl,
        cacheTTL: defaultCacheTTL,
        displayTypeOverrides: config.displayTypeOverrides,
      });

      setConfig(prev => ({
        ...prev,
        catalogs: [...prev.catalogs, newCatalog]
      }));

      toast.success("List added successfully", {
        description: `${listTitle} with ${itemCount} items has been added to your catalogs`
      });

      setListUrl("");
    } catch (error: any) {
      console.error("Error adding Letterboxd list:", error);
      toast.error("Failed to add list", {
        description: error.message || "An error occurred while adding the list"
      });
    } finally {
      setIsProcessing(false);
    }
  }, [listUrl, config, setConfig, defaultCacheTTL]);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <img 
              src="https://a.ltrbxd.com/logos/letterboxd-logo-h-pos-rgb-1000px.png" 
              alt="Letterboxd Logo" 
              className="h-6 w-auto" 
            />
            <DialogTitle>Letterboxd Integration</DialogTitle>
          </div>
          <DialogDescription>
            Import your Letterboxd lists and watchlists as catalogs via StremThru
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Information Alert */}
          <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg">
            <AlertCircle className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-blue-800 dark:text-blue-200">
              This integration uses <strong>StremThru</strong> as an intermediary to access Letterboxd data.
              StremThru has a developer account with Letterboxd to provide this functionality.
            </p>
          </div>

          {/* Add List Section */}
          <Card>
            <CardHeader>
              <CardTitle>Add Letterboxd List</CardTitle>
              <CardDescription>
                Import a Letterboxd list or watchlist by entering its URL
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="letterboxd-url">Letterboxd URL</Label>
                <Input
                  id="letterboxd-url"
                  placeholder="https://letterboxd.com/dave/list/official-top-250-narrative-feature-films"
                  value={listUrl}
                  onChange={(e) => setListUrl(e.target.value)}
                  disabled={isProcessing}
                />
                <p className="text-xs text-muted-foreground">
                  Supported formats:
                </p>
                <ul className="text-xs text-muted-foreground list-disc list-inside space-y-1">
                  <li>Regular list: https://letterboxd.com/username/list/list-name</li>
                  <li>Watchlist: https://letterboxd.com/username/watchlist/</li>
                </ul>
              </div>

              <div className="space-y-2">
                <Label htmlFor="cache-ttl">Cache TTL (seconds)</Label>
                <div className="flex items-center space-x-2">
                  <input
                    id="cache-ttl"
                    type="number"
                    value={defaultCacheTTL}
                    onChange={(e) => setDefaultCacheTTL(parseInt(e.target.value) || catalogTTL)}
                    min="7200"
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
                  How long to cache the list before refreshing. Range: 2 hours to 7 days.
                </p>
              </div>

              <Button
                onClick={handleAddList}
                disabled={!listUrl.trim() || isProcessing}
                className="w-full"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Processing...
                  </>
                ) : (
                  "Add List"
                )}
              </Button>
            </CardContent>
          </Card>

          {/* How it works */}
          <Card>
            <CardHeader>
              <CardTitle>How It Works</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                <strong>1. Enter URL:</strong> Paste a Letterboxd list or watchlist URL
              </p>
              <p>
                <strong>2. Extract Identifier:</strong> The system requests the URL with JSON headers to extract the x-letterboxd-identifier
              </p>
              <p>
                <strong>3. Fetch via StremThru:</strong> The identifier is used to fetch list data from StremThru's API, which includes IMDB/TMDB IDs
              </p>
              <p>
                <strong>4. Create Catalog:</strong> A new catalog is created in your configuration with all the movies from the list
              </p>
              <div className="pt-2 border-t">
                <a
                  href="https://stremthru.13377001.xyz"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  Learn more about StremThru
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </CardContent>
          </Card>

          {/* Existing Letterboxd Catalogs */}
          {config.catalogs.filter(c => c.source === 'letterboxd').length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Your Letterboxd Lists</CardTitle>
                <CardDescription>
                  {config.catalogs.filter(c => c.source === 'letterboxd').length} list(s) imported
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {config.catalogs
                    .filter(c => c.source === 'letterboxd')
                    .map(catalog => (
                      <div
                        key={catalog.id}
                        className="flex items-center justify-between p-3 border rounded-lg bg-muted/30"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-medium">{catalog.name}</div>
                          {catalog.metadata?.itemCount && (
                            <div className="text-xs text-muted-foreground">
                              {catalog.metadata.itemCount} items
                            </div>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setConfig(prev => ({
                              ...prev,
                              catalogs: prev.catalogs.filter(c => c.id !== catalog.id)
                            }));
                            toast.success("List removed");
                          }}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

