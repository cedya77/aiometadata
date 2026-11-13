// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { buildShareableCatalog, type ShareableCatalog } from './catalogSharing';
import { lookupKey, type CatalogBlueprint } from './catalogReconstruction';
import type { BlueprintLookup } from './nuvioExport';

/**
 * How createCatalog addresses a catalog in the manifest: the type is always
 * `displayType || type`, and a built-in catalog carrying a displayType gets its
 * original type appended to the id (addon/lib/getManifest.ts). Which of the two
 * id spellings applies needs the built-in list, so both are registered instead.
 */
function manifestKeys(catalog: ShareableCatalog): string[] {
  const type = String(catalog.displayType || '').trim() || catalog.type;
  const keys = [lookupKey(catalog.id, type)];
  if (catalog.displayType) keys.push(lookupKey(`${catalog.id}_${catalog.type}`, type));
  return keys;
}

/**
 * Turns a config's catalogs into the catalogs a collection file can carry, so an
 * importer who does not have them can rebuild them rather than being told to add
 * them by hand. Personal catalogs are left out. Catalogs absorbed into a merge are
 * kept, since rebuilding the merge means rebuilding them too, and the importer only
 * pulls in the ones a merge asks for.
 */
export function buildBlueprintLookup(catalogs: ShareableCatalog[] | undefined): BlueprintLookup {
  const lookup: BlueprintLookup = {};

  for (const catalog of catalogs || []) {
    if (!catalog?.id || !catalog?.type) continue;

    const shareable = buildShareableCatalog(catalog);
    if (!shareable) continue;

    const blueprint = {
      id: shareable.id,
      type: shareable.type,
      name: shareable.name,
      source: shareable.source,
      enabled: true,
      showInHome: Boolean(shareable.showInHome),
      ...(shareable.cacheTTL !== undefined && { cacheTTL: shareable.cacheTTL }),
      ...(shareable.sort !== undefined && { sort: shareable.sort }),
      ...(shareable.sortDirection !== undefined && { sortDirection: shareable.sortDirection }),
      ...(shareable.metadata && { metadata: shareable.metadata }),
    } as CatalogBlueprint;

    for (const key of manifestKeys(catalog)) lookup[key] = blueprint;
  }

  return lookup;
}
