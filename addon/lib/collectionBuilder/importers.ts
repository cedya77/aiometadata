import {
  createClassicRowDraft,
  createCollectionDraft,
  createFolderDraft,
  newId,
  type BuilderEntry,
  type ClassicRowDraft,
  type CollectionDraft,
  type CollectionViewMode,
  type FolderDraft,
  type FusionAspectRatio,
  type FusionCardStyle,
  SUFFIX_TYPES,
  type SourceDraft,
  type TileShape,
} from './types';
import {
  dedupeBlueprints,
  fromEmbedded,
  lookupKey,
  fromFusionNativeSource,
  fromNativeSource,
  fusionNativePassthrough,
  nativePassthrough,
  type CatalogBlueprint,
} from './catalogReconstruction';

export interface ImportOptions {
  /**
   * Turn sources the client resolves itself into catalogs served by this addon.
   * Off by default: a native source costs the instance nothing, while a converted
   * one becomes a config entry and a manifest entry for every user who imports
   * it. Worth it for our artwork, ratings and filters, but only on request.
   */
  convertNative?: boolean;
}

interface ImportContext {
  convertNative: boolean;
  nativeCount: number;
  convertibleCount: number;
}

export type ImportFormat = 'nuvio' | 'fusion' | 'builder' | 'unknown';

export interface ImportResult {
  format: ImportFormat;
  entries: BuilderEntry[];
  notes: string[];
  /** Catalogs the file carries enough information to recreate. */
  blueprints: CatalogBlueprint[];
  /** Sources the client resolves itself, which conversion would take on. */
  nativeCount: number;
  /** How many of those conversion could actually turn into catalogs. */
  convertibleCount: number;
}

function trimmed(value: unknown): string {
  return String(value ?? '').trim();
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Nuvio writes POSTER/LANDSCAPE/SQUARE, Fusion writes Poster/Wide/Square. */
function toShape(value: unknown): TileShape {
  const normalized = trimmed(value).toUpperCase();
  if (normalized === 'POSTER') return 'POSTER';
  if (normalized === 'LANDSCAPE' || normalized === 'WIDE') return 'LANDSCAPE';
  if (normalized === 'SQUARE') return 'SQUARE';
  return 'POSTER';
}

function toViewMode(value: unknown): CollectionViewMode {
  const normalized = trimmed(value).toUpperCase();
  if (normalized === 'ROWS') return 'ROWS';
  if (normalized === 'FOLLOW_LAYOUT') return 'FOLLOW_LAYOUT';
  return 'TABBED_GRID';
}

function toAspect(value: unknown): FusionAspectRatio {
  const normalized = trimmed(value).toLowerCase();
  if (normalized === 'wide') return 'wide';
  if (normalized === 'square') return 'square';
  return 'poster';
}

function toCardStyle(value: unknown): FusionCardStyle {
  const normalized = trimmed(value).toLowerCase();
  if (normalized === 'small') return 'small';
  if (normalized === 'large') return 'large';
  return 'medium';
}

/** The inverse of prefixedId in fusionExport, so a round trip keeps the same id. */
function unprefixedId(value: unknown, prefix: string): string {
  const id = trimmed(value);
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function looksLikeFusionTile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const hasLabel = 'name' in value || 'title' in value;
  const hasArt = 'layout' in value || 'imageAspect' in value
    || 'backgroundImageURL' in value || 'imageURL' in value;
  return hasLabel && hasArt && !('folders' in value) && !('type' in value);
}

export function detectFormat(input: unknown): ImportFormat {
  if (Array.isArray(input)) {
    if (input.length === 0) return 'nuvio';
    const first = input[0];
    if (isRecord(first) && (first.kind === 'collection' || first.kind === 'classicRow')) {
      return 'builder';
    }
    if (isRecord(first) && 'folders' in first) return 'nuvio';
    if (looksLikeFusionTile(first)) return 'fusion';
    return 'unknown';
  }
  if (isRecord(input)) {
    if (input.exportType === 'fusionWidgets' || Array.isArray(input.widgets)) return 'fusion';
    if (Array.isArray(input.collections)) return 'nuvio';
    if (Array.isArray(input.entries)) return 'builder';
  }
  return 'unknown';
}

// ---- Nuvio ----

function nuvioSource(
  raw: unknown,
  folderTitle: string,
  notes: string[],
  blueprints: CatalogBlueprint[],
  context: ImportContext
): SourceDraft | null {
  if (!isRecord(raw)) return null;

  const provider = trimmed(raw.provider || 'addon').toLowerCase();
  if (provider !== 'addon') {
    context.nativeCount += 1;
    const rebuilt = fromNativeSource(raw);
    if (rebuilt.ok === true) context.convertibleCount += 1;

    if (context.convertNative && rebuilt.ok === true) {
      blueprints.push(rebuilt.blueprint);
      return rebuilt.source;
    }

    const passthrough = nativePassthrough(raw);
    if (passthrough) return passthrough;

    // No folder title here on purpose: identical reasons collapse into one note,
    // and a file can hold hundreds of the same unsupported source.
    notes.push(`Skipped ${rebuilt.ok === true ? 'a source this editor cannot hold' : rebuilt.reason}.`);
    return null;
  }

  const catalogId = trimmed(raw.catalogId || raw.catalog_id);
  const type = trimmed(raw.type || raw.apiType);
  if (!catalogId || !type) {
    notes.push(`"${folderTitle}": skipped a source with no catalog id or type.`);
    return null;
  }

  blueprints.push(...fromEmbedded(raw, folderTitle));

  return {
    catalogId,
    type,
    name: trimmed(raw.catalogName || raw.title || raw.name) || trimmed(folderTitle) || catalogId,
    genre: trimmed(raw.genre) || null,
  };
}

function nuvioFolder(
  raw: unknown,
  notes: string[],
  blueprints: CatalogBlueprint[],
  context: ImportContext
): FolderDraft | null {
  if (!isRecord(raw)) return null;
  const title = trimmed(raw.title);
  if (!title) {
    notes.push('Skipped a folder with no title.');
    return null;
  }

  const rawSources = Array.isArray(raw.sources) && raw.sources.length > 0
    ? raw.sources
    : Array.isArray(raw.catalogSources) ? raw.catalogSources : [];

  const sources = rawSources
    .map((source: unknown) => nuvioSource(
      isRecord(source) && !source.provider ? { ...source, provider: 'addon' } : source,
      title,
      notes,
      blueprints,
      context
    ))
    .filter((source): source is SourceDraft => source !== null);

  // Two native sources can rebuild to the same catalog, which would leave the
  // folder holding one row twice.
  const seen = new Set<string>();
  const unique = sources.filter((source: SourceDraft) => {
    const key = `${source.catalogId}:${source.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    ...createFolderDraft(title),
    id: trimmed(raw.id) || newId(),
    title,
    shape: toShape(raw.tileShape),
    hideTitle: Boolean(raw.hideTitle),
    coverImageUrl: trimmed(raw.coverImageUrl),
    coverEmoji: trimmed(raw.coverEmoji),
    focusGifUrl: trimmed(raw.focusGifUrl),
    focusGifEnabled: raw.focusGifEnabled !== false,
    heroBackdropUrl: trimmed(raw.heroBackdropUrl),
    heroVideoUrl: trimmed(raw.heroVideoUrl),
    titleLogoUrl: trimmed(raw.titleLogoUrl),
    sources: unique,
  };
}

export function fromNuvioCollections(
  input: unknown,
  notes: string[],
  blueprints: CatalogBlueprint[] = [],
  context: ImportContext = { convertNative: false, nativeCount: 0, convertibleCount: 0 }
): CollectionDraft[] {
  const list = Array.isArray(input)
    ? input
    : isRecord(input) && Array.isArray(input.collections) ? input.collections : [];

  const entries: CollectionDraft[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const title = trimmed(raw.title);
    if (!title) {
      notes.push('Skipped a collection with no title.');
      continue;
    }
    const folders = (Array.isArray(raw.folders) ? raw.folders : [])
      .map((folder: unknown) => nuvioFolder(folder, notes, blueprints, context))
      .filter((folder): folder is FolderDraft => folder !== null);

    entries.push({
      ...createCollectionDraft(title),
      id: trimmed(raw.id) || newId(),
      title,
      backdropImageUrl: trimmed(raw.backdropImageUrl),
      pinToTop: Boolean(raw.pinToTop),
      focusGlowEnabled: raw.focusGlowEnabled !== false,
      viewMode: toViewMode(raw.viewMode),
      showAllTab: raw.showAllTab !== false,
      folders,
    });
  }
  return entries;
}

// ---- Fusion ----

/** Fusion stores `<type>::<id>`; everything after the first separator is the id. */
function splitCatalogId(composite: string, fallbackType: string): { catalogId: string; type: string; genre: string | null } | null {
  const value = trimmed(composite);
  if (!value) return null;
  const index = value.indexOf('::');
  const type = index < 0 ? fallbackType : (value.slice(0, index).trim() || fallbackType);
  const rest = index < 0 ? value : value.slice(index + 2).trim();
  if (!rest || !type) return null;

  const { id, genre } = splitCatalogGenre(rest);
  if (!id) return null;
  return { catalogId: id, type, genre };
}

/** A genre rides in the id as `<id>/genre=<value>`, since Fusion has no field for it. */
function splitCatalogGenre(value: string): { id: string; genre: string | null } {
  const marker = value.indexOf('/genre=');
  if (marker < 0) return { id: value, genre: null };

  const id = value.slice(0, marker).trim();
  const raw = value.slice(marker + '/genre='.length).trim();
  if (!raw) return { id, genre: null };

  let genre = raw;
  try {
    genre = decodeURIComponent(raw);
  } catch {
    genre = raw;
  }
  return { id, genre };
}

function fusionSource(
  raw: unknown,
  label: string,
  notes: string[],
  blueprints: CatalogBlueprint[],
  context: ImportContext
): SourceDraft | null {
  if (!isRecord(raw)) return null;

  if (raw.kind && raw.kind !== 'addonCatalog') {
    context.nativeCount += 1;
    const rebuilt = fromFusionNativeSource(raw);
    if (rebuilt.ok === true) context.convertibleCount += 1;

    if (context.convertNative && rebuilt.ok === true) {
      blueprints.push(rebuilt.blueprint);
      return rebuilt.source;
    }

    const passthrough = fusionNativePassthrough(raw);
    if (passthrough) return passthrough;

    notes.push(`Skipped ${rebuilt.ok === true ? 'a source this editor cannot hold' : rebuilt.reason}.`);
    return null;
  }

  const payload = isRecord(raw.payload) ? raw.payload : {};
  const split = splitCatalogId(trimmed(payload.catalogId), trimmed(payload.type || payload.catalogType));
  if (!split) {
    notes.push(`"${label}": skipped a source with no catalog id.`);
    return null;
  }

  const embedded = fromEmbedded(payload, label);
  blueprints.push(...embedded);

  // The tile title names the tile; the catalog it carries names the source.
  const own = embedded.find((b) => lookupKey(b.id, b.type) === lookupKey(split.catalogId, split.type));
  return {
    catalogId: split.catalogId,
    type: split.type,
    name: (own && own.name !== own.id ? own.name : '') || trimmed(label) || split.catalogId,
    genre: trimmed(payload.genre) || split.genre,
  };
}

/** Widget files spell a tile title/imageAspect/imageURL, collection files name/layout/backgroundImageURL. */
function fusionItem(
  raw: unknown,
  notes: string[],
  blueprints: CatalogBlueprint[],
  context: ImportContext
): FolderDraft | null {
  if (!isRecord(raw)) return null;
  const title = trimmed(raw.title || raw.name);
  if (!title) {
    notes.push('Skipped an item with no name.');
    return null;
  }

  const rawSources = Array.isArray(raw.dataSources)
    ? raw.dataSources
    : isRecord(raw.dataSource) ? [raw.dataSource] : [];
  const sources = rawSources
    .map((source: unknown) => fusionSource(source, title, notes, blueprints, context))
    .filter((source): source is SourceDraft => source !== null);

  const seen = new Set<string>();
  const unique = sources.filter((source: SourceDraft) => {
    const key = `${source.catalogId}:${source.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    ...createFolderDraft(title),
    id: trimmed(raw.id) || newId(),
    title,
    shape: toShape(raw.imageAspect || raw.layout),
    hideTitle: Boolean(raw.hideTitle),
    coverImageUrl: trimmed(raw.imageURL || raw.backgroundImageURL),
    sources: unique,
  };
}

export function fromFusionWidgets(
  input: unknown,
  notes: string[],
  blueprints: CatalogBlueprint[] = [],
  context: ImportContext = { convertNative: false, nativeCount: 0, convertibleCount: 0 }
): BuilderEntry[] {
  if (Array.isArray(input) && input.some(looksLikeFusionTile)) {
    const folders = input
      .map((tile: unknown) => fusionItem(tile, notes, blueprints, context))
      .filter((folder): folder is FolderDraft => folder !== null);
    notes.push('This is a collection file, which holds tiles but no row. They were put in one collection you can rename.');
    return [{ ...createCollectionDraft('Imported collection'), folders }];
  }

  const widgets = isRecord(input) && Array.isArray(input.widgets)
    ? input.widgets
    : Array.isArray(input) ? input : [];

  const entries: BuilderEntry[] = [];
  for (const raw of widgets) {
    if (!isRecord(raw)) continue;
    const title = trimmed(raw.title);
    if (!title) {
      notes.push('Skipped a widget with no title.');
      continue;
    }

    if (trimmed(raw.type).startsWith('row.classic')) {
      const source = fusionSource(raw.dataSource, title, notes, blueprints, context);
      const presentation = isRecord(raw.presentation) ? raw.presentation : {};
      const badges = isRecord(presentation.badges) ? presentation.badges : {};
      const row: ClassicRowDraft = {
        ...createClassicRowDraft(title),
        id: unprefixedId(raw.id, 'catalog.') || newId(),
        title,
        hideTitle: Boolean(raw.hideTitle),
        source,
        limit: Number.isFinite(Number(raw.limit)) ? Math.trunc(Number(raw.limit)) : 20,
        cacheTTL: Number.isFinite(Number(raw.cacheTTL)) ? Math.trunc(Number(raw.cacheTTL)) : 1800,
        aspectRatio: toAspect(presentation.aspectRatio),
        cardStyle: toCardStyle(presentation.cardStyle),
        badges: { providers: Boolean(badges.providers), ratings: badges.ratings !== false },
        backgroundImageURL: trimmed(presentation.backgroundImageURL),
        numbered: trimmed(raw.type) === 'row.classic.numbered',
      };
      entries.push(row);
      continue;
    }

    const dataSource = isRecord(raw.dataSource) ? raw.dataSource : {};
    const payload = isRecord(dataSource.payload) ? dataSource.payload : {};
    const items = Array.isArray(payload.items) ? payload.items : [];
    const folders = items
      .map((item: unknown) => fusionItem(item, notes, blueprints, context))
      .filter((folder): folder is FolderDraft => folder !== null);

    entries.push({
      ...createCollectionDraft(title),
      id: unprefixedId(raw.id, 'collection.') || newId(),
      title,
      hideTitle: Boolean(raw.hideTitle),
      folders,
    });
  }
  return entries;
}

// ---- Builder's own shape, for restoring a config backup ----

function fromBuilderEntries(input: unknown, notes: string[]): BuilderEntry[] {
  const list = Array.isArray(input)
    ? input
    : isRecord(input) && Array.isArray(input.entries) ? input.entries : [];

  const entries: BuilderEntry[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    if (raw.kind === 'classicRow') {
      entries.push({ ...createClassicRowDraft(trimmed(raw.title)), ...raw } as ClassicRowDraft);
      continue;
    }
    if (raw.kind === 'collection') {
      entries.push({ ...createCollectionDraft(trimmed(raw.title)), ...raw } as CollectionDraft);
      continue;
    }
    notes.push('Skipped an entry with an unknown kind.');
  }
  return entries;
}

/**
 * Accepts whatever the user has on hand: the Nuvio array, the Fusion envelope,
 * or a raw config backup. Anything that cannot be represented in the editor is
 * reported rather than dropped quietly.
 */
function collapseNotes(notes: string[]): string[] {
  const counts = new Map<string, number>();
  for (const note of notes) counts.set(note, (counts.get(note) || 0) + 1);
  return [...counts.entries()].map(([note, count]) => (count > 1 ? `${note} (×${count})` : note));
}

/**
 * A blueprint's `type` is the catalog's own, before any displayType renamed it,
 * which is what a source needs to be matched against another setup's manifest.
 * The writer attaches a blueprint once per catalog, so the collected list answers
 * for every source pointing at it rather than only the one that carried it.
 */
function withBlueprintTypes(entries: BuilderEntry[], blueprints: CatalogBlueprint[]): BuilderEntry[] {
  if (blueprints.length === 0) return entries;
  const typeById = new Map(blueprints.map(blueprint => [blueprint.id, blueprint.type as string]));

  const apply = (source: SourceDraft): SourceDraft => {
    if (trimmed(source.baseType)) return source;
    const id = trimmed(source.catalogId);
    const baseType = typeById.get(id)
      ?? SUFFIX_TYPES.reduce<string | undefined>((found, suffix) => found
        ?? (id.toLowerCase().endsWith(`_${suffix}`)
          ? typeById.get(id.slice(0, -(suffix.length + 1)))
          : undefined), undefined);
    return baseType ? { ...source, baseType } : source;
  };

  return entries.map(entry => {
    if (entry.kind === 'classicRow') {
      return entry.source ? { ...entry, source: apply(entry.source) } : entry;
    }
    return {
      ...entry,
      folders: entry.folders.map(folder => ({ ...folder, sources: folder.sources.map(apply) })),
    };
  });
}

export function importEntries(raw: unknown, options: ImportOptions = {}): ImportResult {
  const notes: string[] = [];
  const blueprints: CatalogBlueprint[] = [];
  const context: ImportContext = {
    convertNative: options.convertNative === true,
    nativeCount: 0,
    convertibleCount: 0,
  };
  const format = detectFormat(raw);

  const done = (entries: BuilderEntry[]): ImportResult => {
    const unique = dedupeBlueprints(blueprints);
    return {
      format,
      entries: withBlueprintTypes(entries, unique),
      notes: collapseNotes(notes),
      blueprints: unique,
      nativeCount: context.nativeCount,
      convertibleCount: context.convertibleCount,
    };
  };

  if (format === 'nuvio') return done(fromNuvioCollections(raw, notes, blueprints, context));
  if (format === 'fusion') return done(fromFusionWidgets(raw, notes, blueprints, context));
  if (format === 'builder') return done(fromBuilderEntries(raw, notes));

  return {
    format: 'unknown',
    entries: [],
    notes: ['Could not tell what this file is.'],
    blueprints: [],
    nativeCount: 0,
    convertibleCount: 0,
  };
}

export function parseImport(text: string, options: ImportOptions = {}): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      format: 'unknown',
      entries: [],
      notes: ['That is not valid JSON.'],
      blueprints: [],
      nativeCount: 0,
      convertibleCount: 0,
    };
  }
  return importEntries(parsed, options);
}

/** One missing catalog, plus every place it is referenced. */
export interface MissingCatalogGroup {
  key: string;
  catalogId: string;
  type: string;
  name: string;
  occurrences: number;
}

export function groupMissingCatalogs(missing: SourceDraft[]): MissingCatalogGroup[] {
  const groups = new Map<string, MissingCatalogGroup>();
  for (const source of missing) {
    const key = `${source.catalogId}:${source.type}`;
    const existing = groups.get(key);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    groups.set(key, {
      key,
      catalogId: source.catalogId,
      type: source.type,
      name: trimmed(source.name) || source.catalogId,
      occurrences: 1,
    });
  }
  return [...groups.values()];
}

/**
 * Swaps missing catalogs for ones the user has, everywhere they appear. Lets an
 * imported layout be kept while the catalogs behind it are plugged in.
 */
export function remapSources(
  entries: BuilderEntry[],
  mapping: Record<string, SourceDraft>
): { entries: BuilderEntry[]; replaced: number } {
  let replaced = 0;

  const swap = (source: SourceDraft): SourceDraft => {
    const target = mapping[`${source.catalogId}:${source.type}`];
    if (!target) return source;
    replaced += 1;
    return { ...target };
  };

  /** A folder must not end up holding the same catalog twice after a swap. */
  const dedupe = (sources: SourceDraft[]): SourceDraft[] => {
    const seen = new Set<string>();
    return sources.filter(source => {
      const key = `${source.catalogId}:${source.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const next = entries.map((entry): BuilderEntry => {
    if (entry.kind === 'classicRow') {
      return entry.source ? { ...entry, source: swap(entry.source) } : entry;
    }
    return {
      ...entry,
      folders: entry.folders.map(folder => ({
        ...folder,
        sources: dedupe(folder.sources.map(swap)),
      })),
    };
  });

  return { entries: next, replaced };
}
