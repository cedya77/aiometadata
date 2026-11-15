// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, Check, Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  MDBListKeyRejected,
  TRUSTED_CURATORS,
  fetchCuratorLists,
  fetchListPosters,
  type CuratorList,
  type CuratorProfile,
  type CuratorSort,
} from '@/lib/setup/curators';
import { cn } from '@/lib/utils';
import { SelectAllControl } from '@/components/SelectAllControl';
import { KeyUnlock } from './KeyUnlock';

const SORT_LABELS: Record<CuratorSort, string> = {
  ranked: "Curator's order",
  name: 'A to Z',
  created: 'Date created',
};

function Monogram({ text, dimmed }: { text: string; dimmed?: boolean }) {
  return (
    <div
      className={cn(
        'flex aspect-[16/9] items-center justify-center bg-[linear-gradient(135deg,rgba(255,255,255,0.07),rgba(255,255,255,0.02))]',
        dimmed && 'opacity-60'
      )}
      aria-hidden="true"
    >
      <span className="text-2xl font-semibold tracking-[0.2em] text-white/25">{text}</span>
    </div>
  );
}

function PosterMosaic({ posters }: { posters: string[] }) {
  return (
    <div className="grid aspect-[16/9] grid-cols-4 gap-px bg-white/[0.04]" aria-hidden="true">
      {posters.slice(0, 4).map((poster, index) => (
        <div key={index} className="overflow-hidden bg-white/[0.03]">
          <img src={poster} alt="" loading="lazy" className="h-full w-full object-cover opacity-90" />
        </div>
      ))}
    </div>
  );
}

function CuratorCard({
  curator,
  lists,
  posters,
  selectedCount,
  locked,
  loading,
  onOpen,
}: {
  curator: CuratorProfile;
  lists: CuratorList[] | undefined;
  posters: string[] | undefined;
  selectedCount: number;
  locked: boolean;
  loading: boolean;
  onOpen: () => void;
}) {
  const preview = (lists ?? []).slice(0, 3).map(list => list.name);

  return (
    <button
      type="button"
      disabled={locked}
      onClick={onOpen}
      className={cn(
        'group flex flex-col overflow-hidden rounded-2xl border text-left transition-all duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        locked
          ? 'cursor-default border-white/[0.06] bg-white/[0.02]'
          : 'border-white/[0.08] bg-white/[0.02] hover:border-white/20',
        selectedCount > 0 && 'border-primary/50 bg-primary/[0.06]'
      )}
    >
      <div className="relative">
        {posters?.length
          ? <PosterMosaic posters={posters} />
          : <Monogram text={curator.monogram} dimmed={locked} />}
        {locked && (
          <span className="absolute inset-0 flex items-center justify-center">
            <Lock className="h-4 w-4 text-white/30" aria-hidden="true" />
          </span>
        )}
        {loading && (
          <span className="absolute inset-0 flex items-center justify-center bg-background/40">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
          </span>
        )}
        {selectedCount > 0 && (
          <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground">
            <Check className="h-3 w-3" aria-hidden="true" />
            {selectedCount}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium">
            {curator.emoji && <span aria-hidden="true">{curator.emoji} </span>}
            {curator.name}
          </span>
          {lists && (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {lists.length} lists
            </span>
          )}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{curator.description}</p>
        {preview.length > 0 && (
          <ul className="mt-auto space-y-0.5 text-xs text-muted-foreground/80">
            {preview.map(name => <li key={name} className="truncate">{name}</li>)}
          </ul>
        )}
      </div>
    </button>
  );
}

export function CuratorGallery({
  storedKey,
  catalogTTL,
  selectedKeys,
  onSelectionChange,
  onKeyValidated,
}: {
  storedKey: string | undefined;
  catalogTTL: number;
  selectedKeys: Set<string>;
  onSelectionChange: (lists: CuratorList[]) => void;
  onKeyValidated: (key: string) => void;
}) {
  const [keyInput, setKeyInput] = useState('');
  const [apiKey, setApiKey] = useState(storedKey?.trim() || '');
  const [sort, setSort] = useState<CuratorSort>('ranked');
  const [listsByCurator, setListsByCurator] = useState<Record<string, CuratorList[]>>({});
  const [loadingUsername, setLoadingUsername] = useState<string | null>(null);
  const [openCurator, setOpenCurator] = useState<CuratorProfile | null>(null);
  const [allLists, setAllLists] = useState<CuratorList[]>([]);
  const [postersByCurator, setPostersByCurator] = useState<Record<string, string[]>>({});
  const [failed, setFailed] = useState<string[]>([]);
  const loadedFor = useRef<string | null>(null);

  const locked = !apiKey;

  const loadAll = async (key: string, nextSort: CuratorSort = sort) => {
    setLoadingUsername('*');
    try {
      const results = await Promise.all(
        TRUSTED_CURATORS.map(async curator => {
          try {
            return { curator, lists: await fetchCuratorLists(curator, key, nextSort) };
          } catch (error) {
            if (error instanceof MDBListKeyRejected) throw error;
            return { curator, lists: null };
          }
        })
      );

      const next: Record<string, CuratorList[]> = {};
      const flat: CuratorList[] = [];
      const broken: string[] = [];
      for (const { curator, lists } of results) {
        if (lists === null) {
          broken.push(curator.name);
          continue;
        }
        next[curator.username] = lists;
        flat.push(...lists);
      }

      setListsByCurator(next);
      setAllLists(flat);
      setFailed(broken);
      void loadCoverArt(next, key);
    } catch (error) {
      if (error instanceof MDBListKeyRejected) {
        setApiKey('');
        toast.error('MDBList rejected that key', { description: 'Check it and try again.' });
        return;
      }
      toast.error('Could not reach MDBList', {
        description: error instanceof Error ? error.message : 'Unknown error.',
      });
    } finally {
      setLoadingUsername(null);
    }
  };

  useEffect(() => {
    const key = storedKey?.trim();
    if (!key || loadedFor.current === key) return;
    loadedFor.current = key;
    setApiKey(key);
    void loadAll(key);
  }, [storedKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const loadCoverArt = async (byCurator: Record<string, CuratorList[]>, key: string) => {
    const entries = await Promise.all(
      Object.entries(byCurator).map(async ([username, lists]) => {
        const top = lists[0];
        if (!top) return [username, [] as string[]] as const;
        return [username, await fetchListPosters(top.id, key).catch(() => [])] as const;
      })
    );
    setPostersByCurator(Object.fromEntries(entries));
  };

  const unlock = (validated: string) => {
    loadedFor.current = validated;
    setApiKey(validated);
    onKeyValidated(validated);
    void loadAll(validated);
  };

  const changeSort = (next: CuratorSort) => {
    setSort(next);
    if (apiKey) void loadAll(apiKey, next);
  };

  const openLists = openCurator ? (listsByCurator[openCurator.username] ?? []) : [];
  const openInViewSelected = openLists.filter(list => selectedKeys.has(list.selectionKey)).length;

  const commit = (keys: Set<string>) => {
    onSelectionChange(allLists.filter(list => keys.has(list.selectionKey)));
  };

  const toggle = (list: CuratorList) => {
    const next = new Set(selectedKeys);
    if (next.has(list.selectionKey)) next.delete(list.selectionKey);
    else next.add(list.selectionKey);
    commit(next);
  };

  /** Scoped to the curator on screen, so it cannot silently touch another one's picks. */
  const setAllInView = (selected: boolean) => {
    const next = new Set(selectedKeys);
    for (const list of openLists) {
      if (selected) next.add(list.selectionKey);
      else next.delete(list.selectionKey);
    }
    commit(next);
  };


  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-medium tracking-tight">Or start from a curator</h2>
          <p className="text-sm text-muted-foreground">
            Collections maintained by people who do this all day. Add them alongside your lineup.
          </p>
        </div>
        {!locked && !openCurator && (
          <Select value={sort} onValueChange={value => changeSort(value as CuratorSort)}>
            <SelectTrigger className="h-8 w-40 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABELS) as CuratorSort[]).map(value => (
                <SelectItem key={value} value={value}>{SORT_LABELS[value]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {locked && (
        <div className="space-y-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <p className="text-sm">Add an MDBList key to browse and import these.</p>
          <KeyUnlock
            keyId="mdblist"
            value={keyInput}
            onChange={setKeyInput}
            onValidated={unlock}
            submitLabel="Unlock"
            note="Free up to 1000 calls a day. Your key stays in your own configuration."
          />
        </div>
      )}

      <AnimatePresence mode="wait" initial={false}>
        {openCurator ? (
          <motion.div
            key="lists"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="space-y-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setOpenCurator(null)}>
                <ArrowLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                All curators
              </Button>
              <span className="text-sm text-muted-foreground">
                {openCurator.emoji && <span aria-hidden="true">{openCurator.emoji} </span>}
                {openCurator.name} · {openLists.length} lists
              </span>
              {openLists.length > 0 && (
                <div className="ml-auto flex items-center gap-2">
                  <SelectAllControl
                    totalVisible={openLists.length}
                    selectedCount={openInViewSelected}
                    onSelectAll={() => setAllInView(true)}
                    onDeselectAll={() => setAllInView(false)}
                  />
                  <span className="text-xs text-muted-foreground">
                    {openInViewSelected} of {openLists.length} selected
                  </span>
                </div>
              )}
            </div>

            {openLists.length === 0 ? (
              <p className="rounded-lg border border-white/[0.06] p-4 text-sm text-muted-foreground">
                {failed.includes(openCurator.name)
                  ? 'Could not reach MDBList for this curator. Try again in a moment.'
                  : 'No public lists from this curator right now.'}
              </p>
            ) : (
              <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                {openLists.map(list => {
                  const checked = selectedKeys.has(list.selectionKey);
                  return (
                    <button
                      key={list.selectionKey}
                      type="button"
                      onClick={() => toggle(list)}
                      aria-pressed={checked}
                      className={cn(
                        'flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                        checked
                          ? 'border-primary/50 bg-primary/[0.07]'
                          : 'border-transparent hover:bg-white/[0.03]'
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-white/20'
                        )}
                        aria-hidden="true"
                      >
                        {checked && <Check className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{list.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {list.mediatype === 'movie' ? 'Movies' : 'Series'}
                          {typeof list.items === 'number' ? ` · ${list.items} items` : ''}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </motion.div>
        ) : (
          <motion.div
            key="curators"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          >
            {TRUSTED_CURATORS.map(curator => (
              <CuratorCard
                key={curator.username}
                curator={curator}
                lists={listsByCurator[curator.username]}
                posters={postersByCurator[curator.username]}
                selectedCount={
                  (listsByCurator[curator.username] ?? []).filter(l => selectedKeys.has(l.selectionKey)).length
                }
                locked={locked}
                loading={loadingUsername === '*' || loadingUsername === curator.username}
                onOpen={() => setOpenCurator(curator)}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {failed.length > 0 && (
        <p className="text-xs text-amber-400">
          Could not load {failed.join(', ')}. The rest are shown above.
        </p>
      )}

      {!locked && selectedKeys.size > 0 && (
        <p className="text-xs text-muted-foreground">
          {selectedKeys.size} list{selectedKeys.size === 1 ? '' : 's'} will be added as catalogs.
        </p>
      )}
    </section>
  );
}
