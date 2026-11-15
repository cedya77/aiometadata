// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { allFolders, type BuilderEntry, type ExportNote } from '@shared/types';
import { catalogKey, type ManifestCatalog, type SourceIssue } from './manifestSources';

/** Where in the design a problem lives, and so what selecting it should open. */
export interface ProblemTarget {
  entryId: string;
  folderId: string | null;
}

export interface ProblemRow {
  key: string;
  message: string;
  severity: 'blocking' | 'warning' | 'info';
  entryId: string | null;
  folderId: string | null;
}

/**
 * Both issues and notes name what they are about by id, but a note about a
 * folder carries the folder's, so one lookup has to answer for either.
 */
export function buildProblemTargets(entries: BuilderEntry[]): Map<string, ProblemTarget> {
  const map = new Map<string, ProblemTarget>();
  for (const entry of entries) {
    map.set(entry.id, { entryId: entry.id, folderId: null });
    if (entry.kind !== 'collection') continue;
    for (const folder of allFolders(entry.folders)) {
      map.set(folder.id, { entryId: entry.id, folderId: folder.id });
    }
  }
  return map;
}

export function collectProblems(
  issues: SourceIssue[],
  notes: ExportNote[],
  targets: Map<string, ProblemTarget>
): ProblemRow[] {
  const rows: ProblemRow[] = [];
  const push = (key: string, id: string, message: string, severity: ProblemRow['severity']) => {
    const target = targets.get(id);
    rows.push({
      key,
      message,
      severity,
      entryId: target?.entryId ?? null,
      folderId: target?.folderId ?? null,
    });
  };
  issues.forEach((issue, index) =>
    push(`issue-${index}`, issue.folderId ?? issue.entryId, issue.message, 'warning'));
  notes.forEach((note, index) =>
    push(`note-${index}`, note.entryId, note.message, note.severity ?? 'info'));
  return rows;
}

export function countProblems(rows: ProblemRow[], field: 'entryId' | 'folderId'): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const id = row[field];
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Catalogs an apply would add are not in the manifest yet, so a check against it
 * alone would report a design the import can serve as broken. Standing them in
 * keeps that quiet without pretending they are already there.
 */
export function withStagedCatalogs(
  catalogs: ManifestCatalog[],
  pendingKeys: Set<string>
): ManifestCatalog[] {
  if (pendingKeys.size === 0) return catalogs;
  const known = new Set(catalogs.map(catalogKey));
  const staged: ManifestCatalog[] = [];
  for (const key of pendingKeys) {
    if (known.has(key)) continue;
    const split = key.lastIndexOf(':');
    if (split <= 0) continue;
    staged.push({ id: key.slice(0, split), type: key.slice(split + 1), name: key.slice(0, split) });
  }
  return staged.length > 0 ? [...catalogs, ...staged] : catalogs;
}
