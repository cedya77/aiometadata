// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { nextCopyTitle } from '@/lib/collectionBuilder/entryOps';
import { allFolders, newId, type BuilderEntry, type TileShape } from '@shared/types';

export const SHAPE_LABELS: Record<TileShape, string> = {
  POSTER: 'Poster',
  LANDSCAPE: 'Wide',
  SQUARE: 'Square',
};

export const SHAPE_ORDER: TileShape[] = ['POSTER', 'LANDSCAPE', 'SQUARE'];

/** Rough proportions so the choice reads at a glance. */
export const SHAPE_PREVIEW: Record<TileShape, string> = {
  POSTER: 'h-4 w-[11px]',
  LANDSCAPE: 'h-3 w-5',
  SQUARE: 'h-4 w-4',
};

export type PreviewAspect = 'poster' | 'wide' | 'square' | 'logo';

export const PREVIEW_BOX: Record<PreviewAspect, string> = {
  poster: 'h-24 w-16',
  wide: 'h-16 w-[7.1rem]',
  square: 'h-20 w-20',
  logo: 'h-12 w-[7.1rem]',
};

export const ASPECT_BY_TILE: Record<TileShape, PreviewAspect> = {
  POSTER: 'poster',
  LANDSCAPE: 'wide',
  SQUARE: 'square',
};

export interface TagOption {
  name: string;
  color: string;
  count: number;
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export function entrySourceCount(entry: BuilderEntry): number {
  if (entry.kind === 'classicRow') return entry.source ? 1 : 0;
  return allFolders(entry.folders).reduce((total, folder) => total + folder.sources.length, 0);
}

export function duplicateEntryDraft(entry: BuilderEntry): BuilderEntry {
  const copy = clone(entry);
  copy.id = newId();
  copy.title = nextCopyTitle(entry.title);
  if (copy.kind === 'collection') {
    copy.folders = copy.folders.map(folder => ({ ...folder, id: newId() }));
  }
  return copy;
}
