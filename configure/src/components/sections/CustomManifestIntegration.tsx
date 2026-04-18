import React, { useState, useCallback } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Loader2, ExternalLink, Plus, Trash2, Link as LinkIcon } from 'lucide-react';
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { createCustomManifestCatalog } from '@/utils/catalogUtils';

interface CustomManifestIntegrationProps {
  isOpen: boolean;
  onClose: () => void;
}

interface CustomCatalog {
  type: string;
  id: string;
  name: string;
  genres?: string[];
  extra?: any[];
}

interface CustomManifest {
  id: string;
  name: string;
  description: string;
  catalogs: CustomCatalog[];
  idPrefixes?: string[];
}

export function CustomManifestIntegration({ isOpen, onClose }: CustomManifestIntegrationProps) {
  const { config, setConfig, catalogTTL } = useConfig();
  const [manifestUrl, setManifestUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [manifest, setManifest] = useState<CustomManifest | null>(null);
  const [selectedCatalogs, setSelectedCatalogs] = useState<Set<string>>(new Set());
  const [defaultCacheTTL, setDefaultCacheTTL] = useState<number>(catalogTTL);
  const [defaultPageSize, setDefaultPageSize] = useState<number>(100);
  const [detectedPageSize, setDetectedPageSize] = useState<number | null>(null);
  const [isDetectingPageSize, setIsDetectingPageSize] = useState<boolean>(false);

  // Get currently imported custom manifests
  const currentCustomCatalogs = config.catalogs.filter(c => c.id.startsWith("custom."));
  
  const isInternalDockerUrl = (url: string): boolean => {
    try {
      const urlObj = new URL(url);
      // Check for internal Docker network patterns:
      // - http:// (not https) with service name (no dots before port)
      // - localhost
      // - 127.0.0.1
      // - Internal network IPs (10.x, 172.16-31.x, 192.168.x)
      const hostname = urlObj.hostname;
      const isHttp = urlObj.protocol === 'http:';
      const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
      const isInternalIP = /^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(hostname);
      const isServiceName = isHttp && !hostname.includes('.') && hostname !== 'localhost';
      
      return isLocalhost || isInternalIP || isServiceName;
    } catch {
      return false;
    }
  };

  const fetchManifest = useCallback(async () => {
    if (!manifestUrl.trim()) {
      toast.error("Please enter a manifest URL.");
      return;
    }

    setIsLoading(true);
    try {
      const useProxy = isInternalDockerUrl(manifestUrl);
      const fetchUrl = useProxy 
        ? `/api/proxy-manifest?url=${encodeURIComponent(manifestUrl)}`
        : manifestUrl;

      const response = await fetch(fetchUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch manifest (Status: ${response.status})`);
      }

      const manifestData: CustomManifest = await response.json();
      
      if (!manifestData.catalogs || !Array.isArray(manifestData.catalogs)) {
        throw new Error("Invalid manifest format: missing catalogs array");
      }

      setManifest(manifestData);
      setSelectedCatalogs(new Set()); // Reset selection
      setDetectedPageSize(null); // Reset detected page size
      setDefaultPageSize(100); // Reset to default
      toast.success("Manifest loaded successfully", {
        description: `Found ${manifestData.catalogs.length} available catalogs`
      });

    } catch (error) {
      console.error("Error fetching custom manifest:", error);
      toast.error("Failed to load manifest", {
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
      setManifest(null);
    } finally {
      setIsLoading(false);
    }
  }, [manifestUrl]);

  const getCatalogKey = (catalog: CustomCatalog) => {
    return `${catalog.type}:${catalog.id}`;
  };

  const handleCatalogSelection = async (catalogKey: string, checked: boolean) => {
    const newSelection = new Set(selectedCatalogs);
    if (checked) {
      newSelection.add(catalogKey);
    } else {
      newSelection.delete(catalogKey);
    }
    setSelectedCatalogs(newSelection);

    // Auto-detect page size when first catalog is selected
    if (checked && newSelection.size === 1 && manifest && !detectedPageSize) {
      await detectPageSizeForCatalogs(newSelection);
    }
  };

  const detectPageSizeForCatalogs = async (catalogKeys: Set<string>) => {
    if (!manifest || catalogKeys.size === 0) return;

    setIsDetectingPageSize(true);
    try {
      // Try to detect page size from the first selected catalog
      const firstCatalogKey = Array.from(catalogKeys)[0];
      const colonIndex = firstCatalogKey.indexOf(':');
      const type = firstCatalogKey.substring(0, colonIndex);
      const id = firstCatalogKey.substring(colonIndex + 1);
      const catalog = manifest.catalogs.find(c => c.type === type && c.id === id);
      
      if (!catalog) {
        setIsDetectingPageSize(false);
        return;
      }

      // Construct the catalog URL
      const encodedCatalogId = encodeURIComponent(catalog.id);
      const catalogUrl = `${manifestUrl.replace('/manifest.json', '')}/catalog/${catalog.type}/${encodedCatalogId}.json`;
      
      // Use proxy for internal Docker URLs
      const useProxy = isInternalDockerUrl(catalogUrl);
      const detectUrl = useProxy
        ? `/api/detect-page-size?catalogUrl=${encodeURIComponent(catalogUrl)}`
        : `/api/detect-page-size?catalogUrl=${encodeURIComponent(catalogUrl)}`;

      const response = await fetch(detectUrl);
      if (!response.ok) {
        throw new Error(`Failed to detect page size (Status: ${response.status})`);
      }

      const result = await response.json();
      if (result.detected && result.pageSize) {
        setDetectedPageSize(result.pageSize);
        setDefaultPageSize(result.pageSize);
        toast.success("Page size auto-detected", {
          description: `Detected page size: ${result.pageSize} items per page`
        });
      } else {
        toast.info("Could not auto-detect page size", {
          description: "Using default page size of 100. You can adjust it manually."
        });
      }
    } catch (error) {
      console.error("Error detecting page size:", error);
      toast.info("Could not auto-detect page size", {
        description: "Using default page size of 100. You can adjust it manually."
      });
    } finally {
      setIsDetectingPageSize(false);
    }
  };

  const importSelectedCatalogs = useCallback(async () => {
    if (!manifest || selectedCatalogs.size === 0) {
      toast.error("Please select at least one catalog to import.");
      return;
    }

    try {
      setConfig(prev => {
        let newCatalogs = [...prev.catalogs];
        let newCatalogsAdded = 0;

        // Process each selected catalog
        selectedCatalogs.forEach(catalogKey => {
          // Parse the catalog key back into type and id (split only on first colon)
          const colonIndex = catalogKey.indexOf(':');
          const type = catalogKey.substring(0, colonIndex);
          const id = catalogKey.substring(colonIndex + 1);
          const catalog = manifest.catalogs.find(c => c.type === type && c.id === id);
          if (!catalog) return;

          // Generate unique catalog ID: custom.{manifestId}.{type}.{catalogId}
          const manifestId = manifest.id.replace(/[^a-zA-Z0-9]/g, '_');
          const uniqueCatalogId = `custom.${manifestId}.${catalog.type}.${catalog.id.replace(/[^a-zA-Z0-9]/g, '_')}`;
          
          // Check if catalog already exists
          const existingCatalog = newCatalogs.find(c => c.id === uniqueCatalogId);
          
          if (!existingCatalog) {
            const newCatalog = createCustomManifestCatalog({
              manifest,
              catalog,
              manifestUrl,
              cacheTTL: defaultCacheTTL,
              pageSize: defaultPageSize,
              displayTypeOverrides: prev.displayTypeOverrides,
            });
            newCatalogs.push(newCatalog);
            newCatalogsAdded++;
          }
        });

        return {
          ...prev,
          catalogs: newCatalogs,
        };
      });

      toast.success("Catalogs imported successfully", {
        description: `${selectedCatalogs.size} catalog(s) added to your addon`
      });

      // Reset state
      setManifest(null);
      setSelectedCatalogs(new Set());
      setManifestUrl("");
      
      // Close dialog
      onClose();

    } catch (error) {
      console.error("Error importing custom catalogs:", error);
      toast.error("Failed to import catalogs", {
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
    }
  }, [manifest, selectedCatalogs, setConfig, manifestUrl, onClose, defaultCacheTTL, defaultPageSize]);

  const removeCustomCatalog = (catalogId: string) => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.filter(c => c.id !== catalogId)
    }));
    toast.success("Catalog removed", {
      description: "The custom catalog has been removed from your addon"
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LinkIcon className="w-6 h-6" />
            Custom Manifest Integration
          </DialogTitle>
          <DialogDescription>
            Import catalogs from any Stremio-compatible manifest URL to expand your content library.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Import New Manifest */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Plus className="w-5 h-5" />
                Import New Manifest
              </CardTitle>
              <CardDescription>
                Enter any Stremio-compatible manifest URL to see available catalogs
                <br />
                <span className="text-xs text-muted-foreground mt-1">
                  Supported ID prefixes: tmdb:, tt, tvdb:, mal:, tvmaze:, kitsu:, anidb:, anilist:, tvdbc:, tun_
                </span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  placeholder="https://example.com/manifest.json"
                  value={manifestUrl}
                  onChange={(e) => setManifestUrl(e.target.value)}
                  disabled={isLoading}
                  className="min-w-0"
                />
                <Button onClick={fetchManifest} disabled={isLoading || !manifestUrl.trim()} className="w-full sm:w-auto shrink-0">
                  {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Load Manifest"}
                </Button>
              </div>

              {/* TTL Configuration */}
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
                  How long to cache newly added catalogs before refreshing. Range: 5 minutes to 7 days.
                </p>
              </div>

              {/* Page Size Configuration */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="default-page-size">Default Page Size</Label>
                  {selectedCatalogs.size > 0 && !detectedPageSize && !isDetectingPageSize && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => detectPageSizeForCatalogs(selectedCatalogs)}
                      className="h-7 text-xs"
                    >
                      Auto-detect
                    </Button>
                  )}
                  {isDetectingPageSize && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Detecting...
                    </span>
                  )}
                  {detectedPageSize && !isDetectingPageSize && (
                    <span className="text-xs text-green-600 dark:text-green-400 font-medium">
                      ✓ Auto-detected: {detectedPageSize}
                    </span>
                  )}
                </div>
                <div className="flex items-center space-x-2">
                  <input
                    id="default-page-size"
                    type="number"
                    value={defaultPageSize}
                    onChange={(e) => {
                      const newValue = parseInt(e.target.value) || 100;
                      setDefaultPageSize(newValue);
                      // Clear detected value if user manually changes it
                      if (detectedPageSize && newValue !== detectedPageSize) {
                        setDetectedPageSize(null);
                      }
                    }}
                    min="1"
                    max="1000"
                    step="1"
                    className={`flex-1 px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent ${
                      detectedPageSize ? 'border-green-500/50 bg-green-50/50 dark:bg-green-950/20' : 'border-input bg-background'
                    }`}
                    placeholder="100"
                    disabled={isDetectingPageSize}
                  />
                  {detectedPageSize && defaultPageSize === detectedPageSize && (
                    <span className="text-xs text-green-600 dark:text-green-400">✓</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Expected items returned per page by the external addon (default 100). {detectedPageSize ? 'Auto-detected from the selected catalog. ' : 'Click "Auto-detect" after selecting catalogs to automatically determine the page size. For best results, select a catalog with the most items. '}Match the source addon's pagination so we request the right pages—this does not change our AIOMetadata catalogs page size.
                </p>
              </div>

              {/* Manifest Info */}
              {manifest && (
                <div className="border rounded-lg p-4 bg-muted/50">
                  <h4 className="font-semibold mb-2">{manifest.name}</h4>
                  <p className="text-sm text-muted-foreground mb-3">{manifest.description}</p>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{manifest.catalogs.length} catalogs available</Badge>
                    <Button variant="outline" size="sm" onClick={() => window.open(manifestUrl, '_blank')}>
                      <ExternalLink className="w-4 h-4 mr-1" />
                      View Manifest
                    </Button>
                  </div>
                </div>
              )}

              {/* Available Catalogs */}
              {manifest && (
                <div className="space-y-3">
                  <h4 className="font-medium">Select catalogs to import:</h4>
                  
                  {/* Select All Switch */}
                  <div className="flex items-center space-x-3 p-3 border rounded-lg bg-muted/30">
                    <Switch
                      id="select-all"
                      checked={selectedCatalogs.size === manifest.catalogs.length && manifest.catalogs.length > 0}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setSelectedCatalogs(new Set(manifest.catalogs.map(c => getCatalogKey(c))));
                        } else {
                          setSelectedCatalogs(new Set());
                        }
                      }}
                    />
                    <Label htmlFor="select-all" className="font-medium cursor-pointer">
                      Select all catalogs
                    </Label>
                    <Badge variant="outline" className="ml-auto">
                      {selectedCatalogs.size}/{manifest.catalogs.length}
                    </Badge>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-60 overflow-y-auto">
                    {manifest.catalogs.map((catalog) => {
                      const catalogKey = getCatalogKey(catalog);
                      return (
                        <div key={catalogKey} className="flex items-start space-x-3 p-3 border rounded-lg">
                          <Switch
                            id={catalogKey}
                            checked={selectedCatalogs.has(catalogKey)}
                            onCheckedChange={(checked) => handleCatalogSelection(catalogKey, checked)}
                          />
                          <div className="flex-1 min-w-0">
                            <Label htmlFor={catalogKey} className="font-medium cursor-pointer">
                              {catalog.name}
                            </Label>
                            <div className="flex flex-wrap items-center gap-2 mt-1">
                              <Badge variant="outline" className="text-xs capitalize">
                                {catalog.type}
                              </Badge>
                              {catalog.genres && catalog.genres.length > 0 && (
                                <Badge variant="secondary" className="text-xs">
                                  {catalog.genres.length} genres
                                </Badge>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  
                  {selectedCatalogs.size > 0 && (
                    <Button 
                      onClick={importSelectedCatalogs} 
                      className="w-full"
                      disabled={selectedCatalogs.size === 0}
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      Import {selectedCatalogs.size} Selected Catalog{selectedCatalogs.size !== 1 ? 's' : ''}
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Currently Imported Catalogs */}
          {currentCustomCatalogs.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Imported Custom Catalogs</CardTitle>
                <CardDescription>
                  Manage your currently imported custom manifest catalogs
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {currentCustomCatalogs.map((catalog) => (
                    <div key={catalog.id} className="flex items-center justify-between p-3 border rounded-lg">
                      <div>
                        <h4 className="font-medium">{catalog.name}</h4>
                        <div className="flex flex-wrap items-center gap-2 mt-1">
                          <Badge variant="outline" className="text-xs capitalize">
                            {catalog.type}
                          </Badge>
                          <Badge variant="secondary" className="text-xs">
                            {catalog.enabled ? 'Enabled' : 'Disabled'}
                          </Badge>
                          {catalog.showInHome && (
                            <Badge variant="default" className="text-xs">
                              Home
                            </Badge>
                          )}
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => removeCustomCatalog(catalog.id)}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="w-4 h-4 mr-1" />
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Help Section */}
          <Card>
            <CardHeader>
              <CardTitle>How to use Custom Manifests</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                1. Find a Stremio-compatible manifest URL (from addon repositories or communities)
              </p>
              <p>
                2. Paste the manifest URL above and click "Load Manifest"
              </p>
              <p>
                3. Select the catalogs you want to import from the available options
              </p>
              <p>
                4. Click "Import Selected Catalogs" to add them to your addon
              </p>
              <p>
                5. The imported catalogs will appear in your Catalogs settings where you can enable/disable them
              </p>
              <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                <p className="text-blue-800 dark:text-blue-200 font-medium">
                  <strong>Note:</strong> This feature supports any Stremio-compatible manifest that includes catalog definitions.
                </p>
              </div>
            </CardContent>
          </Card>
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
