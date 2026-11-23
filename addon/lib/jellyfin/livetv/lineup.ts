// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { LRUCache } from 'lru-cache';
import { clockOptions, hash, shareInFlight, type AddonDeps } from '../addonReader';
import { readPage, type LiveCatalog } from './catalogs';

const LINEUP_TTL_MS = 60 * 60 * 1000;
const PLACEMENT_TTL_MS = 60 * 60 * 1000;
const FAILURE_MS = 30 * 1000;
const MAX_PAGES = 40;
const MAX_LINEUPS = 2000;
const MAX_PLACEMENTS = 200000;

export interface ChannelMeta {
  id: string;
  type: string;
  name: string;
  logo?: string;
  poster?: string;
  channelNumber?: string;
  catchupDays?: number;
}

export interface Placement {
  meta: ChannelMeta;
  catalog?: LiveCatalog;
  skip?: number;
  number?: string;
}

export interface ListedChannel {
  meta: ChannelMeta;
  number?: string;
}

export const GONE: unique symbol = Symbol('GONE');

type LineupAddon = Pick<AddonDeps, 'fetchJson' | 'now'>;

interface Lineup {
  channels: ChannelMeta[];
  skips: number[];
  keys: Set<string>;
  next: number;
  pages: number;
  done: boolean;
  failedAt?: number;
  refreshFailedAt?: number;
}

interface Assembly {
  lineups: Lineup[];
  consumed: number;
  entries: Placement[];
  seen: Set<string>;
  finished: boolean;
  blocked: boolean;
}

interface State {
  id: number;
  now: () => number;
  lineups: LRUCache<string, Lineup>;
  placements: LRUCache<string, Placement | typeof GONE>;
  assemblies: LRUCache<string, Assembly>;
}

const states = new WeakMap<object, State>();
let serial = 0;

export function stateFor(addon: LineupAddon): State {
  let state = states.get(addon);
  if (!state) {
    const clock = clockOptions(addon.now);
    state = {
      id: ++serial,
      now: addon.now,
      lineups: new LRUCache<string, Lineup>({ max: MAX_LINEUPS, ttl: LINEUP_TTL_MS, ...clock }),
      placements: new LRUCache<string, Placement | typeof GONE>({ max: MAX_PLACEMENTS, ttl: PLACEMENT_TTL_MS, ...clock }),
      assemblies: new LRUCache<string, Assembly>({ max: 500 }),
    };
    states.set(addon, state);
  }
  return state;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export function channelMetaOf(entry: any, catalog: Pick<LiveCatalog, 'type'>): ChannelMeta | null {
  const id = text(entry?.id);
  if (!id) return null;
  const meta: ChannelMeta = { id, type: text(entry.type) ?? catalog.type, name: text(entry.name) ?? id };
  const logo = text(entry.logo);
  const poster = text(entry.poster);
  if (logo) meta.logo = logo;
  if (poster) meta.poster = poster;
  if (entry.channelNumber !== undefined && entry.channelNumber !== null && String(entry.channelNumber).trim() !== '') {
    meta.channelNumber = String(entry.channelNumber).trim();
  }
  const catchup = Number(entry.behaviorHints?.catchupDays);
  if (Number.isFinite(catchup) && catchup > 0) meta.catchupDays = catchup;
  return meta;
}

const lineupKey = (base: string, catalog: LiveCatalog): string => `${hash(base)}|${catalog.type}|${catalog.id}`;
const placementKey = (base: string, type: string, id: string): string => `${hash(base)}|${type}|${id}`;
const channelKey = (meta: Pick<ChannelMeta, 'type' | 'id'>): string => `${meta.type}|${meta.id}`;

function emptyLineup(): Lineup {
  return { channels: [], skips: [], keys: new Set(), next: 0, pages: 0, done: false };
}

function peekLineup(state: State, key: string): Lineup | undefined {
  return state.lineups.peek(key, { allowStale: true });
}

async function readInto(addon: LineupAddon, base: string, catalog: LiveCatalog, lineup: Lineup): Promise<boolean> {
  const page = await readPage(addon, base, catalog, { skip: lineup.next });
  if (!page) return false;
  lineup.pages++;
  let added = 0;
  for (const entry of page) {
    const meta = channelMetaOf(entry, catalog);
    if (!meta || lineup.keys.has(channelKey(meta))) continue;
    lineup.keys.add(channelKey(meta));
    lineup.channels.push(meta);
    lineup.skips.push(lineup.next);
    added++;
  }
  lineup.next += page.length;
  if (!catalog.skip || added === 0 || lineup.pages >= MAX_PAGES) lineup.done = true;
  return true;
}

function refresh(state: State, addon: LineupAddon, base: string, catalog: LiveCatalog, old: Lineup): void {
  if (old.refreshFailedAt !== undefined && state.now() - old.refreshFailedAt < FAILURE_MS) return;
  const key = lineupKey(base, catalog);
  void shareInFlight(`livetv:${state.id}|${key}|refresh`, async () => {
    const fresh = emptyLineup();
    const limit = old.done ? MAX_PAGES : Math.max(1, old.pages);
    while (!fresh.done && fresh.pages < limit) {
      if (!(await readInto(addon, base, catalog, fresh))) {
        old.refreshFailedAt = state.now();
        return;
      }
    }
    if (peekLineup(state, key) === old) state.lineups.set(key, fresh);
  });
}

function assemble(state: State, addon: LineupAddon, base: string, catalogs: LiveCatalog[]): Assembly {
  const memoKey = `${hash(base)}|${catalogs.map(channelKey).join(',')}`;
  let memo = state.assemblies.get(memoKey);
  if (memo && memo.lineups.some((lineup, n) => peekLineup(state, lineupKey(base, catalogs[n])) !== lineup)) memo = undefined;
  if (!memo) {
    memo = { lineups: [], consumed: 0, entries: [], seen: new Set(), finished: false, blocked: false };
    state.assemblies.set(memoKey, memo);
  }

  memo.lineups.forEach((lineup, n) => {
    if (state.lineups.getRemainingTTL(lineupKey(base, catalogs[n])) <= 0) refresh(state, addon, base, catalogs[n], lineup);
  });

  for (;;) {
    const at = memo.lineups.length - 1;
    if (at >= 0) {
      const lineup = memo.lineups[at];
      const catalog = catalogs[at];
      for (; memo.consumed < lineup.channels.length; memo.consumed++) {
        const meta = lineup.channels[memo.consumed];
        const key = channelKey(meta);
        if (memo.seen.has(key)) continue;
        memo.seen.add(key);
        const placement: Placement = { meta, catalog, skip: lineup.skips[memo.consumed], number: meta.channelNumber ?? String(memo.entries.length + 1) };
        memo.entries.push(placement);
        state.placements.set(placementKey(base, meta.type, meta.id), placement);
      }
      if (!lineup.done) {
        memo.finished = false;
        memo.blocked = lineup.failedAt !== undefined && state.now() - lineup.failedAt < FAILURE_MS;
        return memo;
      }
    }
    const next = memo.lineups.length;
    if (next >= catalogs.length) {
      memo.finished = true;
      memo.blocked = false;
      return memo;
    }
    const lineup = peekLineup(state, lineupKey(base, catalogs[next]));
    if (!lineup) {
      memo.finished = false;
      memo.blocked = false;
      return memo;
    }
    memo.lineups.push(lineup);
    memo.consumed = 0;
  }
}

type Outcome = 'read' | 'failed' | 'blocked' | 'done';

async function readNextPage(state: State, addon: LineupAddon, base: string, catalogs: LiveCatalog[]): Promise<Outcome> {
  for (const catalog of catalogs) {
    const key = lineupKey(base, catalog);
    let lineup = peekLineup(state, key);
    if (!lineup) {
      lineup = emptyLineup();
      state.lineups.set(key, lineup);
    }
    if (lineup.done) continue;
    if (lineup.failedAt !== undefined && state.now() - lineup.failedAt < FAILURE_MS) return 'blocked';
    if (!(await readInto(addon, base, catalog, lineup))) {
      lineup.failedAt = state.now();
      return 'failed';
    }
    lineup.failedAt = undefined;
    return 'read';
  }
  return 'done';
}

async function walk(addon: LineupAddon, base: string, catalogs: LiveCatalog[], satisfied: (list: Assembly) => boolean): Promise<Assembly> {
  const state = stateFor(addon);
  for (;;) {
    const list = assemble(state, addon, base, catalogs);
    if (satisfied(list) || list.finished || list.blocked) return list;
    const outcome = await shareInFlight(`livetv:${state.id}|${hash(base)}|walk`, () => readNextPage(state, addon, base, catalogs));
    if (outcome !== 'read') return assemble(state, addon, base, catalogs);
  }
}

export async function listChannels(
  addon: LineupAddon,
  base: string,
  catalogs: LiveCatalog[],
  { startIndex, limit }: { startIndex: number; limit: number }
): Promise<{ channels: ListedChannel[]; total: number }> {
  const end = startIndex + limit;
  const list = await walk(addon, base, catalogs, (l) => l.entries.length >= end);
  const channels = list.entries.slice(startIndex, end).map(({ meta, number }) => ({ meta, number }));
  return { channels, total: list.finished ? list.entries.length : list.entries.length + 1 };
}

export async function placementFor(
  addon: LineupAddon,
  base: string,
  catalogs: LiveCatalog[],
  { type, id }: { type: string; id: string }
): Promise<Placement | typeof GONE | null> {
  const state = stateFor(addon);
  const key = placementKey(base, type, id);
  const held = state.placements.get(key);
  if (held) return held;

  await walk(addon, base, catalogs, () => state.placements.has(key));
  const placed = state.placements.get(key);
  if (placed) return placed;

  const path = `/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  const body = await shareInFlight(`livetv:${state.id}|${hash(base)}|${path}`, () => addon.fetchJson(base, path));
  if (!body) return null;
  const meta = body.meta ? channelMetaOf({ ...body.meta, id, type }, { type }) : null;
  if (!meta) {
    state.placements.set(key, GONE);
    return GONE;
  }
  const placement: Placement = { meta };
  state.placements.set(key, placement);
  return placement;
}
