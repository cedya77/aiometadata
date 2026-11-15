// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { allFolders, folderSources, type BuilderEntry, type FolderDraft } from '@shared/types';

const COPY_SUFFIX = /^(.*?) copy(?: (\d+))?$/;

export function nextCopyTitle(title: string): string {
  const base = title.trim() || 'Untitled';
  const match = COPY_SUFFIX.exec(base);
  if (!match) return `${base} copy`;
  const n = match[2] ? parseInt(match[2], 10) : 1;
  return `${match[1]} copy ${n + 1}`;
}

function haystack(entry: BuilderEntry): string {
  const parts = [entry.title];
  if (entry.kind === 'classicRow') {
    if (entry.source) parts.push(entry.source.name || entry.source.catalogId);
  } else {
    for (const folder of allFolders(entry.folders)) {
      parts.push(folder.title);
      for (const source of folder.sources) parts.push(source.name || source.catalogId);
    }
  }
  return parts.join(' ').toLowerCase();
}

export function filterEntries(entries: BuilderEntry[], query: string): BuilderEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter(entry => haystack(entry).includes(needle));
}

export interface FilteredEntry {
  entry: BuilderEntry;
  /** Folder ids to show. null means the entry itself matched: show them all. */
  matchedFolderIds: Set<string> | null;
}

function folderHaystack(folder: FolderDraft): string {
  const parts = allFolders([folder]).flatMap(f => [f.title, ...f.sources.map(source => source.name || source.catalogId)]);
  return parts.join(' ').toLowerCase();
}

export function filterEntryTree(entries: BuilderEntry[], query: string): FilteredEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries.map(entry => ({ entry, matchedFolderIds: null }));

  const result: FilteredEntry[] = [];
  for (const entry of entries) {
    if (entry.title.toLowerCase().includes(needle)) {
      result.push({ entry, matchedFolderIds: null });
      continue;
    }
    if (entry.kind === 'classicRow') {
      if (haystack(entry).includes(needle)) result.push({ entry, matchedFolderIds: null });
      continue;
    }
    const matched = new Set(
      entry.folders.filter(folder => folderHaystack(folder).includes(needle)).map(folder => folder.id)
    );
    if (matched.size > 0) result.push({ entry, matchedFolderIds: matched });
  }
  return result;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function describeEntryCount(entry: BuilderEntry): string {
  if (entry.kind === 'classicRow') return entry.source ? '1 catalog' : 'No catalog';
  const catalogs = entry.folders.reduce((total, folder) => total + folderSources(folder).length, 0);
  return `${plural(entry.folders.length, 'folder')} · ${plural(catalogs, 'catalog')}`;
}

/** The same tally, short enough to leave the rail's width to the name. */
export function tallyEntryCount(entry: BuilderEntry): string {
  if (entry.kind === 'classicRow') return entry.source ? '1' : '0';
  const catalogs = entry.folders.reduce((total, folder) => total + folderSources(folder).length, 0);
  return `${entry.folders.length} · ${catalogs}`;
}
