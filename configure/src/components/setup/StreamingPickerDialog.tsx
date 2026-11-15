// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useConfig } from '@/contexts/ConfigContext';
import { apiCache } from '@/utils/apiCache';
import {
  POPULAR_STREAMING_SERVICES,
  STREAMING_TIME_RANGE_OPTIONS,
  type SelectedStreamingService,
  type StreamingTimeRange,
  tmdbLogoUrl,
  type TmdbProvider,
  type TmdbWatchRegion,
} from '@/lib/setup/streaming';
import { cn } from '@/lib/utils';

const CACHE_TTL_MS = 30 * 60 * 1000;

function ServiceTile({
  logo,
  label,
  selected,
  onClick,
}: {
  logo: string | null;
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      title={label}
      className={cn(
        'group flex flex-col items-center gap-2 rounded-xl border p-3 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        selected
          ? 'border-primary/60 bg-primary/[0.08]'
          : 'border-white/[0.08] bg-white/[0.02] hover:border-white/25'
      )}
    >
      <span className="relative">
        <span className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-lg border border-white/[0.08] bg-background">
          {logo
            ? <img src={logo} alt="" loading="lazy" className="h-full w-full object-cover" />
            : <span className="text-xs font-semibold text-muted-foreground">
                {label.slice(0, 2).toUpperCase()}
              </span>}
        </span>
        {selected && (
          <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="h-2.5 w-2.5" aria-hidden="true" />
          </span>
        )}
      </span>
      <span className="w-full truncate text-center text-xs leading-tight">{label}</span>
    </button>
  );
}

export interface StreamingSelection {
  services: SelectedStreamingService[];
  datePreset: StreamingTimeRange;
  releasedOnly: boolean;
}

export function StreamingPickerDialog({
  open,
  onOpenChange,
  initial,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: StreamingSelection;
  onConfirm: (selection: StreamingSelection) => void;
}) {
  const { config, auth, hasBuiltInTmdb } = useConfig();

  const [region, setRegion] = useState('US');
  const [regions, setRegions] = useState<TmdbWatchRegion[]>([]);
  const [providers, setProviders] = useState<TmdbProvider[]>([]);
  const [loadingRegions, setLoadingRegions] = useState(false);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<SelectedStreamingService[]>(initial.services);
  const [datePreset, setDatePreset] = useState<StreamingTimeRange>(initial.datePreset);
  const [releasedOnly, setReleasedOnly] = useState(initial.releasedOnly);

  const tmdbKey = config.apiKeys?.tmdb?.trim() || '';
  const canQuery = !!tmdbKey || hasBuiltInTmdb;

  const query = useMemo(() => (params: Record<string, string>) => {
    const searchParams = new URLSearchParams(params);
    if (tmdbKey) searchParams.set('apikey', tmdbKey);
    if (auth.userUUID) searchParams.set('userUUID', auth.userUUID);
    return searchParams.toString();
  }, [tmdbKey, auth.userUUID]);

  useEffect(() => {
    if (!open || !canQuery || regions.length > 0) return;
    let cancelled = false;

    (async () => {
      setLoadingRegions(true);
      try {
        const language = config.language || 'en-US';
        const data = await apiCache.cachedFetch<{ watchRegions: TmdbWatchRegion[] }>(
          `setup_streaming_regions_${language}`,
          async () => {
            const response = await fetch(`/api/tmdb/discover/reference?${query({ type: 'movie', language })}`);
            if (!response.ok) throw new Error(`Failed to load regions (${response.status})`);
            return response.json();
          },
          CACHE_TTL_MS
        );
        if (cancelled) return;

        const list = Array.isArray(data.watchRegions) ? data.watchRegions : [];
        setRegions(list);
        if (!list.some(entry => entry.iso_3166_1 === region)) {
          setRegion(list.find(entry => entry.iso_3166_1 === 'US')?.iso_3166_1 || list[0]?.iso_3166_1 || 'US');
        }
      } catch (error) {
        if (!cancelled) {
          toast.error('Could not load streaming regions', {
            description: error instanceof Error ? error.message : 'Unknown error.',
          });
        }
      } finally {
        if (!cancelled) setLoadingRegions(false);
      }
    })();

    return () => { cancelled = true; };
  }, [open, canQuery, regions.length, region, config.language, query]);

  useEffect(() => {
    if (!open || !canQuery || !region) return;
    let cancelled = false;

    (async () => {
      setLoadingProviders(true);
      try {
        const data = await apiCache.cachedFetch<{ providers: TmdbProvider[] }>(
          `setup_streaming_providers_movie_${region}`,
          async () => {
            const response = await fetch(`/api/tmdb/discover/providers?${query({ type: 'movie', watch_region: region })}`);
            if (!response.ok) throw new Error(`Failed to load providers (${response.status})`);
            return response.json();
          },
          CACHE_TTL_MS
        );
        if (!cancelled) setProviders(Array.isArray(data.providers) ? data.providers : []);
      } catch (error) {
        if (!cancelled) {
          toast.error('Could not load streaming services', {
            description: error instanceof Error ? error.message : 'Unknown error.',
          });
        }
      } finally {
        if (!cancelled) setLoadingProviders(false);
      }
    })();

    return () => { cancelled = true; };
  }, [open, canQuery, region, query]);

  const availableIds = useMemo(
    () => new Set(providers.map(provider => provider.provider_id)),
    [providers]
  );

  const popularHere = useMemo(
    () => POPULAR_STREAMING_SERVICES.filter(service =>
      service.providerIds.some(id => availableIds.has(id))
    ),
    [availableIds]
  );

  const searchResults = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return [];
    const popularIds = new Set(POPULAR_STREAMING_SERVICES.flatMap(service => service.providerIds));
    return providers
      .filter(provider => !popularIds.has(provider.provider_id))
      .filter(provider => provider.provider_name.toLowerCase().includes(term))
      .slice(0, 12);
  }, [providers, search]);

  const isSelected = (key: string) => selected.some(service => service.key === key);

  const togglePopular = (service: (typeof POPULAR_STREAMING_SERVICES)[number]) => {
    const key = `popular:${service.key}:${region}`;
    setSelected(previous => previous.some(entry => entry.key === key)
      ? previous.filter(entry => entry.key !== key)
      : [...previous, {
          key,
          label: service.label,
          providerIds: service.providerIds.filter(id => availableIds.has(id)),
          watchProviders: service.providerIds
            .filter(id => availableIds.has(id))
            .map(id => ({
              id,
              label: providers.find(p => p.provider_id === id)?.provider_name || service.label,
            })),
          region,
          source: 'popular' as const,
          logo: service.logo,
        }]);
  };

  const toggleCustom = (provider: TmdbProvider) => {
    const key = `custom:${provider.provider_id}:${region}`;
    setSelected(previous => previous.some(entry => entry.key === key)
      ? previous.filter(entry => entry.key !== key)
      : [...previous, {
          key,
          label: provider.provider_name,
          providerIds: [provider.provider_id],
          watchProviders: [{ id: provider.provider_id, label: provider.provider_name }],
          region,
          source: 'custom' as const,
          logo: tmdbLogoUrl(provider.logo_path),
        }]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add streaming rows</DialogTitle>
          <DialogDescription>
            One movie row and one series row per service, filtered to what is streaming in your region.
          </DialogDescription>
        </DialogHeader>

        {!canQuery ? (
          <p className="text-sm text-muted-foreground">
            This needs a TMDB key. Add one above and reopen this.
          </p>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5">
                <span className="text-sm">Region</span>
                <Select value={region} onValueChange={setRegion} disabled={loadingRegions}>
                  <SelectTrigger><SelectValue placeholder="Select region" /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {regions.map(entry => (
                      <SelectItem key={entry.iso_3166_1} value={entry.iso_3166_1}>
                        {entry.english_name || entry.iso_3166_1}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>

              <label className="space-y-1.5">
                <span className="text-sm">Time range</span>
                <Select value={datePreset} onValueChange={value => setDatePreset(value as StreamingTimeRange)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {STREAMING_TIME_RANGE_OPTIONS.map(option => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </div>

            <div className="space-y-2">
              <span className="text-sm">Services</span>
              {loadingProviders ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  Loading what streams in {region}
                </p>
              ) : popularHere.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No popular services listed for {region}. Search below instead.
                </p>
              ) : (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {popularHere.map(service => (
                    <ServiceTile
                      key={service.key}
                      logo={service.logo}
                      label={service.label}
                      selected={isSelected(`popular:${service.key}:${region}`)}
                      onClick={() => togglePopular(service)}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  placeholder="Missing a service? Search all providers"
                  className="h-9 pl-8"
                />
              </div>
              {searchResults.length > 0 && (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {searchResults.map(provider => (
                    <ServiceTile
                      key={provider.provider_id}
                      logo={tmdbLogoUrl(provider.logo_path)}
                      label={provider.provider_name}
                      selected={isSelected(`custom:${provider.provider_id}:${region}`)}
                      onClick={() => toggleCustom(provider)}
                    />
                  ))}
                </div>
              )}
            </div>

            <label className="flex items-center justify-between gap-4 rounded-lg border border-white/[0.06] px-4 py-3">
              <span className="space-y-0.5">
                <span className="block text-sm">Released only</span>
                <span className="block text-xs text-muted-foreground">
                  Leave out titles that have not come out yet.
                </span>
              </span>
              <Switch checked={releasedOnly} onCheckedChange={setReleasedOnly} />
            </label>

            {selected.length > 0 && (
              <div className="space-y-2">
                <span className="text-sm">Selected</span>
                <div className="flex flex-wrap gap-2">
                  {selected.map(service => (
                    <span
                      key={service.key}
                      className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] py-1 pl-1.5 pr-1.5 text-xs"
                    >
                      {service.logo && (
                        <img
                          src={service.logo}
                          alt=""
                          className="h-4 w-4 shrink-0 rounded-sm object-cover"
                        />
                      )}
                      {service.label}
                      <span className="text-muted-foreground">{service.region}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${service.label}`}
                        onClick={() => setSelected(previous => previous.filter(entry => entry.key !== service.key))}
                        className="rounded-full p-0.5 hover:bg-white/10"
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => { onConfirm({ services: selected, datePreset, releasedOnly }); onOpenChange(false); }}>
            {selected.length > 0 ? `Add ${selected.length * 2} rows` : 'Done'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
