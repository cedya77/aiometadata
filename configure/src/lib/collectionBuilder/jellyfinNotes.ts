// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { allFolders, folderSources, type BuilderEntry, type ExportNote } from '@shared/types';
import { isNativeSource } from '@shared/catalogReconstruction';

/** What the Jellyfin server leaves out of the design, surfaced the way an export's notes are. */
export function jellyfinNotes(entries: BuilderEntry[]): ExportNote[] {
  const notes: ExportNote[] = [];
  for (const entry of entries) {
    if (entry.kind === 'classicRow') {
      if (!entry.source || isNativeSource(entry.source)) {
        notes.push({
          entryId: entry.id,
          entryTitle: entry.title,
          message: `"${entry.title.trim() || 'Untitled row'}" has no catalog Jellyfin can serve, so it is left out.`,
          severity: 'warning',
        });
      }
      continue;
    }
    for (const folder of allFolders(entry.folders)) {
      if (folderSources(folder).some(source => !isNativeSource(source))) continue;
      notes.push({
        entryId: folder.id,
        entryTitle: folder.title,
        message: `Folder "${folder.title.trim() || 'Untitled folder'}" has no sources. It shows up empty until you add one.`,
        severity: 'info',
      });
    }
  }
  return notes;
}
