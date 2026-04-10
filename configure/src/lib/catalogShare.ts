
import { CatalogConfig } from '@/contexts/config';

const SHARE_VERSION = 1;

// ---- Privacy / Exclusion Rules ----

const USER_SPECIFIC_PATTERNS = [
  'tmdb.watchlist',
  'tmdb.favorites',
  'tmdb.list.',
  'trakt.watchlist',
  'trakt.favorites',
  'trakt.recommendations',
  'trakt.calendar',
  'trakt.list.',
  'trakt.upnext',
  'trakt.unwatched',
  'trakt.history',
  'simkl.watchlist',
  'simkl.watching',
  'simkl.plantowatch',
  'simkl.completed',
  'simkl.dropped',
  'simkl.hold',
  'anilist.watching',
  'anilist.planning',
  'anilist.completed',
  'anilist.dropped',
  'anilist.paused',
  'anilist.repeating',
  'stremthru.',
];

function isUserSpecific(catalogId: string): boolean {
  return USER_SPECIFIC_PATTERNS.some(pattern => catalogId.startsWith(pattern));
}

function isPrivateList(catalog: CatalogConfig): boolean {
  // Trakt lists with privacy set to private
  if (catalog.metadata?.privacy === 'private') return true;
  // Letterboxd watchlists are user-specific
  if (catalog.source === 'letterboxd' && catalog.metadata?.isWatchlist) return true;
  return false;
}

// ---- Metadata Sanitization ----

// Fields safe to include in export (used by the backend)
function sanitizeMetadata(metadata: CatalogConfig['metadata']): CatalogConfig['metadata'] | undefined {
  if (!metadata) return undefined;

  const safe: Record<string, any> = {};

  // Backend-critical fields
  if (metadata.discover) safe.discover = metadata.discover;
  if (metadata.discoverParams) safe.discoverParams = metadata.discoverParams;
  if (metadata.interval) safe.interval = metadata.interval;
  if (metadata.pageSize) safe.pageSize = metadata.pageSize;
  if (metadata.useShowPosterForUpNext !== undefined) safe.useShowPosterForUpNext = metadata.useShowPosterForUpNext;
  if (metadata.airingSoonDays !== undefined) safe.airingSoonDays = metadata.airingSoonDays;
  if (metadata.status) safe.status = metadata.status;
  if (metadata.description) safe.description = metadata.description;

  // Public list metadata (safe to share)
  if (metadata.itemCount !== undefined) safe.itemCount = metadata.itemCount;
  if (metadata.url) safe.url = metadata.url;
  if (metadata.identifier) safe.identifier = metadata.identifier;
  if (metadata.isWatchlist !== undefined) safe.isWatchlist = metadata.isWatchlist;
  if (metadata.isCustomList !== undefined) safe.isCustomList = metadata.isCustomList;
  if ((metadata as any).mediatype) safe.mediatype = (metadata as any).mediatype;
  if ((metadata as any).unified !== undefined) safe.unified = (metadata as any).unified;
  if (metadata.username) safe.username = metadata.username;
  if ((metadata as any).listSlug) safe.listSlug = (metadata as any).listSlug;
  if (metadata.listName) safe.listName = metadata.listName;
  if (metadata.author) safe.author = metadata.author;
  if (metadata.listId) safe.listId = metadata.listId;
  if (metadata.listDescription) safe.listDescription = metadata.listDescription;

  // Intentionally EXCLUDED:
  // - privacy (stripped — we already filter out private lists)

  return Object.keys(safe).length > 0 ? safe : undefined;
}

// ---- Export ----

export interface ExportPayload {
  version: number;
  exportedAt: string;
  catalogs: CatalogConfig[];
}

export function buildExportPayload(
    catalogs: CatalogConfig[],
    includeUserSpecific = false,
    excludeDisabled = false,
    builtOnly = false
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

  const sanitized = filtered.map(c => {
    // Clone the catalog, sanitize metadata
    const exported: any = { ...c };
    exported.metadata = sanitizeMetadata(c.metadata);
    if (!exported.metadata) delete exported.metadata;
    return exported as CatalogConfig;
  });

  return {
    payload: {
      version: SHARE_VERSION,
      exportedAt: new Date().toISOString(),
      catalogs: sanitized,
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
