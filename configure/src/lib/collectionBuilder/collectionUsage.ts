import type { BuilderEntry } from '@shared/types';
import type { CatalogConfig } from '@/contexts/config';
import { deriveManifestCatalog } from './manifestSources';

export interface CollectionUsage {
  /** How many source rows across all collections point at one of the keys. */
  sources: number;
  /** Titles of the collections and rows holding them. */
  entries: string[];
}

export function catalogUsageKey(catalogId: string, type: string): string {
  return `${catalogId}:${String(type).toLowerCase()}`;
}

/**
 * A source addresses a catalog as the manifest spells it, which a displayType
 * renames, so a catalog answers to its config spelling and its manifest one.
 */
export function catalogUsageKeys(catalog: CatalogConfig): string[] {
  const manifest = deriveManifestCatalog(catalog);
  return [...new Set([catalogUsageKey(catalog.id, catalog.type), catalogUsageKey(manifest.id, manifest.type)])];
}

export function isCollected(collected: Set<string>, catalog: CatalogConfig): boolean {
  return catalogUsageKeys(catalog).some(key => collected.has(key));
}

/**
 * Deleting a catalog leaves any collection source pointing at it behind, on
 * purpose: a swap is far more common than a permanent removal, and pruning
 * would take the tile and its position with it. Callers use this to say so.
 */
export function findCollectionUsage(
  collections: BuilderEntry[] | undefined,
  keys: Set<string>
): CollectionUsage {
  let sources = 0;
  const entries: string[] = [];

  for (const entry of collections || []) {
    const drafts = entry.kind === 'classicRow'
      ? (entry.source ? [entry.source] : [])
      : entry.folders.flatMap(folder => folder.sources);

    let hits = 0;
    for (const draft of drafts) {
      if (keys.has(catalogUsageKey(draft.catalogId, draft.type))) hits += 1;
    }

    if (hits > 0) {
      sources += hits;
      const title = String(entry.title || '').trim();
      if (title && !entries.includes(title)) entries.push(title);
    }
  }

  return { sources, entries };
}

/** Every catalog a collection points at, as usage keys. */
export function collectedCatalogKeys(collections: BuilderEntry[] | undefined): Set<string> {
  const keys = new Set<string>();
  for (const entry of collections || []) {
    const drafts = entry.kind === 'classicRow'
      ? (entry.source ? [entry.source] : [])
      : entry.folders.flatMap(folder => folder.sources);
    for (const draft of drafts) keys.add(catalogUsageKey(draft.catalogId, draft.type));
  }
  return keys;
}

export function describeCollectionUsage(usage: CollectionUsage): string {
  if (usage.sources === 0) return '';
  const noun = usage.sources === 1 ? 'source' : 'sources';
  const pronoun = usage.sources === 1 ? 'it' : 'them';
  const where = usage.entries.length > 0 ? ` (${usage.entries.join(', ')})` : '';
  return `${usage.sources} collection ${noun}${where} will be left pointing at a catalog you no longer have. `
    + `Nothing is removed from the collection, so open the collection builder and either swap ${pronoun} `
    + 'for another catalog or delete the tile.';
}
