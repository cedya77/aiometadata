// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { extrasOf, type AddonDeps, type Manifest } from '../addonReader';

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
}

export interface PageQuery {
  skip?: number;
  date?: string;
  search?: string;
  ids?: string[];
}

/** How many channels are asked for by their ids in one read. */
export const IDS_PER_READ = 50;

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
  if (catalog.skip && query.skip && query.skip > 0) extras.push(`skip=${encodeURIComponent(String(query.skip))}`);
  if (query.ids) extras.push(`ids=${query.ids.map(encodeURIComponent).join(',')}`);
  if (query.search) extras.push(`search=${encodeURIComponent(query.search)}`);
  const head = `/catalog/${encodeURIComponent(catalog.type)}/${encodeURIComponent(catalog.id)}`;
  return extras.length ? `${head}/${extras.join('&')}.json` : `${head}.json`;
}

/** AIOStreams answers a failure with 200 and an entry that names the error. */
export const isAddonError = (entry: any): boolean => String(entry?.id ?? '').startsWith('aiostreamserror.');

export async function readPage(addon: Pick<AddonDeps, 'fetchJson'>, base: string, catalog: LiveCatalog, query: PageQuery): Promise<any[] | null> {
  const body = await addon.fetchJson(base, pagePath(catalog, query), query.date ? GUIDE_TIMEOUT_MS : undefined);
  if (!body) return null;
  const lists = query.date ? [body.metasDetailed, body.metas] : [body.metas];
  const entries = lists.find(Array.isArray);
  if (entries) {
    const kept = entries.filter((e: any) => e && typeof e === 'object' && !isAddonError(e));
    return kept.length || !entries.some(isAddonError) ? kept : null;
  }
  return lists.includes(null) ? [] : null;
}
