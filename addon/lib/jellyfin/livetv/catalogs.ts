// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { extrasOf, isAddonError, type AddonDeps, type Manifest } from '../addonReader';
import { groupNameOf } from './bounds';

// An addon may wait some seconds for a guide it is still loading before it answers.
const GUIDE_TIMEOUT_MS = 10 * 1000;

export interface LiveCatalog {
  type: string;
  id: string;
  name: string;
  guide: boolean;
  skip: boolean;
  search: boolean;
  ids: boolean;
  groups: string[];
  /** The group it is narrowed to. */
  genre?: string;
}

export interface PageQuery {
  skip?: number;
  date?: string;
  search?: string;
  ids?: string[];
}

const IDS_PER_READ = 100;
const IDS_LENGTH = 4000;

/** The channels of each read by ids, as many as one path holds. */
export function idChunks<T extends { id: string }>(channels: T[]): T[][] {
  const chunks: T[][] = [];
  let length = 0;
  for (const channel of channels) {
    const own = encodeURIComponent(channel.id).length + 1;
    const last = chunks[chunks.length - 1];
    if (last && last.length < IDS_PER_READ && length + own <= IDS_LENGTH) {
      last.push(channel);
      length += own;
    } else {
      chunks.push([channel]);
      length = own;
    }
  }
  return chunks;
}

const groupsOf = (options: unknown[] = []): string[] => options.filter((o): o is string => groupNameOf(o) !== undefined);

/** Each picked group as a catalog of its own, in the addon's order. It answers for that group alone. */
export function pickedCatalogs(catalogs: LiveCatalog[], picked: Set<string>): LiveCatalog[] {
  return catalogs.flatMap((c) => c.groups.filter((name) => picked.has(name)).map((name) => ({ ...c, groups: [name], genre: name })));
}

/** The addon's own catalogs behind these, each once. */
export function wholeCatalogs(catalogs: LiveCatalog[]): LiveCatalog[] {
  const whole = new Map<string, LiveCatalog>();
  for (const { genre: _, ...catalog } of catalogs) if (!whole.has(catalogKey(catalog))) whole.set(catalogKey(catalog), catalog);
  return [...whole.values()];
}

/** The groups these catalogs are narrowed to, or undefined when they are the addon's own. */
export function narrowedTo(catalogs: LiveCatalog[]): Set<string> | undefined {
  const names = catalogs.flatMap((c) => (c.genre === undefined ? [] : [c.genre]));
  return names.length ? new Set(names) : undefined;
}

export const catalogKey = ({ type, id, genre }: LiveCatalog): string => `${type}|${id}${genre === undefined ? '' : `|${genre}`}`;

export function liveCatalogs(manifest: Manifest | null | undefined): LiveCatalog[] {
  const epg = manifest?.behaviorHints?.epgProvider === true;
  const seen = new Set<string>();
  const live: LiveCatalog[] = [];
  for (const catalog of Array.isArray(manifest?.catalogs) ? manifest!.catalogs : []) {
    if (typeof catalog?.type !== 'string' || typeof catalog?.id !== 'string') continue;
    const extras = extrasOf(catalog);
    if (extras.some((e) => e.isRequired)) continue;
    const names = new Set(extras.map((e) => e.name));
    const guide = names.has('date');
    if (catalog.type !== 'tv' && !(guide && epg)) continue;
    const key = `${catalog.type}|${catalog.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    live.push({
      type: catalog.type,
      id: catalog.id,
      name: typeof catalog.name === 'string' && catalog.name ? catalog.name : catalog.id,
      guide,
      skip: names.has('skip'),
      search: names.has('search'),
      ids: names.has('ids'),
      groups: groupsOf(extras.find((e) => e.name === 'genre')?.options),
    });
  }
  return live;
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function pagePath(catalog: LiveCatalog, query: PageQuery): string {
  const extras: string[] = [];
  if (query.date) extras.push(`date=${encodeURIComponent(query.date)}`);
  if (catalog.genre !== undefined) extras.push(`genre=${encodeURIComponent(catalog.genre)}`);
  if (catalog.skip && query.skip && query.skip > 0) extras.push(`skip=${encodeURIComponent(String(query.skip))}`);
  if (query.ids) extras.push(`ids=${query.ids.map(encodeURIComponent).join(',')}`);
  if (query.search) extras.push(`search=${encodeURIComponent(query.search)}`);
  const head = `/catalog/${encodeURIComponent(catalog.type)}/${encodeURIComponent(catalog.id)}`;
  return extras.length ? `${head}/${extras.join('&')}.json` : `${head}.json`;
}

const AIOSTREAMS_CATALOG = /\.(xtream|m3u)$/;
const AIOSTREAMS_CHANNEL = /^(xtream|m3u)\.[0-9a-f]{8}:/;
export const AIOSTREAMS_PAGE = 100;

/** Whether a catalog is one of the sources built into AIOStreams. */
export const isAioStreams = (catalog: LiveCatalog): boolean => AIOSTREAMS_CATALOG.test(catalog.id);

/**
 * Whether a page is the last, as the sources built into AIOStreams page: by 100.
 * A round count may be a whole page of another size. Other addons' pages may be
 * short anywhere, so only an empty one ends theirs.
 */
export function endsList(catalog: LiveCatalog, page: any[]): boolean {
  return isAioStreams(catalog)
    && page.length < AIOSTREAMS_PAGE
    && page.length % 10 !== 0
    && page.every((entry) => AIOSTREAMS_CHANNEL.test(String(entry.id)));
}

export async function readPage(addon: Pick<AddonDeps, 'fetchJson'>, base: string, catalog: LiveCatalog, query: PageQuery, until?: number): Promise<any[] | null> {
  const body = await addon.fetchJson(base, pagePath(catalog, query), query.date ? GUIDE_TIMEOUT_MS : undefined, until);
  if (!body) return null;
  const lists = query.date ? [body.metasDetailed, body.metas] : [body.metas];
  const entries = lists.find(Array.isArray);
  if (entries) {
    const kept = entries.filter((e: any) => e && typeof e === 'object' && !isAddonError(e));
    return kept.length || !entries.some(isAddonError) ? kept : null;
  }
  return lists.includes(null) ? [] : null;
}
