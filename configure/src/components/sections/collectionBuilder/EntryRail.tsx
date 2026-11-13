// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AlertTriangle, ChevronRight, GripVertical, Tv, type LucideIcon } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import type { IssueSeverity } from '@/lib/collectionBuilder/issueCenter';
import { ScopeChip } from './ScopeChip';
import { RowActions } from './SourceRow';

/**
 * One row for both levels of the rail tree. Entries and folders differed only
 * in depth and in which controls they carried, and keeping two near-identical
 * components in step across two files had already drifted once.
 */
export function SortableTreeRow({
  id,
  depth,
  title,
  placeholder,
  count,
  countHint,
  empty,
  icon: Icon,
  accent,
  severity,
  allNative,
  excluded,
  isActive,
  isAncestor,
  expanded,
  onToggleExpand,
  canMoveUp,
  canMoveDown,
  onMoveTo,
  onDuplicate,
  onSelect,
  onDelete,
}: {
  id: string;
  depth: 0 | 1;
  title: string;
  placeholder: string;
  /** Prepared by the caller: "6 · 36" at depth 0, "6" at depth 1. */
  count: string;
  /** Spelled out for the tooltip, where the row has no room to say it. */
  countHint?: string;
  empty: boolean;
  icon: LucideIcon;
  accent: string;
  severity?: IssueSeverity;
  allNative?: boolean;
  excluded?: 'nuvio' | 'jellyfin' | null;
  isActive: boolean;
  /** A descendant is selected: mark this row without claiming the selection. */
  isAncestor?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveTo: (position: 'top' | 'bottom') => void;
  onDuplicate: () => void;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : 'auto',
  };

  /**
   * Dragging is on the grip alone, so a press on the row itself is free to open
   * the same menu the dots do. A right click gets it too, and preventing the
   * default stops the browser's own callout from covering it on a phone.
   */
  const [menuOpen, setMenuOpen] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const pressFrom = useRef<{ x: number; y: number } | null>(null);

  const endPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    pressFrom.current = null;
  };

  const beginPress = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse') return;
    endPress();
    pressFrom.current = { x: event.clientX, y: event.clientY };
    pressTimer.current = window.setTimeout(() => setMenuOpen(true), 450);
  };

  // A press that turns into a scroll is not a press.
  const trackPress = (event: ReactPointerEvent<HTMLDivElement>) => {
    const from = pressFrom.current;
    if (!from) return;
    if (Math.abs(event.clientX - from.x) > 10 || Math.abs(event.clientY - from.y) > 10) endPress();
  };

  // Reserved tracks rather than conditional rendering, so revealing a control
  // on hover does not shift the name it sits beside. Where nothing can hover,
  // nothing is hidden.
  const reveal =
    'transition-opacity [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100';

  return (
    <div
      ref={setNodeRef}
      style={style}
      onPointerDown={beginPress}
      onPointerMove={trackPress}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onContextMenu={event => { event.preventDefault(); setMenuOpen(true); }}
      className={`group grid select-none grid-cols-[1.25rem_1.25rem_auto_minmax(0,1fr)_auto_1.25rem] items-center gap-1.5 rounded-lg pr-1 text-sm transition-colors ${
        depth === 0 ? 'min-h-[44px] pl-1 @2xl:h-9 @2xl:min-h-0' : 'min-h-[40px] pl-7 @2xl:h-8 @2xl:min-h-0'
      } ${
        isActive
          ? 'bg-primary/15'
          : isAncestor ? 'bg-white/[0.04]' : 'hover:bg-white/[0.04] active:bg-white/[0.06]'
      }`}
    >
      <button
        type="button"
        className={`flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground ${
          onToggleExpand ? '' : 'invisible'
        }`}
        onClick={onToggleExpand}
        aria-label={expanded ? `Collapse ${title || placeholder}` : `Expand ${title || placeholder}`}
        aria-expanded={onToggleExpand ? Boolean(expanded) : undefined}
        tabIndex={onToggleExpand ? 0 : -1}
      >
        <ChevronRight className={`h-4 w-4 transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </button>

      <button
        type="button"
        className={`flex h-5 w-5 cursor-grab touch-none items-center justify-center text-muted-foreground ${reveal}`}
        aria-label={`Drag ${title || placeholder} to reorder`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <Icon className={`h-4 w-4 ${accent}`} />

      <button
        type="button"
        onClick={onSelect}
        title={title || placeholder}
        className="min-w-0 truncate py-1 text-left"
      >
        {title || placeholder}
      </button>

      <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
        {severity && severity !== 'info' && (
          <AlertTriangle
            className={`h-4 w-4 ${severity === 'blocking' ? 'text-red-500' : 'text-amber-500'}`}
            aria-label={severity === 'blocking' ? 'Must be fixed before saving' : 'Worth checking'}
          />
        )}
        {excluded && <ScopeChip scope={excluded} />}
        {allNative && !excluded && (
          <Tv
            className="h-4 w-4 text-muted-foreground"
            aria-label="Nuvio fetches these itself, so they cost this addon nothing"
          />
        )}
        <span
          title={countHint}
          className={`text-xs tabular-nums ${empty ? 'text-amber-400' : 'text-muted-foreground'}`}
        >
          {count}
        </span>
      </div>

      <div className={reveal}>
        <RowActions
          open={menuOpen}
          onOpenChange={setMenuOpen}
          label={title || placeholder}
          canMoveUp={canMoveUp}
          canMoveDown={canMoveDown}
          onDuplicate={onDuplicate}
          onMoveTo={onMoveTo}
          onDelete={onDelete}
          deleteLabel={depth === 0 ? 'Delete' : 'Delete folder'}
        />
      </div>
    </div>
  );
}
