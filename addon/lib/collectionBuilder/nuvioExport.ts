// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import type {
  AddonIdentity,
  BuilderEntry,
  ExportNote,
  ExportResult,
  FolderDraft,
  NuvioAddonSource,
  NuvioCatalogSource,
  NuvioCollection,
  NuvioFolder,
  SourceDraft,
} from './types';
import { folderSources } from './types';
import {
  createBlueprintWriter,
  isNativeSource,
  lookupKey,
  nativeOrigin,
  type BlueprintLookup,
} from './catalogReconstruction';

export type { BlueprintLookup };

type AttachBlueprint = ReturnType<typeof createBlueprintWriter>;

function trimmed(value: unknown): string {
  return String(value ?? '').trim();
}

function orNull(value: unknown): string | null {
  return trimmed(value) || null;
}

function toAddonSource(
  source: SourceDraft,
  identity: AddonIdentity,
  attach: AttachBlueprint,
  usePlaceholder: boolean
): NuvioAddonSource | null {
  const catalogId = trimmed(source.catalogId);
  const type = trimmed(source.type).toLowerCase();
  const addonId = trimmed(identity.addonId);
  if (!addonId || !type || !catalogId) return null;

  const name = trimmed(source.name) || catalogId;
  const mapped: NuvioAddonSource = {
    provider: 'addon',
    addonId,
    // The base URL carries the config's own id, and it is written onto every
    // source, so a file meant for someone else must not carry it.
    addonBaseUrl: usePlaceholder ? null : orNull(identity.addonBaseUrl),
    addonName: orNull(identity.addonName),
    type,
    catalogId,
    catalogName: name,
    title: name,
    genre: orNull(source.genre),
  };

  return attach(mapped, lookupKey(catalogId, source.type));
}

function toCatalogSource(source: NuvioAddonSource): NuvioCatalogSource {
  return {
    addonId: source.addonId,
    addonBaseUrl: source.addonBaseUrl,
    addonName: source.addonName,
    type: source.type,
    catalogId: source.catalogId,
    catalogName: source.catalogName,
    title: source.title || source.catalogName,
    genre: source.genre,
  };
}

function toFolder(
  folder: FolderDraft,
  identity: AddonIdentity,
  collectionTitle: string,
  notes: ExportNote[],
  attach: AttachBlueprint,
  usePlaceholder: boolean
): NuvioFolder | null {
  const id = trimmed(folder.id);
  const title = trimmed(folder.title);
  if (!id || !title) {
    notes.push({
      entryId: folder.id,
      entryTitle: collectionTitle,
      message: `A folder without a title was skipped. Nuvio drops folders that have no title.`,
      severity: 'warning',
    });
    return null;
  }

  const sources: NuvioAddonSource[] = [];
  let nativeSkipped = 0;
  for (const source of folderSources(folder)) {
    if (isNativeSource(source)) {
      if (nativeOrigin(source) === 'nuvio' && source.native) {
        sources.push(source.native as NuvioAddonSource);
        continue;
      }
      nativeSkipped += 1;
      continue;
    }
    const mapped = toAddonSource(source, identity, attach, usePlaceholder);
    if (mapped) {
      sources.push(mapped);
      continue;
    }
    notes.push({
      entryId: folder.id,
      entryTitle: title,
      message: `Source "${trimmed(source.name) || trimmed(source.catalogId) || 'unnamed'}" is missing a catalog id or type and was skipped.`,
      severity: 'warning',
    });
  }

  if (nativeSkipped > 0) {
    notes.push({
      entryId: folder.id,
      entryTitle: title,
      message: `"${title}": ${nativeSkipped} source${nativeSkipped === 1 ? ' is' : 's are'} resolved by Fusion itself. Nuvio has no equivalent, so ${nativeSkipped === 1 ? 'it is' : 'they are'} left out.`,
      severity: 'info',
    });
  }

  if (sources.length === 0) {
    notes.push({
      entryId: folder.id,
      entryTitle: title,
      message: `Folder "${title}" has no sources. It is exported anyway, so its artwork survives, and it stays empty until you add one.`,
      severity: 'info',
    });
  }

  return {
    id,
    title,
    coverImageUrl: orNull(folder.coverImageUrl),
    focusGifUrl: orNull(folder.focusGifUrl),
    focusGifEnabled: folder.focusGifEnabled !== false,
    coverEmoji: orNull(folder.coverEmoji),
    tileShape: folder.shape,
    hideTitle: Boolean(folder.hideTitle),
    sources,
    catalogSources: sources.filter(entry => entry.provider === 'addon').map(toCatalogSource),
    heroBackdropUrl: orNull(folder.heroBackdropUrl),
    heroVideoUrl: orNull(folder.heroVideoUrl),
    titleLogoUrl: orNull(folder.titleLogoUrl),
  };
}

/**
 * Nuvio's CollectionsStore.importFromJson expects a bare array, and its normalizer
 * silently discards anything it cannot validate. Everything dropped here is reported
 * back as a note instead.
 */
export function toNuvioCollections(
  entries: BuilderEntry[],
  identity: AddonIdentity,
  blueprints: BlueprintLookup = {},
  options: { usePlaceholder?: boolean } = {}
): ExportResult<NuvioCollection[]> {
  const notes: ExportNote[] = [];
  const output: NuvioCollection[] = [];
  const attach = createBlueprintWriter(blueprints);
  const usePlaceholder = options.usePlaceholder === true;

  for (const entry of entries) {
    if (entry.kind === 'classicRow') {
      notes.push({
        entryId: entry.id,
        entryTitle: entry.title,
        message: `"${trimmed(entry.title) || 'Untitled row'}" is a row. Nuvio has no equivalent, so it only shows on Jellyfin.`,
        severity: 'info',
      });
      continue;
    }

    const id = trimmed(entry.id);
    const title = trimmed(entry.title);
    if (!id || !title) {
      notes.push({
        entryId: entry.id,
        entryTitle: entry.title,
        message: 'A collection without a title was skipped. Nuvio drops collections that have no title.',
        severity: 'warning',
      });
      continue;
    }

    const folders = entry.folders
      .map(folder => toFolder(folder, identity, title, notes, attach, usePlaceholder))
      .filter((folder): folder is NuvioFolder => folder !== null);

    output.push({
      id,
      title,
      backdropImageUrl: orNull(entry.backdropImageUrl),
      pinToTop: Boolean(entry.pinToTop),
      focusGlowEnabled: entry.focusGlowEnabled !== false,
      viewMode: entry.viewMode || 'TABBED_GRID',
      showAllTab: entry.showAllTab !== false,
      folders,
    });
  }

  return { output, notes };
}
