// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import React, { useCallback, useEffect, useState } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import type { CatalogConfig } from '@/contexts/config';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogClose } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertCircle, ChevronLeft, ChevronRight, LayoutGrid, Link as LinkIcon, Loader2, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { createTvdbListCatalogs, TvdbListPreview } from '@/utils/catalogUtils';

interface TVDBListIntegrationProps {
  isOpen: boolean;
  onClose: () => void;
}

interface TvdbListSummary {
  id: number;
  name: string;
  overview?: string;
  slug?: string;
  image?: string;
  isOfficial?: boolean;
  url?: string;
  movieCount?: number;
  seriesCount?: number;
  itemCount?: number;
}

function listContents(list: { movieCount?: number; seriesCount?: number }): string {
  const parts: string[] = [];
  if (list.movieCount) parts.push(`${list.movieCount} ${list.movieCount === 1 ? 'movie' : 'movies'}`);
  if (list.seriesCount) parts.push(`${list.seriesCount} ${list.seriesCount === 1 ? 'series' : 'series'}`);
  return parts.join(' · ');
}

function SavedLists({
  catalogs,
  onRemove,
}: {
  catalogs: CatalogConfig[];
  onRemove: (id: string, type: string) => void;
}) {
  if (!catalogs.length) {
    return <p className="text-xs text-muted-foreground">Nothing added yet</p>;
  }
  return (
    <div className="space-y-2">
      {catalogs.map(catalog => (
        <div
          key={`${catalog.id}:${catalog.type}`}
          className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 p-2.5"
        >
          <div className="min-w-0 flex-1">
            <div className="break-words text-sm font-medium">{catalog.name}</div>
            <div className="text-xs text-muted-foreground">
              {catalog.type === 'all' ? 'Movies and series' : catalog.type === 'movie' ? 'Movies' : 'Series'}
              {catalog.metadata?.itemCount ? ` \u00b7 ${catalog.metadata.itemCount} items` : ''}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => onRemove(catalog.id, catalog.type)}
            aria-label={`Remove ${catalog.name}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}

export function TVDBListIntegration({ isOpen, onClose }: TVDBListIntegrationProps) {
  const { config, setConfig, auth } = useConfig();

  const [mode, setMode] = useState<'browse' | 'slug'>('browse');
  const [showDetail, setShowDetail] = useState(false);
  const [listInput, setListInput] = useState('');
  const [preview, setPreview] = useState<TvdbListPreview | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [splitMode, setSplitMode] = useState<'all' | 'split'>('all');

  const [searchQuery, setSearchQuery] = useState('');
  const [browseResults, setBrowseResults] = useState<TvdbListSummary[]>([]);
  const [browsePage, setBrowsePage] = useState(0);
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [isSearchResults, setIsSearchResults] = useState(false);

  const tvdbListCatalogs = config.catalogs.filter(c => c.id.startsWith('tvdb.list.'));

  const queryParams = useCallback((extra: Record<string, string>) => {
    const params = new URLSearchParams(extra);
    if (config.apiKeys?.tvdb) params.set('apikey', config.apiKeys.tvdb);
    if (auth?.userUUID) params.set('userUUID', auth.userUUID);
    return params.toString();
  }, [config.apiKeys?.tvdb, auth?.userUUID]);

  const loadBrowsePage = useCallback(async (page: number) => {
    setIsBrowsing(true);
    try {
      const res = await fetch(`/api/tvdb/lists?${queryParams({ page: String(page) })}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load lists');
      setBrowseResults(data.results || []);
      setBrowsePage(page);
      setIsSearchResults(false);
    } catch (error: any) {
      toast.error('Could not load TheTVDB lists', { description: error.message });
    } finally {
      setIsBrowsing(false);
    }
  }, [queryParams]);

  useEffect(() => {
    if (!isOpen || browseResults.length > 0) return;
    loadBrowsePage(0);
  }, [isOpen, browseResults.length, loadBrowsePage]);

  const handleSearch = useCallback(async () => {
    const query = searchQuery.trim();
    if (!query) {
      loadBrowsePage(0);
      return;
    }
    setIsBrowsing(true);
    try {
      const res = await fetch(`/api/tvdb/lists/search?${queryParams({ query })}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');
      setBrowseResults(data.results || []);
      setIsSearchResults(true);
      if (!data.results?.length) {
        toast.info('No lists matched that search');
      }
    } catch (error: any) {
      toast.error('Search failed', { description: error.message });
    } finally {
      setIsBrowsing(false);
    }
  }, [searchQuery, queryParams, loadBrowsePage]);

  const resolveList = useCallback(async (input: string) => {
    if (!input.trim()) {
      toast.error('Enter a list slug, id or thetvdb.com link');
      return;
    }
    setIsResolving(true);
    setPreview(null);
    try {
      const res = await fetch(`/api/tvdb/lists/resolve?${queryParams({ input: input.trim() })}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not resolve that list');
      setPreview(data);
      setSplitMode('all');
      setShowDetail(true);
    } catch (error: any) {
      toast.error('Could not load that list', { description: error.message });
    } finally {
      setIsResolving(false);
    }
  }, [queryParams]);

  const handleAdd = useCallback(() => {
    if (!preview) return;

    const catalogs = createTvdbListCatalogs({
      list: preview,
      mode: splitMode,
      displayTypeOverrides: config.displayTypeOverrides,
    });

    if (!catalogs.length) {
      toast.error('That list has no movies or series in it');
      return;
    }

    const existing = new Set(config.catalogs.map(c => `${c.id}:${c.type}`));
    const fresh = catalogs.filter(c => !existing.has(`${c.id}:${c.type}`));
    if (!fresh.length) {
      toast.error('List already added', { description: 'This TheTVDB list is already in your catalogs' });
      return;
    }

    setConfig(prev => ({ ...prev, catalogs: [...prev.catalogs, ...fresh] }));
    toast.success(fresh.length > 1 ? 'Lists added' : 'List added', {
      description: `${preview.name} (${preview.itemCount} items) is now in your catalogs`,
    });

    setPreview(null);
    setShowDetail(false);
    setListInput('');
  }, [preview, splitMode, config.catalogs, config.displayTypeOverrides, setConfig]);

  const handleRemove = useCallback((catalogId: string, catalogType: string) => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.filter(c => !(c.id === catalogId && c.type === catalogType)),
    }));
    toast.success('List removed');
  }, [setConfig]);

  const isMixed = !!preview && preview.movieCount > 0 && preview.seriesCount > 0;


  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="@container grid h-[100dvh] max-h-[100dvh] w-screen max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-none p-0 sm:h-[92vh] sm:max-h-[92vh] sm:w-[min(96vw,100rem)] sm:rounded-2xl sm:p-0">
        <header className="flex min-h-0 flex-col gap-3 border-b px-5 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <img src="/tvdb_icon.png" alt="TheTVDB" className="h-6 w-6 object-contain" />
            <DialogTitle className="text-lg font-semibold">TheTVDB Lists</DialogTitle>
            <DialogDescription className="sr-only">
              Add a TheTVDB list as its own catalog, by slug or by picking one from the site
            </DialogDescription>
          </div>

          <div className="flex flex-col gap-2 @2xl:flex-row @2xl:items-center">
            <div className="flex gap-1 rounded-lg border p-1 shrink-0">
              <button
                type="button"
                onClick={() => setMode('browse')}
                className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-sm transition-colors ${
                  mode === 'browse' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50'
                }`}
              >
                <LayoutGrid className="h-4 w-4" /> Browse
              </button>
              <button
                type="button"
                onClick={() => setMode('slug')}
                className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-sm transition-colors ${
                  mode === 'slug' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50'
                }`}
              >
                <LinkIcon className="h-4 w-4" /> By slug or link
              </button>
            </div>

            {mode === 'browse' ? (
              <div className="flex flex-1 gap-2">
                <Input
                  placeholder="Search lists by name"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
                  disabled={isBrowsing}
                  className="h-9"
                />
                <Button variant="secondary" size="sm" className="h-9" onClick={handleSearch} disabled={isBrowsing}>
                  {isBrowsing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                </Button>
              </div>
            ) : (
              <div className="flex flex-1 gap-2">
                <Input
                  placeholder="star-wars, 4, or https://thetvdb.com/lists/star-wars"
                  value={listInput}
                  onChange={(e) => setListInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') resolveList(listInput); }}
                  disabled={isResolving}
                  className="h-9"
                />
                <Button size="sm" className="h-9" onClick={() => resolveList(listInput)} disabled={!listInput.trim() || isResolving}>
                  {isResolving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Look up'}
                </Button>
              </div>
            )}
          </div>
        </header>

        <div className="@container/panes min-h-0 overflow-hidden">
          <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)] @4xl:grid-cols-[minmax(0,1fr)_24rem]">
            <div className={`min-h-0 overflow-y-auto px-5 py-4 ${showDetail ? 'hidden @4xl:block' : ''}`}>
              {mode === 'slug' ? (
                <div className="flex h-full items-center justify-center text-center">
                  <div className="max-w-md space-y-2 text-sm text-muted-foreground">
                    <LinkIcon className="mx-auto h-8 w-8 opacity-40" />
                    <p>Paste a list slug, its numeric id, or a full thetvdb.com/lists link above.</p>
                    <p className="text-xs">Look it up and it opens ready to add.</p>
                  </div>
                </div>
              ) : isBrowsing && !browseResults.length ? (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading lists
                </div>
              ) : browseResults.length ? (
                <div className="grid grid-cols-2 gap-3 @md:grid-cols-3 @2xl:grid-cols-4 @5xl:grid-cols-5 @7xl:grid-cols-6">
                  {browseResults.map(list => {
                    const selected = preview?.id === list.id;
                    return (
                      <button
                        key={list.id}
                        type="button"
                        onClick={() => resolveList(list.slug || String(list.id))}
                        title={list.overview || list.name}
                        className={`group flex flex-col overflow-hidden rounded-lg border text-left transition-colors ${
                          selected ? 'border-primary ring-1 ring-primary' : 'hover:border-muted-foreground/40'
                        }`}
                      >
                        <div className="relative aspect-[2/3] bg-muted">
                          {list.image ? (
                            <img src={list.image} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
                          ) : (
                            <div className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted-foreground">
                              {list.name}
                            </div>
                          )}
                          {list.isOfficial && (
                            <Badge variant="secondary" className="absolute left-1 top-1 px-1.5 py-0 text-[10px]">Official</Badge>
                          )}
                        </div>
                        <div className="space-y-0.5 p-2">
                          <div className="line-clamp-2 text-sm font-medium leading-tight">{list.name}</div>
                          <div className="text-[11px] text-muted-foreground">{listContents(list) || 'Empty'}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="py-6 text-center text-sm text-muted-foreground">No lists to show</p>
              )}

              <div className="mt-6 border-t pt-4 @4xl:hidden">
                <div className="pb-2 text-sm font-medium">
                  Your lists {tvdbListCatalogs.length > 0 && (
                    <span className="text-muted-foreground">({tvdbListCatalogs.length})</span>
                  )}
                </div>
                <SavedLists catalogs={tvdbListCatalogs} onRemove={handleRemove} />
              </div>
            </div>

            <aside className={`min-h-0 flex-col @4xl:flex @4xl:border-l ${showDetail ? 'flex' : 'hidden'}`}>
              <button
                type="button"
                onClick={() => setShowDetail(false)}
                className="flex items-center gap-1.5 border-b px-5 py-3 text-sm text-muted-foreground @4xl:hidden"
              >
                <ChevronLeft className="h-4 w-4" /> Back to lists
              </button>

              {preview ? (
                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                  <div className="flex gap-4">
                    {preview.image && (
                      <img src={preview.image} alt="" className="w-24 shrink-0 self-start rounded border object-cover" />
                    )}
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="break-words text-base font-semibold">{preview.name}</h3>
                        {preview.isOfficial && <Badge variant="secondary">Official</Badge>}
                      </div>
                      <p className="text-sm text-muted-foreground">{listContents(preview) || 'Empty'}</p>
                    </div>
                  </div>

                  {preview.overview && (
                    <p className="mt-3 line-clamp-5 text-sm text-muted-foreground">{preview.overview}</p>
                  )}

                  <div className="mt-4 space-y-4">
                    {isMixed ? (
                      <div className="space-y-2">
                        <Label htmlFor="tvdb-list-mode">Catalog layout</Label>
                        <Select value={splitMode} onValueChange={(v) => setSplitMode(v as 'all' | 'split')}>
                          <SelectTrigger id="tvdb-list-mode">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">One row, movies and series together</SelectItem>
                            <SelectItem value="split">Separate movie and series rows</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    ) : (
                      <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <p className="text-xs text-muted-foreground">
                          This list holds only {preview.movieCount > 0 ? 'movies' : 'series'}, so it becomes a single catalog.
                        </p>
                      </div>
                    )}

                    <Button className="w-full" onClick={handleAdd}>Add to catalogs</Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-1 items-center justify-center px-5 py-8 text-center text-sm text-muted-foreground">
                  Pick a list to see what it holds
                </div>
              )}

              <div className="mt-auto hidden min-h-0 border-t @4xl:block">
                <div className="px-5 py-3 text-sm font-medium">
                  Your lists {tvdbListCatalogs.length > 0 && (
                    <span className="text-muted-foreground">({tvdbListCatalogs.length})</span>
                  )}
                </div>
                <div className="max-h-56 overflow-y-auto px-5 pb-4">
                  <SavedLists catalogs={tvdbListCatalogs} onRemove={handleRemove} />
                </div>
              </div>
            </aside>
          </div>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t px-5 py-3">
          {mode === 'browse' && !isSearchResults ? (
            <div className={`items-center gap-2 ${showDetail ? 'hidden @4xl:flex' : 'flex'}`}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => loadBrowsePage(Math.max(0, browsePage - 1))}
                disabled={browsePage === 0 || isBrowsing}
              >
                <ChevronLeft className="mr-1 h-4 w-4" /> Previous
              </Button>
              <span className="text-xs text-muted-foreground">Page {browsePage + 1}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => loadBrowsePage(browsePage + 1)}
                disabled={isBrowsing || browseResults.length === 0}
              >
                Next <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          ) : (
            <span />
          )}
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
