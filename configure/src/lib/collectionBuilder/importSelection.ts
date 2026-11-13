// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { entrySources, type BuilderEntry } from '@shared/types';
import { blueprintsUsedBy, type CatalogBlueprint } from '@shared/catalogReconstruction';

/** How an entry is told apart when a file is picked from, before any id is reissued. */
export function entryKey(entry: BuilderEntry, at: number): string {
  return entry.id || `#${at}`;
}

/**
 * A parsed file without the entries left out, and without the catalogs only they
 * needed, so an unticked row adds nothing to the configuration.
 */
export function withoutEntries<T extends { entries: BuilderEntry[]; blueprints: CatalogBlueprint[] }>(
  parsed: T,
  skip: Set<string>
): T {
  if (skip.size === 0) return parsed;
  const entries = parsed.entries.filter((entry, at) => !skip.has(entryKey(entry, at)));
  return { ...parsed, entries, blueprints: blueprintsUsedBy(parsed.blueprints, entries.flatMap(entrySources)) };
}
