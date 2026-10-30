import { useState } from 'react';
import { Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCatalogTags } from '@/hooks/useCatalogTags';
import { TagChip } from '@/components/TagChip';
import { TagManagerDialog } from '@/components/TagManagerDialog';

export type CollectionFilter = 'all' | 'in' | 'out';
export type ListKind = 'all' | 'catalogs' | 'collections';

const LIST_KIND_OPTIONS: Array<{ value: ListKind; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'catalogs', label: 'Catalogs' },
  { value: 'collections', label: 'Collections' },
];

const COLLECTION_OPTIONS: Array<{ value: CollectionFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'in', label: 'In a collection' },
  { value: 'out', label: 'Not in one' },
];

interface TagFilterBarProps {
  tagFilters: string[];
  onToggle: (name: string) => void;
  onClear: () => void;
  collectionFilter?: CollectionFilter;
  onCollectionFilterChange?: (value: CollectionFilter) => void;
  collectionCounts?: { in: number; out: number };
  listKind?: ListKind;
  onListKindChange?: (value: ListKind) => void;
}

export function TagFilterBar({
  tagFilters,
  onToggle,
  onClear,
  collectionFilter = 'all',
  onCollectionFilterChange,
  collectionCounts,
  listKind = 'all',
  onListKindChange,
}: TagFilterBarProps) {
  const { tags, tagCounts } = useCatalogTags();
  const [managerOpen, setManagerOpen] = useState(false);

  const showCollections = !!onCollectionFilterChange && !!collectionCounts;
  const showKinds = !!onListKindChange;
  if (tags.length === 0 && !showCollections && !showKinds) return null;

  const hasFilter = tagFilters.length > 0;

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-muted/30 px-2.5 py-2">
      {showKinds && (
        <div className="mr-1 flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Show:</span>
          <div className="flex items-center rounded-md bg-white/[0.02] p-0.5">
            {LIST_KIND_OPTIONS.map(option => {
              const active = listKind === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onListKindChange!(option.value)}
                  aria-pressed={active}
                  className={`rounded px-2 py-1 text-xs transition-colors ${active
                    ? 'bg-card/80 text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground active:bg-white/[0.04]'}`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {showCollections && (
        <div className="mr-1 flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Collections:</span>
          <div className="flex items-center rounded-md bg-white/[0.02] p-0.5">
            {COLLECTION_OPTIONS.map(option => {
              const active = collectionFilter === option.value;
              const count = option.value === 'all' ? null : collectionCounts![option.value];
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onCollectionFilterChange!(option.value)}
                  aria-pressed={active}
                  className={`rounded px-2 py-1 text-xs transition-colors ${active
                    ? 'bg-card/80 text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground active:bg-white/[0.04]'}`}
                >
                  {option.label}{count === null ? '' : ` (${count})`}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {tags.length > 0 && (
        <span className="mr-1 text-xs font-medium text-muted-foreground">Tags:</span>
      )}
      {tags.map((t) => {
        const active = tagFilters.includes(t.name);
        return (
          <TagChip
            key={t.name}
            name={`${t.name} (${tagCounts[t.name] || 0})`}
            color={t.color}
            onClick={() => onToggle(t.name)}
            dimmed={hasFilter && !active}
          />
        );
      })}
      {hasFilter && (
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onClear}>
          Clear
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="ml-auto h-7 w-7 text-muted-foreground"
        onClick={() => setManagerOpen(true)}
        aria-label="Manage tags"
      >
        <Settings2 className="h-4 w-4" />
      </Button>
      <TagManagerDialog open={managerOpen} onOpenChange={setManagerOpen} />
    </div>
  );
}
