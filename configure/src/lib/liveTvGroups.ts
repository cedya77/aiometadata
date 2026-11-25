// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { LiveTvPick } from '@/contexts/config';

export const MAX_PICKED = 1000;

// What the server keeps of a manifest: the limits of addonReader.ts.
const MAX_CATALOGS = 50;
const MAX_OPTIONS = 5000;
const MAX_OPTION = 200;
const MAX_MANIFEST = 256 * 1024;

interface Extra {
  name: string;
  isRequired?: boolean;
  options?: unknown[];
}

const kept = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_OPTION;

const listed = (value: unknown): any[] => (Array.isArray(value) ? value : []);

/** The extras a catalog declares, as the server reads them: objects, or the older lists of names. */
function extrasOf(catalog: any): Extra[] {
  const extras = new Map<string, Extra>();
  for (const extra of listed(catalog.extra)) {
    if (typeof extra?.name !== 'string') continue;
    extras.set(extra.name, { name: extra.name, isRequired: Boolean(extra.isRequired), options: extra.name === 'genre' ? listed(extra.options) : undefined });
  }
  for (const name of listed(catalog.extraSupported)) if (typeof name === 'string' && !extras.has(name)) extras.set(name, { name });
  for (const name of listed(catalog.extraRequired)) if (typeof name === 'string') extras.set(name, { name, isRequired: true });
  return [...extras.values()];
}

/** The channel groups the server can apply: of the live catalogs, as far as it keeps the manifest. */
export function channelGroups(manifest: any): string[] {
  const guideProvider = manifest?.behaviorHints?.epgProvider === true;
  const groups = new Set<string>();
  const seen = new Set<string>();
  let room = MAX_MANIFEST;
  const fits = (value: string) => (room -= value.length + 4) >= 0;
  let count = 0;
  for (const catalog of listed(manifest?.catalogs)) {
    if (count >= MAX_CATALOGS) break;
    if (!kept(catalog?.type) || !kept(catalog.id)) continue;
    const extras = extrasOf(catalog).filter((e) => kept(e.name)).slice(0, MAX_CATALOGS);
    const guide = extras.some((e) => e.name === 'date');
    if (catalog.type !== 'tv' && !guide) continue;
    if (![catalog.type, catalog.id, ...extras.map((e) => e.name)].every(fits)) break;
    // Also what is not offered below takes room.
    const options = listed(extras.find((e) => e.name === 'genre')?.options).slice(0, MAX_OPTIONS).filter((o) => kept(o) && fits(o));
    count++;
    const key = `${catalog.type}|${catalog.id}`;
    if (extras.some((e) => e.isRequired) || (catalog.type !== 'tv' && !guideProvider) || seen.has(key)) continue;
    seen.add(key);
    for (const option of options) groups.add(option);
  }
  return [...groups];
}

/** The addon a URL is of, as the server tells one: with or without its scheme and what follows its base. */
function baseOf(url: string): string | null {
  let base = url.trim();
  if (!base) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(base);
  if (!scheme) base = `https://${base}`;
  else if (!/^https?$/i.test(scheme[1])) return null;
  base = base.replace(/\/+$/, '').replace(/\/manifest\.json$/i, '').replace(/\/stream$/i, '');
  try {
    new URL(base);
    return base;
  } catch {
    return null;
  }
}

/** Where the manifest of the addon a URL is of can be read. */
export function manifestUrlOf(url: string): string | null {
  const base = baseOf(url);
  return base === null ? null : `${base}/manifest.json`;
}

export function sameAddon(a: string, b: string): boolean {
  const [one, other] = [a, b].map((url) => baseOf(url.trim().replace(/^stremio:\/\//i, 'https://')));
  return one !== null && one === other;
}

export function withGroups(pick: LiveTvPick | undefined, addon: string, groups: string[]): LiveTvPick | undefined {
  const kept = [...new Set(groups)].slice(0, MAX_PICKED);
  return kept.length ? { ...pick, addon: addon.trim(), groups: kept } : undefined;
}

/** A choice made with or without a rating counts only while that still holds. */
export function onlyPicked(pick: LiveTvPick | undefined, rated: boolean): boolean {
  return pick?.only?.rated === rated ? pick.only.on : rated;
}

export function withOnly(pick: LiveTvPick, on: boolean, rated: boolean): LiveTvPick {
  const { only: _, ...rest } = pick;
  return on === rated ? rest : { ...rest, only: { on, rated } };
}
