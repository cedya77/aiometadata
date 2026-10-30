export type TileShape = 'POSTER' | 'LANDSCAPE' | 'SQUARE';
export type CollectionViewMode = 'TABBED_GRID' | 'ROWS' | 'FOLLOW_LAYOUT';

/** Types a manifest id can carry as a suffix, per createCatalog in getManifest. */
export const SUFFIX_TYPES = ['movie', 'series', 'anime', 'all'];

/** One addon catalog, referenced the way it appears in the generated manifest. */
export interface SourceDraft {
  catalogId: string;
  type: string;
  name: string;
  genre?: string | null;
  /** The catalog's own type, before a displayType renamed it. Neither target reads it. */
  baseType?: string;
  /**
   * A source the client resolves against TMDB or Trakt itself: Nuvio checks
   * `provider`, Fusion checks `kind`. Kept verbatim, and see nativeOrigin.
   */
  native?: Record<string, any>;
}

/** A tile inside a collection: a Nuvio folder, or a Fusion collection item. */
export interface FolderDraft {
  id: string;
  title: string;
  shape: TileShape;
  hideTitle: boolean;
  coverImageUrl?: string;
  coverEmoji?: string;
  focusGifUrl?: string;
  focusGifEnabled?: boolean;
  heroBackdropUrl?: string;
  heroVideoUrl?: string;
  titleLogoUrl?: string;
  sources: SourceDraft[];
  folders?: FolderDraft[];
}

export interface CollectionDraft {
  kind: 'collection';
  id: string;
  title: string;
  hideTitle?: boolean;
  backdropImageUrl?: string;
  pinToTop?: boolean;
  focusGlowEnabled?: boolean;
  viewMode?: CollectionViewMode;
  showAllTab?: boolean;
  /** Server users holding one of these see it; none means every user. */
  tags?: string[];
  after?: CatalogAnchor;
  folders: FolderDraft[];
}

export interface CatalogAnchor {
  id: string;
  type: string;
}

export interface CatalogRowOptions {
  title?: string;
  hideTitle?: boolean;
  numbered?: boolean;
}

/** Single-catalog row. Jellyfin only, Nuvio has no equivalent. */
export interface ClassicRowDraft {
  kind: 'classicRow';
  id: string;
  title: string;
  hideTitle?: boolean;
  source: SourceDraft | null;
  numbered?: boolean;
  tags?: string[];
}

export type BuilderEntry = CollectionDraft | ClassicRowDraft;

/** An entry with only the fields its kind has now; older versions wrote more on rows. */
export function currentFields<T extends BuilderEntry>(entry: T): T {
  if (entry.kind !== 'classicRow') return entry;
  const { kind, id, title, hideTitle, source, numbered, tags } = entry;
  return {
    kind,
    id,
    title,
    ...(hideTitle !== undefined && { hideTitle }),
    source,
    ...(numbered !== undefined && { numbered }),
    ...(tags !== undefined && { tags }),
  } as T;
}

/** Identity of this addon as Nuvio records it. */
export interface AddonIdentity {
  /** Manifest `id` field, used as Nuvio's addonId. */
  addonId: string;
  /** Manifest URL with `/manifest.json` stripped, used as Nuvio's addonBaseUrl. */
  addonBaseUrl: string;
  /** Manifest `name`, shown by Nuvio next to the source. */
  addonName: string;
}

// ---- Nuvio output (js/data/local/collectionsStore.js) ----

export interface NuvioAddonSource {
  provider: 'addon';
  addonId: string;
  addonBaseUrl: string | null;
  addonName: string | null;
  type: string;
  catalogId: string;
  catalogName: string | null;
  title: string;
  genre: string | null;
  /** See writeBlueprint in catalogReconstruction. Nuvio does not read this. */
  aiometadata?: { version: number; catalog: Record<string, any> };
}

export interface NuvioCatalogSource {
  addonId: string;
  addonBaseUrl: string | null;
  addonName: string | null;
  type: string;
  catalogId: string;
  catalogName: string | null;
  title: string | null;
  genre: string | null;
}

export interface NuvioFolder {
  id: string;
  title: string;
  coverImageUrl: string | null;
  focusGifUrl: string | null;
  focusGifEnabled: boolean;
  coverEmoji: string | null;
  tileShape: TileShape;
  hideTitle: boolean;
  sources: NuvioAddonSource[];
  catalogSources: NuvioCatalogSource[];
  heroBackdropUrl: string | null;
  heroVideoUrl: string | null;
  titleLogoUrl: string | null;
}

export interface NuvioCollection {
  id: string;
  title: string;
  backdropImageUrl: string | null;
  pinToTop: boolean;
  focusGlowEnabled: boolean;
  viewMode: CollectionViewMode;
  showAllTab: boolean;
  folders: NuvioFolder[];
}

// ---- Export result ----

/** Anything the target would have silently dropped, surfaced instead. */
export interface ExportNote {
  entryId: string;
  entryTitle: string;
  message: string;
  /** Absent means information; a tile the user built disappearing is a warning. */
  severity?: 'warning' | 'info';
}

export interface ExportResult<T> {
  output: T;
  notes: ExportNote[];
}

// ---- Defaults ----

/** Fusion's placeholder for a manifest URL the author does not want to publish. */
export const MANIFEST_PLACEHOLDER = 'YOUR_AIOMETADATA';

export function newId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `cb_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createCollectionDraft(title = 'New Collection'): CollectionDraft {
  return {
    kind: 'collection',
    id: newId(),
    title,
    hideTitle: false,
    backdropImageUrl: '',
    pinToTop: false,
    focusGlowEnabled: true,
    viewMode: 'TABBED_GRID',
    showAllTab: true,
    folders: [],
  };
}

export function createFolderDraft(title = 'New Folder'): FolderDraft {
  return {
    id: newId(),
    title,
    shape: 'POSTER',
    hideTitle: false,
    coverImageUrl: '',
    coverEmoji: '',
    focusGifUrl: '',
    focusGifEnabled: true,
    heroBackdropUrl: '',
    heroVideoUrl: '',
    titleLogoUrl: '',
    sources: [],
  };
}

/**
 * Nuvio-only fields are hidden on the Fusion target only while they are untouched.
 * Once a value is set it stays reachable, because it is still in the draft and
 * still exported to Nuvio: hiding it would mean owning data you cannot see.
 */
/** Every catalog an entry points at, flattened. */
export function entrySources(entry: BuilderEntry): SourceDraft[] {
  if (entry.kind === 'classicRow') return entry.source ? [entry.source] : [];
  return entry.folders.flatMap(folderSources);
}

export function subFolders(folder: FolderDraft): FolderDraft[] {
  return Array.isArray(folder.folders) ? folder.folders : [];
}

export function folderSources(folder: FolderDraft): SourceDraft[] {
  return [...folder.sources, ...subFolders(folder).flatMap(folderSources)];
}

export function allFolders(folders: FolderDraft[]): FolderDraft[] {
  return folders.flatMap(folder => [folder, ...allFolders(subFolders(folder))]);
}

export function findFolder(folders: FolderDraft[], id: string): FolderDraft | undefined {
  return allFolders(folders).find(folder => folder.id === id);
}

export function parentFolderOf(folders: FolderDraft[], id: string): FolderDraft | undefined {
  return allFolders(folders).find(folder => subFolders(folder).some(child => child.id === id));
}

export function mapFolder(folders: FolderDraft[], id: string, fn: (folder: FolderDraft) => FolderDraft): FolderDraft[] {
  return folders.map(folder => {
    if (folder.id === id) return fn(folder);
    if (!folder.folders?.length) return folder;
    const folders = mapFolder(folder.folders, id, fn);
    return folders === folder.folders ? folder : { ...folder, folders };
  });
}

export function mapFoldersDeep(folders: FolderDraft[], fn: (folder: FolderDraft) => FolderDraft): FolderDraft[] {
  return folders.map(folder => fn(folder.folders?.length ? { ...folder, folders: mapFoldersDeep(folder.folders, fn) } : folder));
}

export function removeFolder(folders: FolderDraft[], id: string): FolderDraft[] {
  return folders
    .filter(folder => folder.id !== id)
    .map(folder => (folder.folders?.length ? { ...folder, folders: removeFolder(folder.folders, id) } : folder));
}

export function hasNuvioCollectionSettings(entry: CollectionDraft): boolean {
  return Boolean(
    entry.pinToTop ||
    entry.focusGlowEnabled === false ||
    (entry.viewMode && entry.viewMode !== 'TABBED_GRID') ||
    entry.showAllTab === false
  );
}

export function hasNuvioFolderArt(folder: FolderDraft): boolean {
  return Boolean(
    (folder.coverEmoji || '').trim() ||
    (folder.focusGifUrl || '').trim() ||
    (folder.heroVideoUrl || '').trim() ||
    folder.focusGifEnabled === false
  );
}

export function createClassicRowDraft(title = 'New Row'): ClassicRowDraft {
  return {
    kind: 'classicRow',
    id: newId(),
    title,
    hideTitle: false,
    source: null,
    numbered: false,
  };
}
