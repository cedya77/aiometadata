// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { allCatalogDefinitions } from '@/data/catalogs';
import { SUFFIX_TYPES } from './catalogBlueprints';
import type { AppConfig, CatalogConfig } from '@/contexts/config';
import { allFolders, mapFoldersDeep, type AddonIdentity, type BuilderEntry, type SourceDraft } from '@shared/types';
import { isNativeSource } from '@shared/catalogReconstruction';
import { isUserSpecific } from '@shared/catalogSharing';

/** A catalog as it is addressable in the generated manifest. */
export interface ManifestCatalog {
  /** Manifest catalog id. Not always the same as CatalogConfig.id. */
  id: string;
  /** Manifest catalog type, which is what Nuvio records. */
  type: string;
  /** The config's own type for this catalog, which a displayType may have renamed. */
  baseType?: string;
  name: string;
  /** Source label from the user's config, for the picker only. */
  source?: string;
  genres?: string[];
  /** The catalog returns nothing without a genre, so a source has to carry one. */
  genreRequired?: boolean;
  /** What the manifest says it uses when the request carries no genre. */
  genreDefault?: string;
  /** In the local config but not yet in the manifest, so the config needs saving. */
  pendingSave?: boolean;
  /** Profile tags from the user's config. The manifest does not carry these. */
  tags?: string[];
}

export type CatalogListOrigin = 'manifest' | 'derived';

export interface CatalogSourceList {
  catalogs: ManifestCatalog[];
  origin: CatalogListOrigin;
  /** Set when the live manifest was requested but could not be used. */
  error?: string;
}

const FALLBACK_ADDON_ID = 'aio-metadata';
const MANIFEST_SUFFIX = '/manifest.json';

function trimmed(value: unknown): string {
  return String(value ?? '').trim();
}

export function stripManifestSuffix(manifestUrl: string): string {
  const value = trimmed(manifestUrl).replace(/\/+$/, '');
  if (value.toLowerCase().endsWith(MANIFEST_SUFFIX)) {
    return value.slice(0, -MANIFEST_SUFFIX.length).replace(/\/+$/, '');
  }
  return value;
}

export function buildManifestUrl(userUUID: string | null): string {
  if (!userUUID) return '';
  return `${window.location.origin}/stremio/${encodeURIComponent(userUUID)}${MANIFEST_SUFFIX}`;
}

export function buildIdentity(
  config: AppConfig,
  manifestUrl: string,
  overrides: Partial<AddonIdentity> = {}
): AddonIdentity {
  return {
    addonId: overrides.addonId || FALLBACK_ADDON_ID,
    addonBaseUrl: overrides.addonBaseUrl ?? stripManifestSuffix(manifestUrl),
    addonName: overrides.addonName || trimmed(config.addonName) || 'AIOMetadata',
  };
}

/** getManifest routes on the id alone, so a retyped catalog is still built-in. */
function isBuiltIn(catalog: CatalogConfig): boolean {
  return allCatalogDefinitions.some(def => def.id === catalog.id);
}

/**
 * Mirrors how getManifest builds catalog entries: the type is always
 * `displayType || type`, and built-in catalogs carrying a displayType get their
 * original type appended to the id (createCatalog in addon/lib/getManifest.ts).
 */
export function deriveManifestCatalog(catalog: CatalogConfig): ManifestCatalog {
  // createMalCatalog hardcodes anime and never reads displayType.
  const type = catalog.id.startsWith('mal.discover.')
    ? 'anime'
    : trimmed(catalog.displayType) || catalog.type;
  const builtIn = isBuiltIn(catalog);
  const id = catalog.displayType && builtIn ? `${catalog.id}_${catalog.type}` : catalog.id;
  // createCatalog is the one builder that does not offer "None" off the home row.
  const offersNone = !catalog.showInHome && !builtIn;
  const genres = offersNone
    ? ['None', ...(catalog.genres || []).filter(genre => genre !== 'None')]
    : catalog.genres;
  return {
    id,
    type,
    baseType: catalog.type,
    name: catalog.name,
    source: catalog.source,
    tags: catalog.tags,
    genres,
    genreRequired: !catalog.showInHome && (offersNone || (genres?.length ?? 0) > 0),
    genreDefault: offersNone ? 'None' : undefined,
  };
}

export function deriveCatalogList(config: AppConfig): ManifestCatalog[] {
  return (config.catalogs || [])
    .filter(catalog => catalog.enabled && !catalog.mergedInto)
    .map(deriveManifestCatalog);
}

/**
 * The live manifest is the accurate source, since it already resolved every id and
 * type quirk. Falls back to deriving from the local config when there is no saved
 * config to fetch, or the fetch fails.
 */
export async function loadCatalogSources(
  config: AppConfig,
  manifestUrl: string
): Promise<CatalogSourceList & { identity: Partial<AddonIdentity> }> {
  const derived = deriveCatalogList(config);
  const url = trimmed(manifestUrl);
  if (!url) {
    return { catalogs: derived, origin: 'derived', identity: {} };
  }

  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`Manifest responded ${response.status}`);
    }
    const manifest = await response.json();
    const entries = Array.isArray(manifest?.catalogs) ? manifest.catalogs : [];
    if (entries.length === 0) {
      throw new Error('Manifest contains no catalogs');
    }

    // With showPrefix on, every manifest catalog name is "<addon> - <name>".
    // That prefix is the same on every row here and only adds noise, and the
    // derived fallback does not carry it, so strip it for consistency.
    const namePrefix = config.showPrefix
      ? `${(trimmed(config.addonName) || 'AIOMetadata')} - `
      : '';
    const stripPrefix = (value: string) =>
      namePrefix && value.startsWith(namePrefix) ? value.slice(namePrefix.length) : value;

    const genresById = new Map<string, string[] | undefined>();
    const sourceById = new Map<string, string | undefined>();
    const tagsById = new Map<string, string[] | undefined>();
    // The manifest has spent the displayType, so only the config still has the original.
    const baseTypeById = new Map<string, string | undefined>();
    for (const catalog of derived) {
      genresById.set(`${catalog.id}:${catalog.type}`, catalog.genres);
      sourceById.set(`${catalog.id}:${catalog.type}`, catalog.source);
      tagsById.set(`${catalog.id}:${catalog.type}`, catalog.tags);
      baseTypeById.set(`${catalog.id}:${catalog.type}`, catalog.baseType);
    }

    const catalogs: ManifestCatalog[] = entries
      .filter((entry: any) => trimmed(entry?.id) && trimmed(entry?.type))
      .filter((entry: any) => !needsNonGenreExtra(entry))
      .map((entry: any) => {
        const key = `${trimmed(entry.id)}:${trimmed(entry.type)}`;
        return {
          id: trimmed(entry.id),
          type: trimmed(entry.type),
          baseType: baseTypeById.get(key),
          name: stripPrefix(trimmed(entry.name)) || trimmed(entry.id),
          source: sourceById.get(key),
          tags: tagsById.get(key),
          genres: genreOptions(entry) ?? genresById.get(key),
          genreRequired: isGenreRequired(entry),
          genreDefault: genreDefault(entry),
        };
      });

    // Catalogs added since the last save are absent from the manifest but are
    // legitimately the user's, so fold them in rather than treating them as
    // unknown. Marked so the UI can say they need a save to go live.
    const inManifest = new Set(catalogs.map(catalogKey));
    const pending = derived
      .filter(catalog => !inManifest.has(catalogKey(catalog)))
      .map(catalog => ({ ...catalog, pendingSave: true }));

    return {
      catalogs: [...catalogs, ...pending],
      origin: 'manifest',
      identity: {
        addonId: trimmed(manifest?.id) || FALLBACK_ADDON_ID,
        addonName: trimmed(manifest?.name) || undefined,
      },
    };
  } catch (error: any) {
    return {
      catalogs: derived,
      origin: 'derived',
      error: error?.message || 'Could not read the manifest',
      identity: {},
    };
  }
}

/**
 * Search, voice-actor and calendar catalogs need a parameter no collection can
 * supply, so they are not selectable. Genre is the one required extra a source
 * can actually carry.
 */
function needsNonGenreExtra(entry: any): boolean {
  if (!Array.isArray(entry?.extra)) return false;
  return entry.extra.some((item: any) => item?.isRequired && item?.name !== 'genre');
}

/** A manifest can name more than one extra "genre", so they read as one field. */
function genreExtras(entry: any): any[] {
  if (!Array.isArray(entry?.extra)) return [];
  return entry.extra.filter((item: any) => item?.name === 'genre');
}

function isGenreRequired(entry: any): boolean {
  return genreExtras(entry).some((item: any) => item?.isRequired);
}

/** The genre the manifest says it will use when the request carries none. */
function genreDefault(entry: any): string | undefined {
  for (const item of genreExtras(entry)) {
    const value = trimmed(item?.default);
    if (value) return value;
  }
  return undefined;
}

function genreOptions(entry: any): string[] | undefined {
  const extras = genreExtras(entry);
  if (extras.length === 0) return undefined;
  // When genre is required, getManifest prepends "None" as the unfiltered choice,
  // so it has to stay. Otherwise it is just noise.
  const required = extras.some((item: any) => item?.isRequired);

  // Options can repeat, so dedupe: they become React keys in the genre picker.
  const seen = new Set<string>();
  const options: string[] = [];
  for (const item of extras) {
    if (!Array.isArray(item?.options)) continue;
    for (const option of item.options) {
      const value = trimmed(option);
      if (!value || (!required && value === 'None')) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      options.push(String(option));
    }
  }
  return options.length > 0 ? options : undefined;
}

/**
 * Catalogs are only unique on (id, type): tmdb.top exists for both movie and
 * series. The type is folded because a Fusion file spells it lowercase while a
 * manifest carries the displayType as written, so `Anime` and `anime` are the
 * same catalog.
 */
export function catalogKey(catalog: { id?: string; catalogId?: string; type: string }): string {
  return `${catalog.id ?? catalog.catalogId ?? ''}:${String(catalog.type ?? '').toLowerCase()}`;
}

/** What the manifest says it will use anyway, so never a guess. */
function startingGenre(catalog: ManifestCatalog): string | null {
  if (!catalog.genreRequired) return null;
  return trimmed(catalog.genreDefault) || catalog.genres?.[0] || null;
}

/** The one way a picked catalog becomes a source, so every picker agrees. */
export function sourceFromCatalog(catalog: ManifestCatalog): SourceDraft {
  return {
    catalogId: catalog.id,
    type: catalog.type,
    name: catalog.name,
    genre: startingGenre(catalog),
    ...(catalog.baseType ? { baseType: catalog.baseType } : {}),
  };
}

/** A file that carries no genre for a catalog that needs one leaves an empty row. */
export function fillMissingGenres(
  entries: BuilderEntry[],
  catalogs: ManifestCatalog[]
): { entries: BuilderEntry[]; filled: Array<{ name: string; genre: string }> } {
  const byKey = new Map(catalogs.map(catalog => [catalogKey(catalog), catalog]));
  const filled: Array<{ name: string; genre: string }> = [];

  const fill = (source: SourceDraft): SourceDraft => {
    if (isNativeSource(source) || trimmed(source.genre)) return source;
    const match = byKey.get(catalogKey(source));
    const genre = match ? startingGenre(match) : null;
    if (!genre) return source;
    filled.push({ name: match?.name || source.name || source.catalogId, genre });
    return { ...source, genre };
  };

  return { entries: mapSources(entries, fill), filled };
}

/** Sources whose catalog is not in the resolved catalog list, keyed for lookup. */
export function findUnknownSources(
  entries: BuilderEntry[],
  catalogs: ManifestCatalog[]
): SourceDraft[] {
  const known = new Set(catalogs.map(catalogKey));
  const unknown: SourceDraft[] = [];
  for (const entry of entries) {
    const sources = entry.kind === 'classicRow'
      ? (entry.source ? [entry.source] : [])
      : allFolders(entry.folders).flatMap(folder => folder.sources);
    for (const source of sources) {
      if (isNativeSource(source)) continue;
      if (!known.has(catalogKey(source))) unknown.push(source);
    }
  }
  return unknown;
}

/** Same reference when nothing changed, so an effect using this cannot re-trigger. */
function mapSources(
  entries: BuilderEntry[],
  rewrite: (source: SourceDraft) => SourceDraft
): BuilderEntry[] {
  let changed = false;

  const next = entries.map((entry): BuilderEntry => {
    if (entry.kind === 'classicRow') {
      if (!entry.source) return entry;
      const source = rewrite(entry.source);
      if (source === entry.source) return entry;
      changed = true;
      return { ...entry, source };
    }

    let entryChanged = false;
    const folders = mapFoldersDeep(entry.folders, folder => {
      let folderChanged = false;
      const sources = folder.sources.map(source => {
        const next = rewrite(source);
        if (next !== source) folderChanged = true;
        return next;
      });
      if (!folderChanged) return folder;
      entryChanged = true;
      return { ...folder, sources };
    });

    if (!entryChanged) return entry;
    changed = true;
    return { ...entry, folders };
  });

  return changed ? next : entries;
}

/**
 * A suffixed id spells the original type while the manifest type is the displayType
 * that renamed it, so only the pair identifies a catalog across setups.
 */
function baseCatalogKey(id: string, type: string, baseType?: string): string {
  for (const suffix of SUFFIX_TYPES) {
    if (!id.toLowerCase().endsWith(`_${suffix}`)) continue;
    const base = id.slice(0, -(suffix.length + 1));
    // createCatalog only suffixes built-in catalogs, so an id that merely ends
    // that way keeps its own name.
    if (allCatalogDefinitions.some(def => def.id === base && def.type === suffix)) {
      return `${base}:${suffix}`;
    }
  }
  return `${id}:${(trimmed(baseType) || type).toLowerCase()}`;
}

/**
 * The same catalog is `mal.studios` in one setup and `mal.studios_anime` in
 * another. An import spells it the author's way, which returns nothing here.
 */
export function realignSourceIds(
  entries: BuilderEntry[],
  catalogs: ManifestCatalog[]
): BuilderEntry[] {
  const known = new Set(catalogs.map(catalogKey));
  const byBase = new Map<string, ManifestCatalog>();
  for (const catalog of catalogs) {
    const key = baseCatalogKey(catalog.id, catalog.type, catalog.baseType);
    if (!byBase.has(key)) byBase.set(key, catalog);
  }

  const realign = (source: SourceDraft): SourceDraft => {
    if (isNativeSource(source)) return source;
    if (known.has(catalogKey(source))) return source;
    const match = byBase.get(
      baseCatalogKey(trimmed(source.catalogId), trimmed(source.type), source.baseType)
    );
    if (!match) return source;
    return { ...source, catalogId: match.id, type: match.type, baseType: match.baseType };
  };

  return mapSources(entries, realign);
}

/**
 * Imported files carry whatever the author's setup called a catalog, and Fusion
 * files carry no name at all. Where the catalog is one of ours, prefer our own
 * name so the editor shows what the user recognises instead of a raw id.
 */
export function healSourceNames(
  entries: BuilderEntry[],
  catalogs: ManifestCatalog[]
): BuilderEntry[] {
  const byKey = new Map(catalogs.map(catalog => [catalogKey(catalog), catalog]));

  const heal = (source: SourceDraft): SourceDraft => {
    if (isNativeSource(source)) return source;
    const match = byKey.get(catalogKey(source));
    if (!match) return source;

    const name = match.name && match.name !== source.name ? match.name : undefined;
    const baseType = match.baseType && match.baseType !== source.baseType
      ? match.baseType
      : undefined;
    if (!name && !baseType) return source;

    return {
      ...source,
      ...(name ? { name } : {}),
      ...(baseType ? { baseType } : {}),
    };
  };

  return mapSources(entries, heal);
}

export interface SourceIssue {
  entryId: string;
  entryTitle: string;
  message: string;
  /** Set when the source sits in a folder, so a caller can open the right one. */
  folderId?: string;
}

/** Ids that name one person's own list, whoever's file they arrived in. */
function isPersonalListId(catalogId: string): boolean {
  if (isUserSpecific(catalogId)) return true;
  return catalogId.startsWith('publicmetadb.list.');
}

/** Flags sources whose catalog is no longer in the manifest, or whose type is mixed case. */
export function findSourceIssues(
  entries: BuilderEntry[],
  catalogs: ManifestCatalog[]
): SourceIssue[] {
  const byKey = new Map(catalogs.map(catalog => [catalogKey(catalog), catalog]));
  const issues: SourceIssue[] = [];

  const check = (source: SourceDraft, entryId: string, entryTitle: string, folderId?: string) => {
    if (isNativeSource(source)) return;
    const label = trimmed(source.name) || trimmed(source.catalogId) || 'unnamed';
    const match = byKey.get(catalogKey(source));
    if (!match) {
      issues.push({
        entryId,
        entryTitle,
        folderId,
        message: isPersonalListId(trimmed(source.catalogId))
          ? `"${label}" belongs to whoever built this file and cannot be rebuilt here. Swap it for your own list, or remove it.`
          : `"${label}" is not in your catalogs. It may have been disabled, merged, or removed.`,
      });
    } else if (match.genreRequired && !trimmed(source.genre)) {
      issues.push({
        entryId,
        entryTitle,
        folderId,
        message: `"${label}" requires a genre. Pick one, or it returns nothing.`,
      });
    }
    if (source.type && source.type !== source.type.toLowerCase()) {
      issues.push({
        entryId,
        entryTitle,
        folderId,
        message: `"${label}" has a mixed-case type ("${source.type}"). Nuvio lowercases it when requesting the catalog.`,
      });
    }
  };

  for (const entry of entries) {
    if (entry.kind === 'collection') {
      for (const folder of allFolders(entry.folders)) {
        for (const source of folder.sources) {
          check(source, entry.id, folder.title || entry.title, folder.id);
        }
      }
      continue;
    }
    if (entry.source) check(entry.source, entry.id, entry.title);
  }

  return issues;
}
