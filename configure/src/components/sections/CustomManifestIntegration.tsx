import React, { useState, useCallback } from 'react';
import { useConfig, CatalogConfig } from '@/contexts/ConfigContext';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Loader2, ExternalLink, Plus, Trash2, Link as LinkIcon } from 'lucide-react';
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";

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
}

export function CustomManifestIntegration({ isOpen, onClose }: CustomManifestIntegrationProps) {
  const { config, setConfig } = useConfig();
  const [manifestUrl, setManifestUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [manifest, setManifest] = useState<CustomManifest | null>(null);
  const [selectedCatalogs, setSelectedCatalogs] = useState<Set<string>>(new Set());

  // Get currently imported custom manifests
  const currentCustomCatalogs = config.catalogs.filter(c => c.id.startsWith("custom."));
  
  const fetchManifest = useCallback(async () => {
    if (!manifestUrl.trim()) {
      toast.error("Please enter a manifest URL.");
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(manifestUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch manifest (Status: ${response.status})`);
      }

      const manifestData: CustomManifest = await response.json();
      
      if (!manifestData.catalogs || !Array.isArray(manifestData.catalogs)) {
        throw new Error("Invalid manifest format: missing catalogs array");
      }

      setManifest(manifestData);
      setSelectedCatalogs(new Set()); // Reset selection
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

  const handleCatalogSelection = (catalogKey: string, checked: boolean) => {
    const newSelection = new Set(selectedCatalogs);
    if (checked) {
      newSelection.add(catalogKey);
    } else {
      newSelection.delete(catalogKey);
    }
    setSelectedCatalogs(newSelection);
  };

  const importSelectedCatalogs = useCallback(async () => {
    if (!manifest || selectedCatalogs.size === 0) {
      toast.error("Please select at least one catalog to import.");
      return;
    }

    try {
      setConfig(prev => {
        const otherCatalogs = prev.catalogs.filter(c => !c.id.startsWith("custom."));
        
        let newCatalogs = [...otherCatalogs, ...currentCustomCatalogs];
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
            // Construct the full catalog URL with proper encoding
            const encodedCatalogId = encodeURIComponent(catalog.id);
            const catalogUrl = `${manifestUrl.replace('/manifest.json', '')}/catalog/${catalog.type}/${encodedCatalogId}.json`;
            
            // Debug logging
            console.log('Debug - manifestUrl:', manifestUrl);
            console.log('Debug - catalog.type:', catalog.type);
            console.log('Debug - catalog.id:', catalog.id);
            console.log('Debug - constructed catalogUrl:', catalogUrl);
            
            // Add new catalog
            const catalogType = catalog.type as 'movie' | 'series' | 'anime';
            
            // Apply display type overrides if configured
            let displayType = undefined;
            if (prev.displayTypeOverrides) {
              if (catalogType === 'movie' && prev.displayTypeOverrides.movie) {
                displayType = prev.displayTypeOverrides.movie;
              } else if (catalogType === 'series' && prev.displayTypeOverrides.series) {
                displayType = prev.displayTypeOverrides.series;
              }
            }
            
            const newCatalog: CatalogConfig = {
              id: uniqueCatalogId,
              type: catalogType,
              name: catalog.name,
              enabled: true,
              showInHome: true,
              source: 'custom', // Use 'custom' source for custom manifests
              sourceUrl: catalogUrl, // Store the actual catalog URL
              genres: catalog.genres || [], // Store genres from manifest
              manifestData: catalog, // Store full manifest data for advanced features
              ...(displayType && { displayType }), // Include displayType if defined
            };
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
  }, [manifest, selectedCatalogs, setConfig, manifestUrl, onClose, currentCustomCatalogs]);

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
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="https://example.com/manifest.json"
                  value={manifestUrl}
                  onChange={(e) => setManifestUrl(e.target.value)}
                  disabled={isLoading}
                />
                <Button onClick={fetchManifest} disabled={isLoading || !manifestUrl.trim()}>
                  {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Load Manifest"}
                </Button>
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
                            <div className="flex items-center gap-2 mt-1">
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
                        <div className="flex items-center gap-2 mt-1">
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
