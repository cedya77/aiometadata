// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { createBlueprintWriter, lookupKey, type BlueprintLookup } from './catalogReconstruction';
import { currentFields, mapFoldersDeep, type BuilderEntry, type SourceDraft } from './types';

export const LAYOUT_EXPORT_TYPE = 'aiometadataCollections';

export interface LayoutFile {
  exportType: typeof LAYOUT_EXPORT_TYPE;
  exportVersion: 1;
  entries: BuilderEntry[];
}

/**
 * The builder's own entries for another AIOMetadata to import whole, nested folders and
 * rows included. Each catalog travels on the first source using it; user tags name this
 * server's users, so they stay behind.
 */
export function toLayoutFile(entries: BuilderEntry[], blueprints: BlueprintLookup = {}): LayoutFile {
  const attach = createBlueprintWriter(blueprints);
  const carry = (source: SourceDraft): SourceDraft => (source.native ? source : attach({ ...source }, lookupKey(source.catalogId, source.type)));
  return {
    exportType: LAYOUT_EXPORT_TYPE,
    exportVersion: 1,
    entries: entries.map((entry): BuilderEntry => {
      const { tags: _tags, ...shared } = currentFields(entry);
      return shared.kind === 'classicRow'
        ? { ...shared, source: shared.source ? carry(shared.source) : null }
        : { ...shared, folders: mapFoldersDeep(shared.folders, (folder) => ({ ...folder, sources: folder.sources.map(carry) })) };
    }),
  };
}
