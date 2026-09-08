import { ChevronLeft, Layers, ListOrdered, Rows3 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import type { BuilderEntry } from '@shared/types';
import type { FeaturedCollection } from '@/lib/collectionBuilder/featured';

interface FeaturedDetailProps {
  featured: FeaturedCollection;
  entries: BuilderEntry[];
  index: number;
  busy: boolean;
  onSelect: (index: number) => void;
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
  onSelect,
  onBack,
  onImport,
  children,
}: FeaturedDetailProps) {
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
        <div className="max-h-56 min-w-0 space-y-0.5 overflow-y-auto rounded-xl bg-white/[0.03] p-2 @3xl:max-h-none @3xl:min-h-0">
          {entries.map((entry, at) => {
            const Icon = entry.kind === 'collection' ? Layers : entry.numbered ? ListOrdered : Rows3;
            return (
              <button
                key={entry.id || at}
                type="button"
                onClick={() => onSelect(at)}
                aria-pressed={at === index}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                  at === index ? 'bg-white/[0.08] text-foreground' : 'text-muted-foreground hover:bg-white/[0.04] active:bg-white/[0.06]'
                }`}
              >
                <Icon
                  className={`h-4 w-4 shrink-0 ${
                    entry.kind === 'collection' ? 'text-cyan-400' : 'text-violet-400'
                  }`}
                />
                <span className="truncate">{entry.title || 'Untitled'}</span>
              </button>
            );
          })}
        </div>

        <div className="min-w-0 overflow-x-auto rounded-xl border border-white/[0.06] bg-card/80 p-4 @3xl:min-h-0 @3xl:overflow-y-auto">
          {children}
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-dashed border-white/[0.08] p-3 @xl:flex-row @xl:items-center">
        <span className="text-xs text-amber-500 @xl:mr-auto">
          Just looking. Nothing is imported yet.
        </span>
        <Button className="shrink-0" disabled={busy} onClick={onImport}>Import this</Button>
      </div>
    </div>
  );
}
