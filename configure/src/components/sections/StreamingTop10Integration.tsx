// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2 } from 'lucide-react';
import { toast } from "sonner";
import { createFlixPatrolCatalogs, type FlixPatrolSections } from '@/utils/catalogUtils';
import { flixpatrolServices, flixpatrolCountries } from '@/data/flixpatrol';
import { type AvailabilityIndex, deriveServices, deriveCountries, sectionsFor } from '@/utils/flixpatrolAvailability';

type Sections = FlixPatrolSections;

interface StreamingTop10IntegrationProps {
  isOpen: boolean;
  onClose: () => void;
}

export function StreamingTop10Integration({ isOpen, onClose }: StreamingTop10IntegrationProps) {
  const { config, setConfig } = useConfig();
  const [selectedService, setSelectedService] = useState<string>('');
  const [selectedCountry, setSelectedCountry] = useState<string>('');
  const [probedSections, setProbedSections] = useState<Sections | null>(null);
  const [isProbing, setIsProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  // Availability index: null = not published by the feed (fall back to probing);
  // an object = usable map for filtering. `loaded` gates the probe fallback until
  // we know which mode we are in.
  const [availability, setAvailability] = useState<AvailabilityIndex | null>(null);
  const [availabilityLoaded, setAvailabilityLoaded] = useState(false);

  // Load the availability index once per dialog open.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    fetch('/api/flixpatrol/availability')
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        setAvailability(data?.available ? data.index : null);
        setAvailabilityLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setAvailability(null);
        setAvailabilityLoaded(true);
      });
    return () => { cancelled = true; };
  }, [isOpen]);

  // Dropdown options. With an index, only real combinations are offered (service
  // picked first, then its valid countries). Without one, show everything.
  const serviceOptions = useMemo(
    () => (availability ? deriveServices(availability, flixpatrolServices) : flixpatrolServices),
    [availability]
  );
  const countryOptions = useMemo(
    () => (availability
      ? (selectedService ? deriveCountries(availability, flixpatrolCountries, selectedService) : [])
      : flixpatrolCountries),
    [availability, selectedService]
  );

  const service = serviceOptions.find(s => s.id === selectedService);
  const country = countryOptions.find(c => c.id === selectedCountry);
  const countryDisabled = !!availability && !selectedService;

  // In availability mode sections come from the index synchronously; otherwise
  // they come from the runtime probe below.
  const sections: Sections | null = availability
    ? (service && country ? sectionsFor(availability, service.id, country.slug) : null)
    : probedSections;

  // Probe fallback — only when the feed does not publish an availability index.
  useEffect(() => {
    setProbedSections(null);
    setProbeError(null);
    if (availability || !availabilityLoaded) return;

    const svc = flixpatrolServices.find(s => s.id === selectedService);
    const ctry = flixpatrolCountries.find(c => c.id === selectedCountry);
    if (!svc || !ctry) return;

    let cancelled = false;
    setIsProbing(true);

    fetch('/api/flixpatrol/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: svc.id, countrySlug: ctry.slug }),
    })
      .then(res => {
        if (!res.ok) throw new Error('Probe failed');
        return res.json();
      })
      .then(data => {
        if (!cancelled) setProbedSections(data);
      })
      .catch(err => {
        if (!cancelled) setProbeError(err.message);
      })
      .finally(() => {
        if (!cancelled) setIsProbing(false);
      });

    return () => { cancelled = true; };
  }, [selectedService, selectedCountry, availability, availabilityLoaded]);

  const previewCatalogs = service && country && sections
    ? createFlixPatrolCatalogs({ service, country, sections, displayTypeOverrides: config.displayTypeOverrides })
    : [];
  // Only the catalogs not already present. A partially-added service+country
  // (e.g. the default already added, but not its language variants) should still
  // let the user add the missing ones instead of blocking the whole batch.
  const missingCatalogs = previewCatalogs.filter(
    c => !config.catalogs.some(existing => existing.id === c.id)
  );
  const allAlreadyExist = previewCatalogs.length > 0 && missingCatalogs.length === 0;

  const handleAddCatalogs = useCallback(() => {
    if (!service || !country || !sections) return;

    const newCatalogs = createFlixPatrolCatalogs({
      service,
      country,
      sections,
      displayTypeOverrides: config.displayTypeOverrides,
    }).filter(c => !config.catalogs.some(existing => existing.id === c.id));

    if (newCatalogs.length === 0) {
      toast.error("Already added", {
        description: `Top 10 catalogs for ${service.name} (${country.name}) already exist`
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
    setProbedSections(null);
  }, [service, country, sections, config, setConfig]);

  const existingCatalogs = config.catalogs.filter(c => c.source === 'flixpatrol');

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
                  <Select
                    value={selectedService}
                    onValueChange={(v) => { setSelectedService(v); setSelectedCountry(''); }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select service..." />
                    </SelectTrigger>
                    <SelectContent>
                      {serviceOptions.map(s => (
                        <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Country</Label>
                  <Select value={selectedCountry} onValueChange={setSelectedCountry} disabled={countryDisabled}>
                    <SelectTrigger>
                      <SelectValue placeholder={countryDisabled ? "Select a service first" : "Select country..."} />
                    </SelectTrigger>
                    <SelectContent>
                      {countryOptions.map(c => (
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
                  {previewCatalogs.map(c => {
                    const exists = config.catalogs.some(existing => existing.id === c.id);
                    return (
                      <p key={c.id} className={exists ? 'text-muted-foreground' : ''}>
                        {c.name}{exists ? ' (already added)' : ''}
                      </p>
                    );
                  })}
                  {allAlreadyExist && (
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
                disabled={!sections || previewCatalogs.length === 0 || missingCatalogs.length === 0 || isProbing}
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
