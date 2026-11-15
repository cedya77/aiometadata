// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  AlertTriangle,
  Pencil,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  ChevronUp,
  Copy,
  GripVertical,
  MoreVertical,
  Replace,
  Trash2,
} from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getSourceBadgeLabel, getSourceBadgeStyle } from '@/lib/sourceBadges';
import { catalogKey, type ManifestCatalog } from '@/lib/collectionBuilder/manifestSources';
import { isNativeSource, nativeLabel, nativeOrigin } from '@shared/catalogReconstruction';
import type { SourceDraft } from '@shared/types';

export function ReorderArrows({
  label,
  canMoveUp,
  canMoveDown,
  onMove,
}: {
  label: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: number) => void;
}) {
  const buttonClass =
    'flex h-3.5 w-4 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-25';
  return (
    <div className="flex shrink-0 flex-col">
      <button
        type="button"
        className={buttonClass}
        disabled={!canMoveUp}
        onClick={() => onMove(-1)}
        title={`Move ${label} up`}
        aria-label={`Move ${label} up`}
      >
        <ChevronUp className="h-3 w-3" />
      </button>
      <button
        type="button"
        className={buttonClass}
        disabled={!canMoveDown}
        onClick={() => onMove(1)}
        title={`Move ${label} down`}
        aria-label={`Move ${label} down`}
      >
        <ChevronDown className="h-3 w-3" />
      </button>
    </div>
  );
}

export function RowActions({
  label,
  canMoveUp,
  canMoveDown,
  onDuplicate,
  onMoveTo,
  onDelete,
  deleteLabel,
  open,
  onOpenChange,
}: {
  label: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onDuplicate: () => void;
  onMoveTo: (position: 'top' | 'bottom') => void;
  /** Omitted where the row already carries its own delete control. */
  onDelete?: () => void;
  deleteLabel?: string;
  /** Controlled, so the row it sits on can open it from a long press. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={`More actions for ${label}`}
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onDuplicate}>
          <Copy className="mr-2 h-3.5 w-3.5" /> Duplicate
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canMoveUp} onClick={() => onMoveTo('top')}>
          <ChevronsUp className="mr-2 h-3.5 w-3.5" /> Move to top
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canMoveDown} onClick={() => onMoveTo('bottom')}>
          <ChevronsDown className="mr-2 h-3.5 w-3.5" /> Move to bottom
        </DropdownMenuItem>
        {onDelete && (
          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onDelete}>
            <Trash2 className="mr-2 h-3.5 w-3.5" /> {deleteLabel ?? 'Delete'}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SourceRow({
  source,
  catalogs,
  pendingKeys,
  onChange,
  onRemove,
  onReplace,
  onRename,
  innerRef,
  style,
  leading,
}: {
  source: SourceDraft;
  catalogs: ManifestCatalog[];
  /** Sources an apply would add a catalog for, so not missing, just not saved yet. */
  pendingKeys?: Set<string>;
  onChange: (next: SourceDraft) => void;
  onRemove: () => void;
  /** Swap this one for a catalog the user has. */
  onReplace?: () => void;
  /**
   * Renames the catalog itself, everywhere it appears, not just this row. Also
   * offered on a source whose catalog an apply would add, which names it before
   * it is created. Absent for native sources and for ones pointing at a catalog
   * that will never exist, since neither has a catalog to name.
   */
  onRename?: (name: string) => void;
  innerRef?: (node: HTMLElement | null) => void;
  style?: CSSProperties;
  /** Reorder controls, where the row is one of several in a folder. */
  leading?: ReactNode;
}) {
  const native = isNativeSource(source);
  const match = native ? undefined : catalogs.find(catalog => catalogKey(catalog) === catalogKey(source));
  const genres = match?.genres || [];
  const genreRequired = Boolean(match?.genreRequired);
  const pending = !native && !match && Boolean(pendingKeys?.has(catalogKey(source)));
  const unknown = !native && !match && !pending;
  const label = match?.name || source.name || source.catalogId;
  const canRename = Boolean(onRename) && !native && (Boolean(match) || pending);

  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(label);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renaming) {
      setDraftName(label);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renaming, label]);

  const commitRename = () => {
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== label) onRename?.(trimmed);
    setRenaming(false);
  };

  return (
    <div
      ref={innerRef}
      style={style}
      className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-lg px-3 py-2.5 transition-colors @md:grid-cols-[auto_minmax(0,1fr)_auto_auto] ${
        unknown
          ? 'bg-amber-500/10 ring-1 ring-inset ring-amber-400/25'
          : pending ? 'bg-emerald-500/10 ring-1 ring-inset ring-emerald-400/25' : 'bg-white/[0.03]'
      }`}
    >
      <div className="flex items-center gap-2">
        {leading}
        {unknown && <AlertTriangle className="h-4 w-4 text-amber-500" />}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {renaming ? (
            <Input
              ref={inputRef}
              value={draftName}
              onChange={event => setDraftName(event.target.value)}
              onBlur={commitRename}
              onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); commitRename(); }
                if (event.key === 'Escape') { event.preventDefault(); setRenaming(false); }
              }}
              aria-label={`Rename ${label}`}
              className="h-7 min-w-0 text-sm"
            />
          ) : (
            <span className="truncate text-sm">{label}</span>
          )}
          {!native && source.catalogId !== label && (
            <span className="truncate text-xs text-muted-foreground">{source.catalogId}</span>
          )}
        </div>
        {native ? (
          <>
            <Badge variant="outline" className="text-xs font-semibold">{nativeLabel(source)}</Badge>
            <span className="text-xs text-muted-foreground">
              served by {nativeOrigin(source) === 'fusion' ? 'Fusion' : 'Nuvio'}
            </span>
          </>
        ) : pending ? (
          <span className="text-xs text-emerald-500">added on apply</span>
        ) : unknown ? (
          <span className="text-xs text-amber-500">not in your catalogs</span>
        ) : (
          <Badge variant="outline" className={`text-xs font-semibold ${getSourceBadgeStyle(match?.source)}`}>
            {getSourceBadgeLabel(match?.source)}
          </Badge>
        )}
        <Badge variant="outline" className="text-xs">{source.type}</Badge>
      </div>

      <div className="col-start-2 flex items-center gap-2 @md:col-start-3">
        {unknown && onReplace && (
          <Button
            size="sm"
            variant="outline"
            className="h-8 border-0 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25"
            onClick={onReplace}
          >
            <Replace className="mr-1.5 h-4 w-4" /> Replace
          </Button>
        )}
        {genres.length > 0 && (
          <Select
            value={source.genre || '__all__'}
            onValueChange={value => onChange({ ...source, genre: value === '__all__' ? null : value })}
          >
            <SelectTrigger
              className={`h-9 w-44 ${genreRequired && !source.genre ? 'border-amber-500' : ''}`}
            >
              <SelectValue placeholder={genreRequired ? 'Pick a genre' : 'All genres'} />
            </SelectTrigger>
            <SelectContent>
              {!genreRequired && <SelectItem value="__all__">All genres</SelectItem>}
              {genres.map(genre => (
                <SelectItem key={genre} value={genre}>{genre}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {canRename ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="col-start-3 row-start-1 h-8 w-8 @md:col-start-4"
              aria-label={`Actions for ${label}`}
            >
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={event => { event.preventDefault(); setRenaming(true); }}>
              <Pencil className="mr-2 h-3.5 w-3.5" /> Rename catalog
            </DropdownMenuItem>
            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onRemove}>
              <Trash2 className="mr-2 h-3.5 w-3.5" /> Remove from folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="col-start-3 row-start-1 h-8 w-8 @md:col-start-4"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

export function SortableSourceRow({
  id,
  label,
  canMoveUp,
  canMoveDown,
  onMove,
  ...rest
}: {
  id: string;
  label: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: number) => void;
  source: SourceDraft;
  catalogs: ManifestCatalog[];
  pendingKeys?: Set<string>;
  onChange: (next: SourceDraft) => void;
  onRemove: () => void;
  onReplace?: () => void;
  onRename?: (name: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  return (
    <SourceRow
      {...rest}
      innerRef={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 50 : 'auto',
      }}
      leading={
        <>
          <ReorderArrows
            label={label}
            canMoveUp={canMoveUp}
            canMoveDown={canMoveDown}
            onMove={onMove}
          />
          <button
            type="button"
            className="cursor-grab touch-none text-muted-foreground"
            aria-label={`Drag ${label} to reorder`}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        </>
      }
    />
  );
}
