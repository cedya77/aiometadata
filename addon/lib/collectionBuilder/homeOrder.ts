import type { BuilderEntry, CatalogAnchor, CatalogRowOptions, ClassicRowDraft, CollectionDraft } from './types';

type ConfiguredCatalog = { id: string; type: string; displayType?: string; row?: CatalogRowOptions };

export type HomeSlot =
  | { kind: 'catalog'; catalog: ConfiguredCatalog }
  | { kind: 'collection'; collection: CollectionDraft };

const LEADING = -1;

function anchorKey(anchor: CatalogAnchor): string {
  return `${anchor.type}\u0000${anchor.id}`;
}

function configuredCatalogs(config: any): ConfiguredCatalog[] {
  return (Array.isArray(config?.catalogs) ? config.catalogs : []).filter((c: any) => typeof c?.id === 'string' && typeof c?.type === 'string');
}

function configuredCollections(config: any): CollectionDraft[] {
  return (Array.isArray(config?.collections) ? config.collections : []).filter((e: any) => e?.kind === 'collection' && typeof e.id === 'string' && e.id);
}

export function anchorOf(catalog: { id: string; type: string }): CatalogAnchor {
  return { id: catalog.id, type: catalog.type };
}

export function configCatalogFor(config: any, catalog: { id: string; type: string }): any {
  const catalogs: any[] = Array.isArray(config?.catalogs) ? config.catalogs : [];
  const exact = catalogs.find((c) => c.id === catalog.id && (c.type === catalog.type || c.displayType === catalog.type));
  if (exact) return exact;
  const suffix = catalog.id.match(/_(movie|series|anime|all)$/);
  if (!suffix) return undefined;
  const stripped = catalog.id.slice(0, -suffix[0].length);
  return catalogs.find((c) => c.id === stripped && c.type === suffix[1])
    ?? catalogs.find((c) => c.id === stripped && (c.type === catalog.type || c.displayType === catalog.type));
}

export function rowOptionsOf(catalog: ConfiguredCatalog | undefined): CatalogRowOptions | null {
  const row = catalog?.row;
  if (!row || typeof row !== 'object') return null;
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  const options: CatalogRowOptions = {
    ...(title ? { title } : {}),
    ...(row.hideTitle === true ? { hideTitle: true } : {}),
    ...(row.numbered === true ? { numbered: true } : {}),
  };
  return Object.keys(options).length ? options : null;
}

function ranks(config: any): { catalogs: Map<string, number>; collections: Map<string, number> } {
  const catalogs = new Map<string, number>();
  configuredCatalogs(config).forEach((catalog, index) => {
    const key = anchorKey(catalog);
    if (!catalogs.has(key)) catalogs.set(key, index);
  });
  const collections = new Map<string, number>();
  configuredCollections(config).forEach((collection, index) => {
    const tie = index / 1e6;
    const after = collection.after;
    if (!after) collections.set(collection.id, LEADING + tie);
    else collections.set(collection.id, (catalogs.get(anchorKey(after)) ?? Number.POSITIVE_INFINITY) + 0.5 + tie);
  });
  return { catalogs, collections };
}

export function placeCollections<T, C>(
  config: any,
  items: T[],
  catalogOf: (item: T) => { id: string; type: string } | undefined,
  collections: C[],
  collectionIdOf: (collection: C) => string
): Array<T | C> {
  const { catalogs, collections: collectionRanks } = ranks(config);
  const queue = collections
    .map((collection) => ({ collection, rank: collectionRanks.get(collectionIdOf(collection)) ?? LEADING }))
    .sort((a, b) => a.rank - b.rank);
  const out: Array<T | C> = [];
  let carried = Number.NEGATIVE_INFINITY;
  let next = 0;
  for (const item of items) {
    const catalog = catalogOf(item);
    const rank = catalog ? catalogs.get(anchorKey(catalog)) : undefined;
    if (rank !== undefined) carried = rank;
    while (next < queue.length && queue[next].rank < carried) out.push(queue[next++].collection);
    out.push(item);
  }
  while (next < queue.length) out.push(queue[next++].collection);
  return out;
}

export function homeOrder(config: any): HomeSlot[] {
  return placeCollections<HomeSlot, HomeSlot>(
    config,
    configuredCatalogs(config).map((catalog) => ({ kind: 'catalog', catalog })),
    (slot) => (slot.kind === 'catalog' ? slot.catalog : undefined),
    configuredCollections(config).map((collection) => ({ kind: 'collection', collection })),
    (slot) => (slot.kind === 'collection' ? slot.collection.id : '')
  );
}

export function fromHomeOrder(slots: HomeSlot[]): { catalogs: ConfiguredCatalog[]; anchors: Map<string, CatalogAnchor | undefined> } {
  const catalogs: ConfiguredCatalog[] = [];
  const anchors = new Map<string, CatalogAnchor | undefined>();
  let previous: ConfiguredCatalog | undefined;
  for (const slot of slots) {
    if (slot.kind === 'catalog') {
      catalogs.push(slot.catalog);
      previous = slot.catalog;
    } else {
      anchors.set(slot.collection.id, previous ? anchorOf(previous) : undefined);
    }
  }
  return { catalogs, anchors };
}

export function withAnchor(collection: CollectionDraft, anchor: CatalogAnchor | undefined): CollectionDraft {
  const { after: _after, ...rest } = collection;
  return anchor ? { ...rest, after: anchor } : rest;
}

function rowOptionsFrom(row: ClassicRowDraft, catalogName: string): CatalogRowOptions | undefined {
  const title = row.title.trim();
  const options: CatalogRowOptions = {
    ...(title && title !== catalogName ? { title } : {}),
    ...(row.hideTitle === true ? { hideTitle: true } : {}),
    ...(row.numbered === true ? { numbered: true } : {}),
  };
  return Object.keys(options).length ? options : undefined;
}

function tagsWithRow(catalogTags: unknown, rowTags: unknown): string[] | undefined {
  const own = Array.isArray(catalogTags) ? catalogTags.filter((t): t is string => typeof t === 'string' && !!t) : [];
  if (!own.length) return undefined;
  const extra = Array.isArray(rowTags) ? rowTags.filter((t): t is string => typeof t === 'string' && !!t) : [];
  return [...new Set([...own, ...extra])];
}

export function foldRows(config: any, entries: BuilderEntry[]): { catalogs: any[]; collections: CollectionDraft[] } {
  const collections = entries.filter((entry): entry is CollectionDraft => entry.kind === 'collection');
  const catalogs: any[] = Array.isArray(config?.catalogs) ? [...config.catalogs] : [];
  if (!entries.some((entry) => entry.kind === 'classicRow')) return { catalogs, collections };

  const design: HomeSlot[] = [];
  const designed = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'collection') {
      design.push({ kind: 'collection', collection: entry });
      continue;
    }
    if (!entry.source) continue;
    const target = configCatalogFor({ catalogs }, { id: entry.source.catalogId, type: entry.source.type });
    if (!target) continue;
    const key = anchorKey(target);
    if (designed.has(key)) continue;
    designed.add(key);
    const row = rowOptionsFrom(entry, String(target.name ?? ''));
    const tags = tagsWithRow(target.tags, entry.tags);
    const folded = { ...target, ...(row ? { row } : {}), ...(tags ? { tags } : {}) };
    catalogs[catalogs.indexOf(target)] = folded;
    design.push({ kind: 'catalog', catalog: folded });
  }

  const rest: HomeSlot[] = catalogs
    .filter((catalog) => typeof catalog?.id === 'string' && !designed.has(anchorKey(catalog)))
    .map((catalog) => ({ kind: 'catalog', catalog }));
  const { catalogs: ordered, anchors } = fromHomeOrder([...design, ...rest]);
  const untyped = catalogs.filter((catalog) => typeof catalog?.id !== 'string' || typeof catalog?.type !== 'string');
  return {
    catalogs: [...ordered, ...untyped],
    collections: collections.map((collection) => withAnchor(collection, anchors.get(collection.id))),
  };
}

function unmovedPositions(order: Array<number | undefined>): Set<number> {
  const tails: number[] = [];
  const tailAt: number[] = [];
  const parent: number[] = new Array(order.length).fill(-1);
  order.forEach((value, index) => {
    if (value === undefined) return;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = value;
    tailAt[lo] = index;
    parent[index] = lo > 0 ? tailAt[lo - 1] : -1;
  });
  const kept = new Set<number>();
  let at = tails.length ? tailAt[tails.length - 1] : -1;
  while (at !== -1) {
    kept.add(at);
    at = parent[at];
  }
  return kept;
}

export function keepCollectionsInPlace<T>(prev: T, next: T): T {
  const before = prev as any;
  const after = next as any;
  if (!before || !after || before === after || before.catalogs === after.catalogs || before.collections !== after.collections) return next;
  const collections: any[] = Array.isArray(after.collections) ? after.collections : [];
  if (!collections.some((entry) => entry?.kind === 'collection' && entry.after)) return next;

  const previous = configuredCatalogs(before);
  const nextIndex = new Map<string, number>();
  configuredCatalogs(after).forEach((catalog, index) => {
    const key = anchorKey(catalog);
    if (!nextIndex.has(key)) nextIndex.set(key, index);
  });
  const kept = unmovedPositions(previous.map((catalog) => nextIndex.get(anchorKey(catalog))));
  const previousIndex = new Map<string, number>();
  previous.forEach((catalog, index) => {
    const key = anchorKey(catalog);
    if (!previousIndex.has(key)) previousIndex.set(key, index);
  });

  let changed = false;
  const placed = collections.map((entry) => {
    if (entry?.kind !== 'collection' || !entry.after) return entry;
    const at = previousIndex.get(anchorKey(entry.after));
    if (at === undefined || kept.has(at)) return entry;
    let back = at - 1;
    while (back >= 0 && !kept.has(back)) back -= 1;
    changed = true;
    return withAnchor(entry, back >= 0 ? anchorOf(previous[back]) : undefined);
  });
  return changed ? ({ ...after, collections: placed } as T) : next;
}
