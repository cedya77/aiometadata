import React, { useState, useCallback, useEffect } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2 } from 'lucide-react';
import { toast } from "sonner";
import { createFlixPatrolCatalogs } from '@/utils/catalogUtils';
import { flixpatrolServices, flixpatrolCountries } from '@/data/flixpatrol';

interface Sections {
  hasMovies: boolean;
  hasShows: boolean;
  hasOverall: boolean;
}

interface StreamingTop10IntegrationProps {
  isOpen: boolean;
  onClose: () => void;
}

export function StreamingTop10Integration({ isOpen, onClose }: StreamingTop10IntegrationProps) {
  const { config, setConfig } = useConfig();
  const [selectedService, setSelectedService] = useState<string>('');
  const [selectedCountry, setSelectedCountry] = useState<string>('');
  const [sections, setSections] = useState<Sections | null>(null);
  const [isProbing, setIsProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  const service = flixpatrolServices.find(s => s.id === selectedService);
  const country = flixpatrolCountries.find(c => c.id === selectedCountry);

  // Probe when both selections are made
  useEffect(() => {
    setSections(null);
    setProbeError(null);
    if (!service || !country) return;

    let cancelled = false;
    setIsProbing(true);

    fetch('/api/flixpatrol/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: service.id, countrySlug: country.slug }),
    })
      .then(res => {
        if (!res.ok) throw new Error('Probe failed');
        return res.json();
      })
      .then(data => {
        if (!cancelled) setSections(data);
      })
      .catch(err => {
        if (!cancelled) setProbeError(err.message);
      })
      .finally(() => {
        if (!cancelled) setIsProbing(false);
      });

    return () => { cancelled = true; };
  }, [service, country]);

  const catalogIds = service && country && sections
    ? createFlixPatrolCatalogs({ service, country, sections, displayTypeOverrides: config.displayTypeOverrides }).map(c => c.id)
    : [];
  const alreadyExists = catalogIds.some(id => config.catalogs.some(c => c.id === id));

  const handleAddCatalogs = useCallback(() => {
    if (!service || !country || !sections) return;

    if (alreadyExists) {
      toast.error("Already added", {
        description: `Top 10 catalogs for ${service.name} (${country.name}) already exist`
      });
      return;
    }

    const newCatalogs = createFlixPatrolCatalogs({
      service,
      country,
      sections,
      displayTypeOverrides: config.displayTypeOverrides,
    });

    if (newCatalogs.length === 0) {
      toast.error("No data available", {
        description: `No top 10 data found for ${service.name} in ${country.name}`
      });
      return;
    }

    setConfig(prev => ({
      ...prev,
      catalogs: [...prev.catalogs, ...newCatalogs]
    }));

    const names = newCatalogs.map(c => c.name).join(', ');
    toast.success("Catalogs added", { description: names });

    setSelectedService('');
    setSelectedCountry('');
    setSections(null);
  }, [service, country, sections, alreadyExists, config, setConfig]);

  const existingCatalogs = config.catalogs.filter(c => c.source === 'flixpatrol');

  const previewCatalogs = service && country && sections
    ? createFlixPatrolCatalogs({ service, country, sections, displayTypeOverrides: config.displayTypeOverrides })
    : [];

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Streaming Top 10</DialogTitle>
          <DialogDescription>
            Add daily top 10 catalogs for popular streaming services by country
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <Card>
            <CardHeader>
              <CardTitle>Add Top 10 Catalogs</CardTitle>
              <CardDescription>
                Select a streaming service and country to add top 10 catalogs
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Streaming Service</Label>
                  <Select value={selectedService} onValueChange={setSelectedService}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select service..." />
                    </SelectTrigger>
                    <SelectContent>
                      {flixpatrolServices.map(s => (
                        <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Country</Label>
                  <Select value={selectedCountry} onValueChange={setSelectedCountry}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select country..." />
                    </SelectTrigger>
                    <SelectContent>
                      {flixpatrolCountries.map(c => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {isProbing && (
                <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Checking available rankings...
                </div>
              )}

              {probeError && (
                <div className="p-3 bg-destructive/10 rounded-lg text-sm text-destructive">
                  Failed to check available rankings. Please try again.
                </div>
              )}

              {sections && previewCatalogs.length > 0 && (
                <div className="p-3 bg-muted/50 rounded-lg text-sm space-y-1">
                  <p className="font-medium">Catalogs to add:</p>
                  {previewCatalogs.map(c => (
                    <p key={c.id}>{c.name}</p>
                  ))}
                  {alreadyExists && (
                    <p className="text-destructive font-medium mt-2">
                      These catalogs already exist in your configuration.
                    </p>
                  )}
                </div>
              )}

              {sections && previewCatalogs.length === 0 && (
                <div className="p-3 bg-muted/50 rounded-lg text-sm text-muted-foreground">
                  No top 10 data found for this combination.
                </div>
              )}

              <Button
                onClick={handleAddCatalogs}
                disabled={!sections || previewCatalogs.length === 0 || alreadyExists || isProbing}
                className="w-full"
              >
                Add Catalogs
              </Button>
            </CardContent>
          </Card>

          {existingCatalogs.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Your Streaming Top 10 Catalogs</CardTitle>
                <CardDescription>
                  {existingCatalogs.length} catalog(s) added
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {existingCatalogs.map(catalog => (
                    <div
                      key={catalog.id}
                      className="flex items-center justify-between gap-2 p-3 border rounded-lg bg-muted/30"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-medium break-words">{catalog.name}</div>
                        <div className="text-xs text-muted-foreground">
                          10 items per refresh
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        onClick={() => {
                          setConfig(prev => ({
                            ...prev,
                            catalogs: prev.catalogs.filter(c => c.id !== catalog.id)
                          }));
                          toast.success("Catalog removed");
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
