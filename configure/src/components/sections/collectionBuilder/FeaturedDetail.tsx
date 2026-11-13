// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { Check, ChevronLeft, Layers, ListOrdered, Rows3 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import type { BuilderEntry } from '@shared/types';
import type { FeaturedCollection } from '@/lib/collectionBuilder/featured';
import { entryKey } from '@/lib/collectionBuilder/importSelection';

interface FeaturedDetailProps {
  featured: FeaturedCollection;
  entries: BuilderEntry[];
  index: number;
  busy: boolean;
  /** Entries left out of the import; everything is taken until unticked. */
  skipped: Set<string>;
  onSelect: (index: number) => void;
  onToggle: (key: string) => void;
  onSetAll: (included: boolean) => void;
  onBack: () => void;
  onImport: () => void;
  /** The same live preview the builder renders, for the entry in view. */
  children: ReactNode;
}

export function FeaturedDetail({
  featured,
  entries,
  index,
  busy,
  skipped,
  onSelect,
  onToggle,
  onSetAll,
  onBack,
  onImport,
  children,
}: FeaturedDetailProps) {
  const taken = entries.filter((entry, at) => !skipped.has(entryKey(entry, at))).length;
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-4 px-1 pb-6 @3xl:h-full">
      <div className="min-w-0 space-y-1">
        <Button variant="ghost" size="sm" className="-ml-2 h-7" onClick={onBack}>
          <ChevronLeft className="mr-1 h-4 w-4" /> All featured
        </Button>
        <h2 className="truncate text-base font-semibold">{featured.name}</h2>
        <p className="text-xs text-muted-foreground">
          by {featured.author} · {entries.length} {entries.length === 1 ? 'entry' : 'entries'} ·{' '}
          {featured.catalogs} catalogs
        </p>
      </div>

      <div className="grid min-w-0 gap-4 @3xl:min-h-0 @3xl:flex-1 @3xl:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="flex max-h-56 min-w-0 flex-col rounded-xl bg-white/[0.03] p-2 @3xl:max-h-none @3xl:min-h-0">
          <div className="flex items-center justify-between gap-2 px-2 pb-1.5 text-xs text-muted-foreground">
            <span>{taken} of {entries.length} selected</span>
            <span className="flex gap-2">
              <button type="button" className="hover:text-foreground disabled:opacity-40" disabled={taken === entries.length} onClick={() => onSetAll(true)}>All</button>
              <button type="button" className="hover:text-foreground disabled:opacity-40" disabled={taken === 0} onClick={() => onSetAll(false)}>None</button>
            </span>
          </div>
          <div className="min-h-0 space-y-0.5 overflow-y-auto">
            {entries.map((entry, at) => {
              const Icon = entry.kind === 'collection' ? Layers : entry.numbered ? ListOrdered : Rows3;
              const key = entryKey(entry, at);
              const included = !skipped.has(key);
              return (
                <div
                  key={key}
                  className={`flex w-full items-center gap-1 rounded-md transition-colors ${
                    at === index ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'
                  }`}
                >
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={included}
                    aria-label={`Import ${entry.title || 'Untitled'}`}
                    onClick={() => onToggle(key)}
                    className={`ml-1.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                      included ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background hover:border-primary/50'
                    }`}
                  >
                    {included && <Check className="h-3 w-3" strokeWidth={3} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelect(at)}
                    aria-pressed={at === index}
                    className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm ${
                      at === index ? 'text-foreground' : 'text-muted-foreground'
                    } ${included ? '' : 'opacity-50'}`}
                  >
                    <Icon
                      className={`h-4 w-4 shrink-0 ${
                        entry.kind === 'collection' ? 'text-cyan-400' : 'text-violet-400'
                      }`}
                    />
                    <span className="truncate">{entry.title || 'Untitled'}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="min-w-0 overflow-x-auto rounded-xl border border-white/[0.06] bg-card/80 p-4 @3xl:min-h-0 @3xl:overflow-y-auto">
          {children}
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-dashed border-white/[0.08] p-3 @xl:flex-row @xl:items-center">
        <span className="text-xs text-amber-500 @xl:mr-auto">
          Just looking. Nothing is imported yet.
        </span>
        <Button className="shrink-0" disabled={busy || taken === 0} onClick={onImport}>
          {taken === entries.length ? 'Import this' : `Import ${taken} of ${entries.length}`}
        </Button>
      </div>
    </div>
  );
}
