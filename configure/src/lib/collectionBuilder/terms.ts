// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
export type Target = 'nuvio' | 'jellyfin';

export const NUVIO_CHIP = 'bg-cyan-800/70 text-cyan-200 border-cyan-600/50';
export const FUSION_CHIP = 'bg-violet-800/70 text-violet-200 border-violet-600/50';
export const JELLYFIN_CHIP = 'bg-purple-800/70 text-purple-200 border-purple-600/50';

export interface TargetTerms {
  entryTitle: string;
  collection: string;
  row: string;
  child: string;
  children: string;
  childTitle: string;
  addChild: string;
  shape: string;
  cover: string;
  sources: string;
}

/** One vocabulary for both targets, so an object keeps its name when the target changes. */
const CANONICAL: TargetTerms = {
  entryTitle: 'Title',
  collection: 'Collection',
  row: 'Row',
  child: 'Folder',
  children: 'Folders',
  childTitle: 'Folder title',
  addChild: 'Add folder',
  shape: 'Tile shape',
  cover: 'Cover image URL',
  sources: 'Sources',
};

export const TERMS: Record<Target, TargetTerms> = {
  nuvio: CANONICAL,
  jellyfin: CANONICAL,
};
