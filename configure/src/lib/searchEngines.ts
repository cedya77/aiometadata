// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { AppConfig } from '../contexts/config';

export type SearchSlotId =
  | 'movie'
  | 'series'
  | 'anime_series'
  | 'anime_movie'
  | 'people_search_movie'
  | 'people_search_series'
  | 'tvdb.collections.search'
  | 'gemini.search';

type ProviderKey =
  | 'movie'
  | 'series'
  | 'anime_series'
  | 'anime_movie'
  | 'people_search_movie'
  | 'people_search_series';

export interface SearchSlot {
  id: SearchSlotId;
  defaultName: string;
  defaultType: string;
  /** Which key getManifest.ts reads for this slot's enabled flag. */
  enabledKeyKind: 'provider' | 'slot';
  /** Whether the slot offers a provider choice at all. */
  selectable: boolean;
  providerKey?: ProviderKey;
  defaultProvider?: string;
}

export interface SearchCaps {
  hasTvdbKey: boolean;
  hasAnyAiKey: boolean;
}

export interface SlotView {
  slot: SearchSlot;
  /** Resolved provider id, or the slot id for non-selectable slots. */
  provider: string;
  enabled: boolean;
  /** The engineEnabled key to write for this slot. */
  enabledKey: string;
}

/** Names and types match getDefaultSearchName / getDefaultSearchType in the old page. */
export const SEARCH_SLOTS: SearchSlot[] = [
  { id: 'movie', defaultName: 'Movies Search', defaultType: 'movie', enabledKeyKind: 'provider', selectable: true, providerKey: 'movie' },
  { id: 'series', defaultName: 'Series Search', defaultType: 'series', enabledKeyKind: 'provider', selectable: true, providerKey: 'series' },
  { id: 'tvdb.collections.search', defaultName: 'TVDB Collections', defaultType: 'collection', enabledKeyKind: 'slot', selectable: false },
  { id: 'gemini.search', defaultName: 'AI Search', defaultType: 'other', enabledKeyKind: 'slot', selectable: false },
  { id: 'anime_series', defaultName: 'Anime Series Search', defaultType: 'anime.series', enabledKeyKind: 'provider', selectable: true, providerKey: 'anime_series' },
  { id: 'anime_movie', defaultName: 'Anime Movies Search', defaultType: 'anime.movie', enabledKeyKind: 'provider', selectable: true, providerKey: 'anime_movie' },
  { id: 'people_search_movie', defaultName: 'People Search (Movies)', defaultType: 'movie', enabledKeyKind: 'slot', selectable: true, providerKey: 'people_search_movie', defaultProvider: 'tmdb.people.search' },
  { id: 'people_search_series', defaultName: 'People Search (Series)', defaultType: 'series', enabledKeyKind: 'slot', selectable: true, providerKey: 'people_search_series', defaultProvider: 'tmdb.people.search' },
];

export const DEFAULT_SEARCH_ORDER: SearchSlotId[] = [
  'movie',
  'series',
  'tvdb.collections.search',
  'gemini.search',
  'anime_series',
  'anime_movie',
  'people_search_movie',
  'people_search_series',
];

type ConfigLike = Pick<AppConfig, 'search'>;

export function normalizeOrder(searchOrder: string[] | undefined): string[] {
  const stored = Array.isArray(searchOrder) ? searchOrder : [];
  return Array.from(new Set([...stored, ...DEFAULT_SEARCH_ORDER]));
}

export function slotProvider(slot: SearchSlot, config: ConfigLike): string {
  if (!slot.selectable || !slot.providerKey) return slot.id;
  const providers = config.search?.providers as Record<string, string> | undefined;
  return providers?.[slot.providerKey] || slot.defaultProvider || slot.id;
}

export function engineEnabledKey(slot: SearchSlot, config: ConfigLike): string {
  return slot.enabledKeyKind === 'provider' ? slotProvider(slot, config) : slot.id;
}

export function isSlotAvailable(slot: SearchSlot, config: ConfigLike, caps: SearchCaps): boolean {
  if (slot.id === 'tvdb.collections.search') return caps.hasTvdbKey;
  if (slot.id === 'gemini.search') return !!config.search?.ai_enabled && caps.hasAnyAiKey;
  return true;
}

/** Enabled unless explicitly false — matching getManifest.ts's `!== false` throughout. */
export function isSlotEnabled(slot: SearchSlot, config: ConfigLike): boolean {
  return config.search?.engineEnabled?.[engineEnabledKey(slot, config)] !== false;
}

export function listSlots(config: ConfigLike, caps: SearchCaps): SlotView[] {
  const order = normalizeOrder(config.search?.searchOrder);
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? Number.POSITIVE_INFINITY : i;
  };
  return SEARCH_SLOTS
    .filter((slot) => isSlotAvailable(slot, config, caps))
    .map((slot) => ({
      slot,
      provider: slotProvider(slot, config),
      enabled: isSlotEnabled(slot, config),
      enabledKey: engineEnabledKey(slot, config),
    }))
    .sort((a, b) => (Number(b.enabled) - Number(a.enabled)) || (rank(a.slot.id) - rank(b.slot.id)));
}

/** Reorders the enabled slots and appends every id that is not currently enabled. */
export function applyReorder(
  config: ConfigLike,
  caps: SearchCaps,
  activeId: string,
  overId: string
): string[] {
  const order = normalizeOrder(config.search?.searchOrder);
  const enabled = listSlots(config, caps).filter((v) => v.enabled).map((v) => v.slot.id);
  const from = enabled.indexOf(activeId as SearchSlotId);
  const to = enabled.indexOf(overId as SearchSlotId);
  if (from === -1 || to === -1 || from === to) return order;
  const next = enabled.slice();
  next.splice(to, 0, next.splice(from, 1)[0]);
  return [...next, ...order.filter((id) => !next.includes(id as SearchSlotId))];
}
