import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Check, Search } from 'lucide-react';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { CatalogConfig } from '@/contexts/config';
import { ProviderListSearch, PROVIDER_LABELS, type ListProvider } from './ProviderListSearch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TagChip } from '@/components/TagChip';
import { getSourceBadgeLabel, getSourceDotStyle } from '@/lib/sourceBadges';
import { catalogKey, type ManifestCatalog } from '@/lib/collectionBuilder/manifestSources';
import type { TagOption } from './shared';

export function CatalogPicker({
  isOpen,
  catalogs,
  multiple,
  existingKeys,
  tagOptions = [],
  onConfirm,
  onCreate,
  onClose,
  title,
  description,
}: {
  isOpen: boolean;
  catalogs: ManifestCatalog[];
  /** Classic rows hold a single catalog, so selection collapses to one there. */
  multiple: boolean;
  /** Already on the tile, shown as such instead of being silently deduped. */
  existingKeys: string[];
  tagOptions?: TagOption[];
  onConfirm: (picked: ManifestCatalog[]) => void;
  /** Present only where creating a catalog makes sense, so remapping stays a pure pick. */
  onCreate?: (created: CatalogConfig[]) => void;
  onClose: () => void;
  title?: string;
  description?: string;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<'config' | ListProvider>('config');
  // A row under a resting pointer would otherwise steal the selection back on
  // every repaint, so hovering only counts after the mouse has actually moved.
  const pointerActive = useRef(false);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelected([]);
      setTypeFilter(null);
      setTagFilters([]);
      setActiveIndex(0);
      setTab('config');
    }
  }, [isOpen]);

  const types = useMemo(() => {
    const seen = new Set<string>();
    for (const catalog of catalogs) {
      if (catalog.type) seen.add(catalog.type);
    }
    return [...seen].sort();
  }, [catalogs]);

  const pickerTags = useMemo(
    () => tagOptions.filter(tag => catalogs.some(catalog => (catalog.tags ?? []).includes(tag.name))),
    [tagOptions, catalogs]
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalogs.filter(catalog => {
      if (typeFilter && catalog.type !== typeFilter) return false;
      if (tagFilters.length > 0 && !tagFilters.some(tag => (catalog.tags ?? []).includes(tag))) return false;
      if (!needle) return true;
      return `${catalog.name} ${catalog.id} ${catalog.type} ${catalog.source || ''}`
        .toLowerCase()
        .includes(needle);
    });
  }, [catalogs, query, typeFilter, tagFilters]);

  const alreadyAdded = useMemo(() => new Set(existingKeys), [existingKeys]);

  const addable = useMemo(
    () => filtered.filter(catalog => !alreadyAdded.has(catalogKey(catalog))),
    [filtered, alreadyAdded]
  );

  // Selection outlives a filter change, so "select all" adds to it rather than
  // becoming it, and offers itself whenever this set holds something unticked.
  const unselectedAddable = useMemo(() => {
    const picked = new Set(selected);
    return addable.map(catalogKey).filter(key => !picked.has(key));
  }, [addable, selected]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, typeFilter, tagFilters]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => 40,
    overscan: 12,
  });

  const toggle = (catalog: ManifestCatalog) => {
    const key = catalogKey(catalog);
    if (alreadyAdded.has(key)) return;
    if (!multiple) {
      onConfirm([catalog]);
      onClose();
      return;
    }
    setSelected(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]));
  };

  const confirm = () => {
    const byKey = new Map(catalogs.map(catalog => [catalogKey(catalog), catalog]));
    onConfirm(selected.map(key => byKey.get(key)).filter((c): c is ManifestCatalog => Boolean(c)));
    onClose();
  };

  const move = (delta: number) => {
    pointerActive.current = false;
    if (filtered.length === 0) return;
    const next = Math.min(Math.max(activeIndex + delta, 0), filtered.length - 1);
    setActiveIndex(next);
    virtualizer.scrollToIndex(next, { align: 'auto' });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (multiple && (event.metaKey || event.ctrlKey)) {
      if (selected.length > 0) confirm();
      return;
    }
    const catalog = filtered[activeIndex];
    if (catalog) toggle(catalog);
  };

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className={onCreate ? 'flex max-h-[85vh] max-w-2xl flex-col' : 'max-w-xl'}>
        <DialogHeader>
          <DialogTitle>{title ?? (multiple ? 'Add catalogs' : 'Pick a catalog')}</DialogTitle>
          <DialogDescription>
            {description ?? (multiple
              ? 'Select as many as you want, then add them all at once.'
              : 'A row reads from a single catalog.')}
          </DialogDescription>
        </DialogHeader>

        {onCreate && (
          <Tabs value={tab} onValueChange={value => setTab(value as 'config' | ListProvider)}>
            <TabsList className="grid grid-cols-4">
              <TabsTrigger value="config">Your catalogs</TabsTrigger>
              {(['mdblist', 'tvdb', 'tmdb'] as ListProvider[]).map(provider => (
                <TabsTrigger key={provider} value={provider}>{PROVIDER_LABELS[provider]}</TabsTrigger>
              ))}
            </TabsList>
            {(['mdblist', 'tvdb', 'tmdb'] as ListProvider[]).map(provider => (
              <TabsContent key={provider} value={provider} className="mt-3">
                <div className="h-[26rem]">
                  <ProviderListSearch provider={provider} onCreate={onCreate} />
                </div>
              </TabsContent>
            ))}
          </Tabs>
        )}

        <div className={onCreate && tab !== 'config' ? 'hidden' : undefined}>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search catalogs"
              className="h-10 bg-background/60 pl-9 focus-visible:ring-1 focus-visible:ring-ring/40 focus-visible:ring-offset-0"
            />
          </div>

          {(types.length > 1 || pickerTags.length > 0) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {types.length > 1 && types.map(type => (
                <button
                  key={type}
                  type="button"
                  aria-pressed={typeFilter === type}
                  onClick={() => setTypeFilter(prev => (prev === type ? null : type))}
                  className={`h-7 rounded-full border px-3 text-xs font-medium capitalize transition-colors ${
                    typeFilter === type
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-muted-foreground/30 text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {type}
                </button>
              ))}
              {pickerTags.map(tag => (
                <TagChip
                  key={tag.name}
                  name={`${tag.name} (${tag.count})`}
                  color={tag.color}
                  dimmed={tagFilters.length > 0 && !tagFilters.includes(tag.name)}
                  pressed={tagFilters.includes(tag.name)}
                  onClick={() => setTagFilters(prev =>
                    prev.includes(tag.name) ? prev.filter(name => name !== tag.name) : [...prev, tag.name]
                  )}
                />
              ))}
              {(typeFilter !== null || tagFilters.length > 0) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => { setTypeFilter(null); setTagFilters([]); }}
                >
                  Clear filters
                </Button>
              )}
            </div>
          )}

          <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {filtered.length === catalogs.length
                ? `${catalogs.length} ${catalogs.length === 1 ? 'catalog' : 'catalogs'}`
                : `${filtered.length} of ${catalogs.length}`}
            </span>
            <span className="text-right">
              &uarr;&darr; move &middot; Enter {multiple ? 'ticks' : 'picks'}
              {multiple ? ' · Ctrl+Enter adds' : ''}
            </span>
          </div>

          <div
            ref={setScrollEl}
            onMouseMove={() => { pointerActive.current = true; }}
            className="mt-1.5 overflow-y-auto rounded-xl border border-border/70 bg-background/60 p-1 [scrollbar-color:hsl(var(--muted))_transparent] [scrollbar-width:thin]"
            style={filtered.length === 0 ? undefined : { height: Math.min(320, filtered.length * 40) + 10 }}
          >
            {filtered.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {catalogs.length === 0
                  ? 'No catalogs to pick from yet.'
                  : 'Nothing matches that search and those filters.'}
              </p>
            ) : (
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map(virtualRow => {
                  const catalog = filtered[virtualRow.index];
                  const key = catalogKey(catalog);
                  const isAdded = alreadyAdded.has(key);
                  const isSelected = selected.includes(key);
                  const isActive = virtualRow.index === activeIndex;
                  return (
                    <div
                      key={key}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: virtualRow.size,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <button
                        type="button"
                        disabled={isAdded}
                        aria-pressed={multiple && !isAdded ? isSelected : undefined}
                        onClick={() => toggle(catalog)}
                        onMouseEnter={() => { if (pointerActive.current) setActiveIndex(virtualRow.index); }}
                        className={`flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm transition-colors focus-visible:outline-none @2xl:h-9 @2xl:min-h-0 ${
                          isAdded
                            ? 'cursor-default opacity-45'
                            : isSelected
                              ? 'bg-primary/10'
                              : isActive
                                ? 'bg-muted/70'
                                : 'hover:bg-muted/40'
                        }`}
                      >
                        {multiple && (
                          isAdded ? (
                            <Check className="h-4 w-4 shrink-0 text-muted-foreground/70" />
                          ) : (
                            <span
                              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                                isSelected
                                  ? 'border-primary bg-primary text-primary-foreground'
                                  : 'border-muted-foreground/40'
                              }`}
                            >
                              {isSelected && <Check className="h-3 w-3" />}
                            </span>
                          )
                        )}
                        <span className={`h-2 w-2 shrink-0 rounded-full ${getSourceDotStyle(catalog.source)}`} aria-hidden="true" />
                        <span className={`min-w-0 flex-1 truncate ${isActive && !isAdded ? 'text-foreground' : 'text-foreground/90'}`}>{catalog.name}</span>
                        {isAdded && (
                          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">added</span>
                        )}
                        {catalog.pendingSave && (
                          <Badge
                            variant="outline"
                            className="shrink-0 rounded-md border-sky-400/25 bg-transparent px-1.5 py-0 text-[11px] font-medium text-sky-300/90"
                            title="In your config but not saved yet, so it is not in the manifest"
                          >
                            unsaved
                          </Badge>
                        )}
                        {catalog.genreRequired && (
                          <Badge variant="outline" className="shrink-0 rounded-md border-amber-400/25 bg-transparent px-1.5 py-0 text-[11px] font-medium text-amber-300/90">
                            genre
                          </Badge>
                        )}
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {getSourceBadgeLabel(catalog.source)}
                          <span className="hidden capitalize sm:inline"> · {catalog.type}</span>
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        {multiple && (!onCreate || tab === 'config') && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-3">
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xs text-muted-foreground">
                {selected.length === 0 ? 'Nothing selected' : `${selected.length} selected`}
              </span>
              {unselectedAddable.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={() => setSelected(prev => [...prev, ...unselectedAddable])}
                >
                  Select all {addable.length}
                </Button>
              )}
              {selected.length > 0 && (
                <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => setSelected([])}>
                  Clear
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
              <Button size="sm" disabled={selected.length === 0} onClick={confirm}>
                Add {selected.length > 0 ? selected.length : ''}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
