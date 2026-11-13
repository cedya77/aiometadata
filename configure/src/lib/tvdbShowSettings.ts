// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
export type SeasonNumbering = 'years' | 'sequential';

export const SEASON_NUMBERING_LABELS: Record<SeasonNumbering, string> = {
  years: 'Years (S2026)',
  sequential: '1, 2, 3…',
};

export function isSeasonNumbering(value: unknown): value is SeasonNumbering {
  return value === 'years' || value === 'sequential';
}

export function withShowValue<V extends string>(
  map: Record<string, V>,
  showKey: string,
  value: V | null,
): Record<string, V> {
  const next: Record<string, V> = {};
  for (const [key, current] of Object.entries(map)) {
    if (!key.startsWith('tvdb:')) continue;
    if (key !== showKey) next[key] = current;
    else if (value) next[key] = value;
  }
  if (value && !(showKey in next)) next[showKey] = value;
  return next;
}

export function showSettingKeys(
  orders: Record<string, string>,
  numbering: Record<string, string>,
  isOrder: (value: string) => boolean,
): string[] {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(orders)) {
    if (key.startsWith('tvdb:') && isOrder(value)) keys.add(key);
  }
  for (const [key, value] of Object.entries(numbering)) {
    if (key.startsWith('tvdb:') && isSeasonNumbering(value)) keys.add(key);
  }
  return [...keys];
}

// A listed show starts from its own settings, so adding one of them keeps the other.
export function pickerStart(
  series: { orders?: { type: string }[]; yearSeasons?: boolean },
  current: { order: string | null; seasons: SeasonNumbering | null } | null,
  globalYears: boolean,
): { order: string | null; seasons: SeasonNumbering | null } {
  if (current) return { order: current.order, seasons: series.yearSeasons ? current.seasons : null };
  if (series.yearSeasons) return { order: null, seasons: globalYears ? 'sequential' : 'years' };
  const orders = series.orders ?? [];
  return { order: orders.find((o) => o.type !== 'official')?.type ?? orders[0]?.type ?? null, seasons: null };
}

export interface ImportEntry {
  tvdbId: string;
  order: string | null;
  seasons: SeasonNumbering | null;
}

export function readImportEntry(entry: any): ImportEntry | { skip: string } {
  const tvdbId = String(entry?.tvdbId ?? '').trim().replace(/^tvdb:/i, '');
  const order = String(entry?.order ?? '').trim() || null;
  const seasons = String(entry?.seasons ?? '').trim() || null;
  if (!/^\d+$/.test(tvdbId) || (!order && !seasons)) {
    return { skip: `${entry?.tvdbId ?? '?'} (needs a tvdbId and an order or seasons)` };
  }
  if (seasons && !isSeasonNumbering(seasons)) {
    return { skip: `${tvdbId} (seasons must be years or sequential)` };
  }
  return { tvdbId, order, seasons: seasons as SeasonNumbering | null };
}

// A field an entry leaves out keeps its current value, so older files only carrying
// an order do not clear a show's numbering.
export function mergeImport(
  orders: Record<string, string>,
  numbering: Record<string, SeasonNumbering>,
  entries: ImportEntry[],
): { orders: Record<string, string>; numbering: Record<string, SeasonNumbering> } {
  let nextOrders = orders;
  let nextNumbering = numbering;
  for (const { tvdbId, order, seasons } of entries) {
    const showKey = `tvdb:${tvdbId}`;
    if (order) nextOrders = withShowValue(nextOrders, showKey, order);
    if (seasons) nextNumbering = withShowValue(nextNumbering, showKey, seasons);
  }
  return { orders: nextOrders, numbering: nextNumbering };
}
