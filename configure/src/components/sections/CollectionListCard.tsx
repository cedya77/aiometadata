import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowUpRight, GripVertical, Layers } from 'lucide-react';
import { useConfig } from '@/contexts/ConfigContext';
import { TagChip } from '@/components/TagChip';
import { cn } from '@/lib/utils';
import type { CollectionDraft, FolderDraft } from '@shared/types';

const STRIP = 6;
const GAP = 8;
const MORE_WIDTH = 56;
const TINTS = ['bg-violet-500/25', 'bg-indigo-500/25', 'bg-cyan-500/20', 'bg-amber-500/20', 'bg-rose-500/20', 'bg-emerald-500/20'];
const SHAPES: Record<string, string> = { POSTER: 'w-10', LANDSCAPE: 'w-[92px]', SQUARE: 'w-14' };
const WIDTHS: Record<string, number> = { POSTER: 40, LANDSCAPE: 92, SQUARE: 56 };

function fittingCount(folders: FolderDraft[], width: number): number {
  const limit = Math.min(folders.length, STRIP);
  if (!width) return limit;
  let used = 0;
  for (let index = 0; index < limit; index++) {
    const next = used + (index ? GAP : 0) + (WIDTHS[folders[index].shape] ?? WIDTHS.LANDSCAPE);
    const left = folders.length - index - 1;
    if (next + (left ? GAP + MORE_WIDTH : 0) > width) return index;
    used = next;
  }
  return limit;
}

export function collectionListKey(collection: { id: string }): string {
  return `collection:${collection.id}`;
}

function FolderTile({ folder, index }: { folder: FolderDraft; index: number }) {
  const width = SHAPES[folder.shape] ?? SHAPES.LANDSCAPE;
  if (folder.coverImageUrl) {
    return (
      <img
        src={folder.coverImageUrl}
        alt={folder.title}
        loading="lazy"
        className={cn('h-14 shrink-0 rounded-lg border border-white/[0.08] object-cover', width)}
      />
    );
  }
  return (
    <span
      className={cn(
        'flex h-14 shrink-0 items-end overflow-hidden rounded-lg border border-white/[0.08] px-1.5 pb-1 text-[11px] font-semibold leading-tight text-foreground/90',
        width,
        TINTS[index % TINTS.length]
      )}
    >
      <span className="line-clamp-2">{folder.coverEmoji ? `${folder.coverEmoji} ` : ''}{folder.title}</span>
    </span>
  );
}

export const CollectionListCard = memo(function CollectionListCard({
  collection,
  onEdit,
}: {
  collection: CollectionDraft;
  onEdit: (collection: CollectionDraft) => void;
}) {
  const { config } = useConfig();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: collectionListKey(collection) });
  const folders = Array.isArray(collection.folders) ? collection.folders : [];
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [stripWidth, setStripWidth] = useState(0);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setStripWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const shown = folders.slice(0, fittingCount(folders, stripWidth));
  const more = folders.length - shown.length;
  const tagColors = useMemo(() => new Map((config.tags ?? []).map(tag => [tag.name.toLowerCase(), tag.color])), [config.tags]);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'relative flex items-start gap-2 rounded-xl border border-purple-400/25 bg-purple-500/[0.05] p-4 sm:gap-3',
        'transition-all duration-200 ease-out',
        isDragging ? 'z-10 scale-[1.02] opacity-90 shadow-2xl ring-2 ring-purple-400/50' : 'hover:-translate-y-[1px] hover:bg-purple-500/[0.08] hover:shadow-md'
      )}
    >
      <span aria-hidden="true" className="w-7 shrink-0 sm:w-8" />
      <button
        {...attributes}
        {...listeners}
        className="-ml-2 cursor-grab touch-none p-2 text-purple-300/60 hover:text-purple-200"
        aria-label={`Drag to reorder ${collection.title}`}
      >
        <GripVertical />
      </button>

      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-purple-500/20 text-purple-200">
            <Layers className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-2.5">
            <p className="truncate font-semibold leading-8 text-foreground sm:leading-normal">{collection.title || 'Untitled collection'}</p>
            <p className="shrink-0 text-xs text-purple-200/70">
              Collection · {folders.length} {folders.length === 1 ? 'folder' : 'folders'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onEdit(collection)}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-purple-400/30 px-3 text-sm text-purple-100 transition-colors hover:bg-purple-500/15 active:bg-purple-500/20"
          >
            Edit
            <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {folders.length > 0 && (
          <div ref={stripRef} className="flex items-center gap-2 overflow-hidden">
            {shown.map((folder, index) => (
              <FolderTile key={folder.id} folder={folder} index={index} />
            ))}
            {more > 0 && (
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-dashed border-purple-400/30 text-xs text-purple-200/70">
                +{more}
              </span>
            )}
          </div>
        )}

        {(collection.tags?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {collection.tags!.map(tag => (
              <TagChip key={tag} name={tag} color={tagColors.get(tag.toLowerCase())} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
