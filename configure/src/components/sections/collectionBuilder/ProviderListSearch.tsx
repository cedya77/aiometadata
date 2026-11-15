// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useCallback, useState } from 'react';
import { Loader2, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfig, type CatalogConfig } from '@/contexts/ConfigContext';
import {
  createMDBListCatalog,
  createTvdbListCatalogs,
  createTmdbCollectionCatalog,
  getMdbListType,
} from '@/utils/catalogUtils';

export type ListProvider = 'mdblist' | 'tvdb' | 'tmdb';

export const PROVIDER_LABELS: Record<ListProvider, string> = {
  mdblist: 'MDBList',
  tvdb: 'TheTVDB',
  tmdb: 'TMDB',
};

interface ProviderResult {
  key: string;
  name: string;
  subtitle: string;
  image?: string;
  raw: any;
}

const PLACEHOLDERS: Record<ListProvider, string> = {
  mdblist: 'Search public MDBList lists',
  tvdb: 'Search TheTVDB lists',
  tmdb: 'Search TMDB collections',
};

function typeLabel(type: string): string {
  if (type === 'all') return 'Movies and series';
  if (type === 'movie') return 'Movies';
  if (type === 'series') return 'Series';
  return type;
}

export function ProviderListSearch({
  provider,
  onCreate,
}: {
  provider: ListProvider;
  onCreate: (created: CatalogConfig[]) => void;
}) {
  const { config, catalogTTL, auth } = useConfig();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProviderResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [addingKey, setAddingKey] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const params = useCallback(
    (extra: Record<string, string>) => {
      const search = new URLSearchParams(extra);
      if (provider === 'mdblist' && config.apiKeys?.mdblist) search.set('apikey', config.apiKeys.mdblist);
      if (provider === 'tvdb' && config.apiKeys?.tvdb) search.set('apikey', config.apiKeys.tvdb);
      if (provider === 'tmdb') {
        if (config.apiKeys?.tmdb) search.set('apikey', config.apiKeys.tmdb);
        search.set('language', config.language || 'en-US');
      }
      if (auth?.userUUID) search.set('userUUID', auth.userUUID);
      return search.toString();
    },
    [provider, config.apiKeys, config.language, auth?.userUUID]
  );

  const runSearch = useCallback(async () => {
    const needle = query.trim();
    if (!needle) return;

    setIsSearching(true);
    try {
      if (provider === 'mdblist') {
        const res = await fetch(`/api/mdblist/lists/search?${params({ query: needle, limit: '40' })}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Search failed');
        setResults(
          (data.results || []).map((list: any) => ({
            key: `mdblist:${list.id}`,
            name: list.name,
            subtitle: `${list.user_name || 'unknown'} · ${list.items ?? 0} items · ${typeLabel(getMdbListType(list))}`,
            raw: list,
          }))
        );
      } else if (provider === 'tvdb') {
        const res = await fetch(`/api/tvdb/lists/search?${params({ query: needle })}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Search failed');
        setResults(
          (data.results || []).map((list: any) => ({
            key: `tvdb:${list.id}`,
            name: list.name,
            subtitle: [
              list.movieCount ? `${list.movieCount} movies` : '',
              list.seriesCount ? `${list.seriesCount} series` : '',
            ]
              .filter(Boolean)
              .join(' · ') || 'Empty',
            image: list.image,
            raw: list,
          }))
        );
      } else {
        const res = await fetch(`/api/tmdb/collections/search?${params({ query: needle })}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Search failed');
        setResults(
          (data.results || []).map((collection: any) => ({
            key: `tmdb:${collection.id}`,
            name: collection.name,
            subtitle: 'Movie collection',
            image: collection.poster,
            raw: collection,
          }))
        );
      }
      setSearched(true);
    } catch (error: any) {
      toast.error(`${PROVIDER_LABELS[provider]} search failed`, { description: error.message });
    } finally {
      setIsSearching(false);
    }
  }, [provider, query, params]);

  const add = useCallback(
    async (result: ProviderResult) => {
      setAddingKey(result.key);
      try {
        let created: CatalogConfig[] = [];

        if (provider === 'mdblist') {
          created = [
            createMDBListCatalog({
              list: result.raw,
              displayTypeOverrides: config.displayTypeOverrides,
            }),
          ];
        } else if (provider === 'tvdb') {
          created = createTvdbListCatalogs({
            list: result.raw,
            mode: 'all',
            displayTypeOverrides: config.displayTypeOverrides,
          });
        } else {
          // Search results carry no part count, and the catalog wants one.
          const res = await fetch(`/api/tmdb/collections/resolve?${params({ input: String(result.raw.id) })}`);
          const collection = await res.json();
          if (!res.ok) throw new Error(collection.error || 'Could not load that collection');
          created = [
            createTmdbCollectionCatalog({
              collection,
              displayTypeOverrides: config.displayTypeOverrides,
            }),
          ];
        }

        if (!created.length) {
          throw new Error('That list has nothing in it');
        }

        const existing = new Set(config.catalogs.map(c => `${c.id}:${c.type}`));
        if (created.every(c => existing.has(`${c.id}:${c.type}`))) {
          toast.info('Already in your catalogs', { description: 'Find it under Your catalogs' });
          return;
        }

        onCreate(created);
      } catch (error: any) {
        toast.error('Could not add that list', { description: error.message });
      } finally {
        setAddingKey(null);
      }
    },
    [provider, catalogTTL, config.displayTypeOverrides, config.catalogs, onCreate, params]
  );

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex gap-2">
        <Input
          placeholder={PLACEHOLDERS[provider]}
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              runSearch();
            }
          }}
          className="h-9"
        />
        <Button size="sm" variant="secondary" className="h-9" onClick={runSearch} disabled={!query.trim() || isSearching}>
          {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {results.length > 0 ? (
          <div className="space-y-2">
            {results.map(result => {
              const alreadyAdded = config.catalogs.some(
                catalog => catalog.name === result.name && catalog.source === provider
              );
              return (
                <div
                  key={result.key}
                  className="flex items-center gap-3 rounded-lg bg-white/[0.03] p-2.5 transition-colors hover:bg-white/[0.06]"
                >
                  {result.image ? (
                    <img src={result.image} alt="" loading="lazy" className="h-14 w-10 shrink-0 rounded object-cover" />
                  ) : (
                    <div className="h-14 w-10 shrink-0 rounded bg-muted" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{result.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{result.subtitle}</div>
                  </div>
                  {alreadyAdded && (
                    <Badge variant="outline" className="shrink-0 text-xs">
                      added
                    </Badge>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 shrink-0"
                    onClick={() => add(result)}
                    disabled={addingKey === result.key}
                  >
                    {addingKey === result.key ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Plus className="mr-1 h-4 w-4" /> Add
                      </>
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {isSearching
              ? 'Searching'
              : searched
                ? 'Nothing matched that search'
                : `Search ${PROVIDER_LABELS[provider]} to add a list without leaving the builder`}
          </p>
        )}
      </div>
    </div>
  );
}
