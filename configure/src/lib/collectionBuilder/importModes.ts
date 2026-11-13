// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { allFolders, newId, type BuilderEntry, type FolderDraft, type SourceDraft } from '@shared/types';
import { isNativeSource } from '@shared/catalogReconstruction';

export type ImportMode = 'append' | 'merge' | 'replace';

export interface ImportCounts {
  collections: number;
  folders: number;
  sources: number;
  /** Incoming entries whose id the config already holds, so a merge would land on them. */
  existing: number;
}

export interface MergeSummary {
  updated: number;
  added: number;
  foldersAdded: number;
  sourcesAdded: number;
  sourcesSkipped: number;
}

/**
 * Fusion namespaces widget ids by kind, and designs saved before we read that
 * back carry the prefix in the config. So the join ignores it on both sides
 * rather than trusting either to be the bare id.
 */
function joinKey(entry: BuilderEntry): string {
  const id = entry.id;
  for (const prefix of ['collection.', 'catalog.']) {
    if (id.startsWith(prefix)) return id.slice(prefix.length);
  }
  return id;
}

/**
 * Genre is part of the identity: eleven folders can hold the same catalog and
 * differ only by which one they ask for.
 */
function sourceKey(source: SourceDraft): string {
  if (isNativeSource(source) && source.native) return JSON.stringify(source.native);
  const genre = String(source.genre ?? '').trim();
  return `${source.catalogId}:${String(source.type ?? '').toLowerCase()}:${genre}`;
}

export function countImport(entries: BuilderEntry[], current: BuilderEntry[]): ImportCounts {
  const held = new Set(current.map(joinKey));
  let collections = 0;
  let folders = 0;
  let sources = 0;
  let existing = 0;

  for (const entry of entries) {
    if (held.has(joinKey(entry))) existing += 1;
    if (entry.kind === 'classicRow') {
      sources += entry.source ? 1 : 0;
      continue;
    }
    collections += 1;
    folders += allFolders(entry.folders).length;
    for (const folder of allFolders(entry.folders)) sources += folder.sources.length;
  }

  return { collections, folders, sources, existing };
}

function collectFolderIds(entries: BuilderEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'collection') continue;
    for (const folder of allFolders(entry.folders)) ids.add(folder.id);
  }
  return ids;
}

/**
 * Incoming entries land on the entry that already carries their id, so a design
 * imported twice updates rather than doubling. Existing titles and settings are
 * kept: the file is being folded in, not replayed over local edits.
 */
export function mergeEntries(
  existing: BuilderEntry[],
  incoming: BuilderEntry[]
): { entries: BuilderEntry[]; summary: MergeSummary } {
  const summary: MergeSummary = {
    updated: 0, added: 0, foldersAdded: 0, sourcesAdded: 0, sourcesSkipped: 0,
  };

  const byId = new Map(existing.map(entry => [joinKey(entry), entry]));
  const takenEntryIds = new Set(existing.flatMap(entry => [entry.id, joinKey(entry)]));
  const takenFolderIds = collectFolderIds(existing);
  const appended: BuilderEntry[] = [];
  const merged = new Map<string, BuilderEntry>();

  const mergeFolder = (target: FolderDraft, source: FolderDraft): FolderDraft => {
    const seen = new Set(target.sources.map(sourceKey));
    const additions: SourceDraft[] = [];
    for (const item of source.sources) {
      const key = sourceKey(item);
      if (seen.has(key)) {
        summary.sourcesSkipped += 1;
        continue;
      }
      seen.add(key);
      additions.push(item);
    }
    if (additions.length === 0) return target;
    summary.sourcesAdded += additions.length;
    return { ...target, sources: [...target.sources, ...additions] };
  };

  for (const entry of incoming) {
    const key = joinKey(entry);
    const match = merged.get(key) ?? byId.get(key);

    if (!match || match.kind !== entry.kind) {
      const next = { ...entry };
      if (takenEntryIds.has(next.id)) next.id = newId();
      takenEntryIds.add(next.id);
      if (next.kind === 'collection') {
        next.folders = next.folders.map(folder => {
          const id = takenFolderIds.has(folder.id) ? newId() : folder.id;
          takenFolderIds.add(id);
          return { ...folder, id };
        });
      }
      appended.push(next);
      summary.added += 1;
      continue;
    }

    if (match.kind === 'classicRow' || entry.kind === 'classicRow') {
      const next = { ...entry, id: match.id };
      if (JSON.stringify(next) !== JSON.stringify(match)) summary.updated += 1;
      merged.set(key, next);
      continue;
    }

    const folders = [...match.folders];
    const indexById = new Map(folders.map((folder, index) => [folder.id, index]));
    let changed = false;

    for (const folder of entry.folders) {
      const at = indexById.get(folder.id);
      if (at === undefined) {
        const id = takenFolderIds.has(folder.id) ? newId() : folder.id;
        takenFolderIds.add(id);
        folders.push({ ...folder, id });
        indexById.set(id, folders.length - 1);
        summary.foldersAdded += 1;
        summary.sourcesAdded += folder.sources.length;
        changed = true;
        continue;
      }
      const next = mergeFolder(folders[at], folder);
      if (next === folders[at]) continue;
      folders[at] = next;
      changed = true;
    }

    if (changed) summary.updated += 1;
    merged.set(key, { ...match, folders });
  }

  const entries = existing.map(entry => merged.get(joinKey(entry)) ?? entry);
  return { entries: [...entries, ...appended], summary };
}

export function describeMerge(summary: MergeSummary): string {
  const parts: string[] = [];
  if (summary.updated > 0) parts.push(`${summary.updated} updated`);
  if (summary.added > 0) parts.push(`${summary.added} added`);
  if (summary.foldersAdded > 0) {
    parts.push(`${summary.foldersAdded} new folder${summary.foldersAdded === 1 ? '' : 's'}`);
  }
  if (summary.sourcesAdded > 0) {
    parts.push(`${summary.sourcesAdded} new catalog${summary.sourcesAdded === 1 ? '' : 's'}`);
  }
  if (summary.sourcesSkipped > 0) parts.push(`${summary.sourcesSkipped} already present`);
  return parts.length > 0 ? `${parts.join(', ')}.` : 'Nothing to change: you already have all of it.';
}
