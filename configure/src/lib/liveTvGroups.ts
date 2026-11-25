// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { LiveTvPick } from '@/contexts/config';

export const MAX_PICKED = 1000;

type Extra = { name?: unknown; isRequired?: unknown; options?: unknown };

/** The channel groups of a manifest's live catalogs, as the server tells one. */
export function channelGroups(manifest: any): string[] {
  const guideProvider = manifest?.behaviorHints?.epgProvider === true;
  const groups = new Set<string>();
  for (const catalog of Array.isArray(manifest?.catalogs) ? manifest.catalogs : []) {
    const extras: Extra[] = (Array.isArray(catalog?.extra) ? catalog.extra : []).filter((e: any) => typeof e?.name === 'string');
    if (extras.some((e) => e.isRequired) || (Array.isArray(catalog?.extraRequired) && catalog.extraRequired.length)) continue;
    if (catalog?.type !== 'tv' && !(guideProvider && extras.some((e) => e.name === 'date'))) continue;
    const options = extras.find((e) => e.name === 'genre')?.options;
    for (const option of Array.isArray(options) ? options : []) if (typeof option === 'string' && option) groups.add(option);
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
