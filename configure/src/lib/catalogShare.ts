// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE

import { CatalogConfig, TagDef } from '@/contexts/config';
import { TAG_COLOR_KEYS, nextTagColor } from '@/lib/tagColors';
import {
  buildShareableCatalog,
  isPrivateList,
  isUserSpecific,
  sanitizeMetadata,
} from '@shared/catalogSharing';

const SHARE_VERSION = 1;

// The rules live in the shared collection-builder module so the collection
// exports, which embed catalogs, cannot drift from what this exports.
export { buildShareableCatalog, isUserSpecific };

// ---- Export ----

export interface ExportPayload {
  version: number;
  exportedAt: string;
  catalogs: CatalogConfig[];
  /** Definitions for the tag names the catalogs carry. Absent in older exports. */
  tags?: TagDef[];
}

/** Tag names used by these catalogs, first spelling wins. */
function usedTagNames(catalogs: CatalogConfig[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const catalog of catalogs) {
    for (const tag of catalog.tags ?? []) {
      const key = tag.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      names.push(tag);
    }
  }
  return names;
}

export function buildExportPayload(
    catalogs: CatalogConfig[],
    includeUserSpecific = false,
    excludeDisabled = false,
    builtOnly = false,
    tags: TagDef[] = []
  ): { payload: ExportPayload; exportedCount: number; skippedCount: number; skippedReasons: string[] } {
  const skippedReasons: string[] = [];

  const filtered = catalogs.filter(c => {
    if (builtOnly && !c.id.includes('.discover.')) {
      return false;
    }
    if (excludeDisabled && !c.enabled) {
      skippedReasons.push(`${c.name} (disabled)`);
      return false;
    }
    if (!includeUserSpecific && isUserSpecific(c.id)) {
      skippedReasons.push(`${c.name} (user-specific)`);
      return false;
    }
    if (isPrivateList(c)) {
      skippedReasons.push(`${c.name} (private list)`);
      return false;
    }
    return true;
  });

  const keepSource = (entry: any): boolean => {
    const id = String(entry.catalogId);
    const source = catalogs.find(c => c.id === id && (!entry.catalogType || c.type === entry.catalogType));
    if (source && isPrivateList(source)) return false;
    return includeUserSpecific || !isUserSpecific(id);
  };

  const sanitized = filtered.map(c => {
    // Clone the catalog, sanitize metadata
    const exported: any = { ...c };
    exported.metadata = sanitizeMetadata(c.metadata, keepSource);
    if (!exported.metadata) delete exported.metadata;
    return exported as CatalogConfig;
  });

  const used = new Set(usedTagNames(sanitized).map(name => name.toLowerCase()));
  const exportedTags = tags.filter(tag => used.has(tag.name.toLowerCase()));

  return {
    payload: {
      version: SHARE_VERSION,
      exportedAt: new Date().toISOString(),
      catalogs: sanitized,
      ...(exportedTags.length > 0 ? { tags: exportedTags } : {}),
    },
    exportedCount: sanitized.length,
    skippedCount: catalogs.length - sanitized.length,
    skippedReasons,
  };
}

export function exportToJson(payload: ExportPayload): string {
  return JSON.stringify(payload, null, 2);
}

// ---- Import ----

export interface ImportResult {
  payload: ExportPayload;
  catalogCount: number;
  userSpecificCount: number;
  discoverCount: number;
  defaultCount: number;
  sourceBreakdown: Record<string, number>;
  tagNames: string[];
}

/**
 * Adds a definition for every tag name the imported catalogs carry, so a tag
 * arrives with a colour and reaches the tag manager. Exports made before the
 * registry travelled with them carry names only, so a colour is assigned here.
 */
export function reconcileTagRegistry(
  existing: TagDef[],
  imported: CatalogConfig[],
  exported: TagDef[] = []
): { tags: TagDef[]; catalogs: CatalogConfig[] } {
  const registry = [...existing];
  const known = new Map(registry.map(tag => [tag.name.toLowerCase(), tag.name]));
  const offered = new Map(exported.map(tag => [tag.name.toLowerCase(), tag.color]));

  for (const name of usedTagNames(imported)) {
    const key = name.toLowerCase();
    if (known.has(key)) continue;
    const offeredColor = offered.get(key);
    registry.push({
      name,
      color: offeredColor && TAG_COLOR_KEYS.includes(offeredColor)
        ? offeredColor
        : nextTagColor(registry.map(tag => tag.color)),
    });
    known.set(key, name);
  }

  const catalogs = imported.map(catalog => {
    if (!catalog.tags?.length) return catalog;
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const tag of catalog.tags) {
      const canonical = known.get(tag.toLowerCase()) ?? tag;
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      tags.push(canonical);
    }
    return { ...catalog, tags };
  });

  return { tags: registry, catalogs };
}

export function parseImportJson(jsonString: string): ImportResult {
  let parsed: any;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    throw new Error('Invalid JSON. Check the file or pasted content.');
  }

  if (!parsed.version) {
    throw new Error('Not a valid AIOMetadata catalog export (missing version).');
  }

  if (parsed.version !== SHARE_VERSION) {
    throw new Error(`Unsupported export version: ${parsed.version}. You may need to update AIOMetadata.`);
  }

  if (!Array.isArray(parsed.catalogs) || parsed.catalogs.length === 0) {
    throw new Error('Export contains no catalogs.');
  }

  for (const cat of parsed.catalogs) {
    if (!cat.id || !cat.name || !cat.type || !cat.source) {
      throw new Error(`Invalid catalog entry: missing required fields (id, name, type, source).`);
    }
  }

  const catalogs = parsed.catalogs as CatalogConfig[];
  const userSpecificCount = catalogs.filter(c => isUserSpecific(c.id)).length;
  const discoverCount = catalogs.filter(c => c.id.includes('.discover.')).length;
  const defaultCount = catalogs.length - discoverCount - userSpecificCount;

  const sourceBreakdown: Record<string, number> = {};
  for (const c of catalogs) {
    sourceBreakdown[c.source] = (sourceBreakdown[c.source] || 0) + 1;
  }

  return {
    payload: parsed as ExportPayload,
    catalogCount: catalogs.length,
    userSpecificCount,
    discoverCount,
    defaultCount,
    sourceBreakdown,
    tagNames: usedTagNames(catalogs),
  };
}

export async function fetchAndParseUrl(url: string): Promise<ImportResult> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  return parseImportJson(text);
}

// ---- Merge ----

export function mergeCatalogs(
  existing: CatalogConfig[],
  imported: CatalogConfig[],
  mode: 'merge' | 'replace'
): CatalogConfig[] {
  if (mode === 'replace') {
    // Use imported order completely, append any existing catalogs not in import
    const importedKeys = new Set(imported.map(c => `${c.id}-${c.type}`));
    const keptExisting = existing.filter(c => !importedKeys.has(`${c.id}-${c.type}`));

    const merged = imported.map(imp => {
      const match = existing.find(e => e.id === imp.id && e.type === imp.type);
      // Preserve any extra runtime fields from existing, but imported values win
      return { ...(match || {}), ...imp } as CatalogConfig;
    });

    return [...merged, ...keptExisting];
  }

  // Merge: keep existing order, update settings for matches, append new catalogs at end
  const result = [...existing];
  const existingKeys = new Set(existing.map(c => `${c.id}-${c.type}`));

  for (const imp of imported) {
    const key = `${imp.id}-${imp.type}`;
    if (existingKeys.has(key)) {
      const idx = result.findIndex(c => `${c.id}-${c.type}` === key);
      if (idx !== -1) {
        result[idx] = { ...result[idx], ...imp };
      }
    } else {
      result.push(imp as CatalogConfig);
    }
  }

  return result;
}