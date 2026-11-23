// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { AddonDeps, Manifest } from '../addonReader';

export interface LiveCatalog {
  type: string;
  id: string;
  name: string;
  guide: boolean;
  skip: boolean;
  search: boolean;
}

export interface PageQuery {
  skip?: number;
  date?: string;
  search?: string;
}

function extrasOf(catalog: any): any[] {
  return Array.isArray(catalog?.extra) ? catalog.extra.filter((e: any) => e && typeof e.name === 'string') : [];
}

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
  if (query.search) extras.push(`search=${encodeURIComponent(query.search)}`);
  const head = `/catalog/${encodeURIComponent(catalog.type)}/${encodeURIComponent(catalog.id)}`;
  return extras.length ? `${head}/${extras.join('&')}.json` : `${head}.json`;
}

export async function readPage(addon: Pick<AddonDeps, 'fetchJson'>, base: string, catalog: LiveCatalog, query: PageQuery): Promise<any[] | null> {
  const body = await addon.fetchJson(base, pagePath(catalog, query));
  if (!body) return null;
  const entries = query.date && Array.isArray(body.metasDetailed) ? body.metasDetailed : body.metas;
  return Array.isArray(entries) ? entries.filter((e: any) => e && typeof e === 'object') : [];
}
