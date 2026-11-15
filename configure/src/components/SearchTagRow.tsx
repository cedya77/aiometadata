// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useMemo, useState } from 'react';
import { Check, Plus } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useConfig } from '@/contexts/ConfigContext';
import { useCatalogTags } from '@/hooks/useCatalogTags';
import { TagChip } from '@/components/TagChip';
import { cn } from '@/lib/utils';

/** The tags a search catalog carries, edited the way a catalog's are. */
export function SearchTagRow({ searchId, title, className }: { searchId: string; title: string; className?: string }) {
  const { config } = useConfig();
  const { tags, setSearchTag } = useCatalogTags();
  const [open, setOpen] = useState(false);

  const applied = useMemo(() => config.search?.tags?.[searchId] ?? [], [config.search?.tags, searchId]);
  const colorMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of tags) m[t.name] = t.color;
    return m;
  }, [tags]);

  if (tags.length === 0) return null;

  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1 align-middle', className)}>
      {applied.map(t => (
        <TagChip key={t} name={t} color={colorMap[t]} onRemove={() => setSearchTag(searchId, t, false)} />
      ))}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Edit tags for ${title}`}
        className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-muted-foreground/40 px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:border-foreground/60 hover:text-foreground"
      >
        <Plus className="h-3 w-3" />
        {applied.length === 0 && <span>Tag</span>}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="truncate">{title}</DialogTitle>
            <DialogDescription>
              An install naming tags carries this search only when it holds one of them. Tags are made in Catalogs.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[42vh] divide-y overflow-y-auto rounded-xl border">
            {tags.map(t => {
              const on = applied.some(a => a.toLowerCase() === t.name.toLowerCase());
              return (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => setSearchTag(searchId, t.name, !on)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
                >
                  <TagChip name={t.name} color={t.color} />
                  <span
                    className={cn(
                      'flex h-5 w-5 items-center justify-center rounded border',
                      on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40'
                    )}
                  >
                    {on && <Check className="h-3.5 w-3.5" />}
                  </span>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </span>
  );
}
