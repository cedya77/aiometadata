import React, { useState, useCallback } from 'react';
import { useConfig, CatalogConfig } from '@/contexts/ConfigContext';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Loader2, ExternalLink, Plus, Trash2, Pencil } from 'lucide-react';
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface StremThruIntegrationProps {
  isOpen: boolean;
  onClose: () => void;
}

interface StremThruCatalog {
  type: string;
  id: string;
  name: string;
  genres?: string[];
  extra?: any[];
}

interface StremThruManifest {
  id: string;
  name: string;
  description: string;
  catalogs: StremThruCatalog[];
}

export function StremThruIntegration({ isOpen, onClose }: StremThruIntegrationProps) {
  const { config, setConfig } = useConfig();
  const [manifestUrl, setManifestUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [manifest, setManifest] = useState<StremThruManifest | null>(null);
  const [selectedCatalogs, setSelectedCatalogs] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<'movie' | 'series' | 'anime'>('movie');

  const currentStremThruCatalogs = config.catalogs.filter(c => c.id.startsWith("stremthru."));

  const fetchManifest = useCallback(async () => {
    if (!manifestUrl.trim()) {
      toast.error("Please enter a StremThru manifest URL.");
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(manifestUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch manifest (Status: ${response.status})`);
      }

      const manifestData: StremThruManifest = await response.json();
      
      if (!manifestData.catalogs || !Array.isArray(manifestData.catalogs)) {
        throw new Error("Invalid manifest format: missing catalogs array");
      }

      setManifest(manifestData);
      setSelectedCatalogs(new Set()); // Reset selection
      toast.success("Manifest loaded successfully", {
        description: `Found ${manifestData.catalogs.length} available catalogs`
      });

    } catch (error) {
      console.error("Error fetching StremThru manifest:", error);
      toast.error("Failed to load manifest", {
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
      setManifest(null);
    } finally {
      setIsLoading(false);
    }
  }, [manifestUrl]);

  const handleCatalogSelection = (catalogId: string, checked: boolean) => {
    const newSelection = new Set(selectedCatalogs);
    if (checked) {
      newSelection.add(catalogId);
    } else {
      newSelection.delete(catalogId);
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
        const manifestId = manifest.id.replace(/[^a-zA-Z0-9]/g, '_');

        // Multi-manifest support: Only remove catalogs from THIS manifest, keep all others
        const catalogsFromOtherManifests = prev.catalogs.filter(c =>
          !c.id.startsWith(`stremthru.${manifestId}.`)
        );

        const newCatalogs = [...catalogsFromOtherManifests];

        // Process each selected catalog
        selectedCatalogs.forEach(catalogId => {
          const catalog = manifest.catalogs.find(c => c.id === catalogId);
          if (!catalog) return;

          const uniqueCatalogId = `stremthru.${manifestId}.${catalog.id.replace(/[^a-zA-Z0-9]/g, '_')}`;
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
            const newCatalog: CatalogConfig = {
              id: uniqueCatalogId,
              type: catalog.type as 'movie' | 'series' | 'anime',
              name: catalog.name,
              enabled: true,
              showInHome: true,
              source: 'stremthru', // Keep source as the display label
              sourceUrl: catalogUrl, // Store the actual catalog URL
              genres: catalog.genres || [], // Store genres from manifest
              manifestData: catalog, // Store full manifest data for advanced features
              manifestUrl: manifestUrl,
              manifestId: manifestId,
              manifestName: manifest.name,
            };
            newCatalogs.push(newCatalog);
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

    } catch (error) {
      console.error("Error importing StremThru catalogs:", error);
      toast.error("Failed to import catalogs", {
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
    }
  }, [manifest, selectedCatalogs, setConfig, manifestUrl]);

  const removeStremThruCatalog = (catalogId: string) => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.filter(c => c.id !== catalogId)
    }));
    toast.success("Catalog removed", {
      description: "The StremThru catalog has been removed from your addon"
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <img 
              src="https://emojiapi.dev/api/v1/sparkles/256.png" 
              alt="StremThru" 
              className="w-6 h-6"
            />
            StremThru Integration
          </DialogTitle>
          <DialogDescription>
            Import catalogs from StremThru to expand your content library with curated lists from Trakt, AniList, and more.
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
                Enter a StremThru manifest URL to see available catalogs
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="https://stremthru.elfhosted.com/stremio/list/.../manifest.json"
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
                          setSelectedCatalogs(new Set(manifest.catalogs.map(c => c.id)));
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
                                         {manifest.catalogs.map((catalog) => (
                       <div key={catalog.id} className="flex items-start space-x-3 p-3 border rounded-lg">
                         <Switch
                           id={catalog.id}
                           checked={selectedCatalogs.has(catalog.id)}
                           onCheckedChange={(checked) => handleCatalogSelection(catalog.id, checked)}
                         />
                         <div className="flex-1 min-w-0">
                           <Label htmlFor={catalog.id} className="font-medium cursor-pointer">
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
                     ))}
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
          {currentStremThruCatalogs.length > 0 && (() => {
            const catalogsByManifest = currentStremThruCatalogs.reduce((acc, catalog) => {
              const manifestKey = catalog.manifestId || 'unknown';
              if (!acc[manifestKey]) {
                acc[manifestKey] = {
                  manifestName: catalog.manifestName || 'Unknown Manifest',
                  manifestUrl: catalog.manifestUrl,
                  catalogs: []
                };
              }
              acc[manifestKey].catalogs.push(catalog);
              return acc;
            }, {} as Record<string, { manifestName: string; manifestUrl?: string; catalogs: typeof currentStremThruCatalogs }>);

            return (
              <Card>
                <CardHeader>
                  <CardTitle>Imported StremThru Catalogs</CardTitle>
                  <CardDescription>
                    Manage your currently imported StremThru catalogs ({Object.keys(catalogsByManifest).length} manifest{Object.keys(catalogsByManifest).length !== 1 ? 's' : ''})
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {Object.entries(catalogsByManifest).map(([manifestId, { manifestName, manifestUrl, catalogs }]) => (
                    <div key={manifestId} className="border rounded-lg p-4 space-y-3">
                      <div className="flex items-start justify-between pb-2 border-b">
                        <div>
                          <h4 className="font-semibold">{manifestName}</h4>
                          {manifestUrl && (
                            <a
                              href={manifestUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 mt-1"
                            >
                              <ExternalLink className="w-3 h-3" />
                              {manifestUrl}
                            </a>
                          )}
                        </div>
                        <Badge variant="outline">{catalogs.length} catalog{catalogs.length !== 1 ? 's' : ''}</Badge>
                      </div>

                      <div className="space-y-2">
                        {catalogs.map((catalog) => {
                          const isEditing = editingId === catalog.id;

                          const handleNameChange = () => {
                            const finalName = newName.trim() || catalog.name;
                            const finalType = newType || catalog.type;

                            setConfig(prev => ({
                              ...prev,
                              catalogs: prev.catalogs.map(c =>
                                c.id === catalog.id ? { ...c, name: finalName, type: finalType } : c
                              )
                            }));
                            setEditingId(null);
                          };

                          return (
                            <div key={catalog.id} className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
                              {isEditing ? (
                                <div
                                  className="flex-1 flex items-center gap-2"
                                  onBlur={(e) => {
                                    // Capture container ref before setTimeout (React nulls e.currentTarget)
                                    const container = e.currentTarget;
                                    // Use setTimeout to allow browser to update document.activeElement
                                    setTimeout(() => {
                                      const activeElement = document.activeElement;
                                      // Only save if focus moved outside AND no Select dropdown is open
                                      if (editingId === catalog.id &&
                                          !container.contains(activeElement) &&
                                          !document.querySelector('[role="listbox"]')) {
                                        handleNameChange();
                                      }
                                    }, 200);
                                  }}
                                >
                                  <Input
                                    value={newName}
                                    onChange={(e) => setNewName(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        e.preventDefault();
                                        handleNameChange();
                                      } else if (e.key === 'Escape') {
                                        setEditingId(null);
                                        setNewName(catalog.name);
                                        setNewType(catalog.type);
                                      }
                                    }}
                                    autoFocus
                                    className="h-7 text-sm flex-1"
                                  />
                                  <Select
                                    value={newType}
                                    onValueChange={(value: 'movie' | 'series' | 'anime') => setNewType(value)}
                                  >
                                    <SelectTrigger className="h-7 text-xs w-28">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="movie">Movie</SelectItem>
                                      <SelectItem value="series">Series</SelectItem>
                                      <SelectItem value="anime">Anime</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                              ) : (
                                <div className="flex-1 min-w-0">
                                  <h5 className="font-medium text-sm">{catalog.name}</h5>
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
                              )}
                              <div className="flex items-center gap-1">
                                {!isEditing && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                      setEditingId(catalog.id);
                                      setNewName(catalog.name);
                                      setNewType(catalog.type);
                                    }}
                                    className="hover:bg-accent"
                                  >
                                    <Pencil className="w-4 h-4" />
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => removeStremThruCatalog(catalog.id)}
                                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            );
          })()}

          {/* Help Section */}
          <Card>
            <CardHeader>
              <CardTitle>How to use StremThru</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                1. Find a StremThru manifest URL (usually shared by other users or communities)
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
