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
const MAX_PLACEMENTS = 20000;
const MAX_LIST = 50000;
const MAX_FAILURES = 5000;
const SLOW_MS = 4000;
const MAX_HELD_CHANNELS = 400000;
const IDLE_MS = 2 * 60 * 60 * 1000;
const SWEEP_MS = 10 * 60 * 1000;

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
  usedAt: number;
  failedAt?: number;
  refreshFailedAt?: number;
}

interface Assembly {
  lineups: Lineup[];
  consumed: number;
  entries: Placement[];
  byKey: Map<string, Placement>;
  finished: boolean;
  blocked: boolean;
}

interface State {
  id: number;
  now: () => number;
  lineups: LRUCache<string, Lineup>;
  placements: LRUCache<string, Placement | typeof GONE>;
  assemblies: LRUCache<string, Assembly>;
  /** Channel reads that failed lately, and addons whose channel reads time out. */
  failures: LRUCache<string, true>;
}

const states = new WeakMap<object, State>();
let serial = 0;

export function stateFor(addon: LineupAddon): State {
  let state = states.get(addon);
  if (!state) {
    const clock = clockOptions(addon.now);
    const assemblies = new LRUCache<string, Assembly>({ max: 500 });
    const created: State = {
      id: ++serial,
      now: addon.now,
      lineups: new LRUCache<string, Lineup>({
        max: MAX_LINEUPS,
        maxSize: MAX_HELD_CHANNELS,
        sizeCalculation: (lineup) => lineup.channels.length + 1,
        ttl: LINEUP_TTL_MS,
        allowStale: true,
        noDeleteOnStaleGet: true,
        dispose: (lineup, _key, reason) => {
          if (reason === 'evict' || reason === 'set') dropAssemblies(assemblies, lineup);
        },
        ...clock,
      }),
      placements: new LRUCache<string, Placement | typeof GONE>({ max: MAX_PLACEMENTS, ttl: PLACEMENT_TTL_MS, ...clock }),
      assemblies,
      failures: new LRUCache<string, true>({ max: MAX_FAILURES, ttl: FAILURE_MS, ...clock }),
    };
    states.set(addon, created);
    setInterval(() => purge(created), SWEEP_MS).unref();
    state = created;
  }
  return state;
}

function dropAssemblies(assemblies: State['assemblies'], lineup: Lineup): void {
  for (const [key, assembly] of [...assemblies.entries()]) if (assembly.lineups.includes(lineup)) assemblies.delete(key);
}

function purge(state: State): void {
  for (const key of [...state.lineups.keys()]) {
    const lineup = state.lineups.peek(key);
    if (!lineup || state.now() - lineup.usedAt <= IDLE_MS) continue;
    state.lineups.delete(key);
    dropAssemblies(state.assemblies, lineup);
  }
}

export function purgeLineups(addon: LineupAddon): void {
  purge(stateFor(addon));
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

function emptyLineup(state: State): Lineup {
  return { channels: [], skips: [], keys: new Set(), next: 0, pages: 0, done: false, usedAt: state.now() };
}

function heldLineup(state: State, key: string): Lineup | undefined {
  const lineup = state.lineups.get(key);
  if (lineup) lineup.usedAt = state.now();
  return lineup;
}

// Setting the same value again does not measure it again, so a grown lineup is put back under its remaining lifetime.
function remeasure(state: State, key: string, lineup: Lineup): void {
  if (state.lineups.peek(key) !== lineup) return;
  const ttl = Math.max(1, state.lineups.getRemainingTTL(key));
  state.lineups.delete(key);
  state.lineups.set(key, lineup, { ttl });
}

async function readInto(addon: LineupAddon, base: string, catalog: LiveCatalog, lineup: Lineup): Promise<boolean> {
  const page = await readPage(addon, base, catalog, { skip: lineup.next });
  if (!page) return false;
  lineup.pages++;
  let added = 0;
  for (const entry of page) {
    const meta = channelMetaOf(entry, catalog);
    if (lineup.channels.length >= MAX_LIST) break;
    if (!meta || lineup.keys.has(channelKey(meta))) continue;
    lineup.keys.add(channelKey(meta));
    lineup.channels.push(meta);
    lineup.skips.push(lineup.next);
    added++;
  }
  lineup.next += page.length;
  if (!catalog.skip || added === 0 || lineup.pages >= MAX_PAGES || lineup.channels.length >= MAX_LIST) lineup.done = true;
  return true;
}

function refresh(state: State, addon: LineupAddon, base: string, catalog: LiveCatalog, old: Lineup): void {
  if (old.refreshFailedAt !== undefined && state.now() - old.refreshFailedAt < FAILURE_MS) return;
  const key = lineupKey(base, catalog);
  void shareInFlight(`livetv:${state.id}|${key}|refresh`, async () => {
    const fresh = emptyLineup(state);
    const limit = old.done ? MAX_PAGES : Math.max(1, old.pages);
    while (!fresh.done && fresh.pages < limit) {
      if (!(await readInto(addon, base, catalog, fresh)) || (!fresh.channels.length && old.channels.length)) {
        old.refreshFailedAt = state.now();
        return;
      }
    }
    fresh.usedAt = old.usedAt;
    if (state.lineups.peek(key) === old) state.lineups.set(key, fresh);
  });
}

function assemble(state: State, addon: LineupAddon, base: string, catalogs: LiveCatalog[]): Assembly {
  const memoKey = `${hash(base)}|${catalogs.map(channelKey).join(',')}`;
  let memo = state.assemblies.get(memoKey);
  if (memo && memo.lineups.some((lineup, n) => heldLineup(state, lineupKey(base, catalogs[n])) !== lineup)) memo = undefined;
  if (!memo) {
    memo = { lineups: [], consumed: 0, entries: [], byKey: new Map(), finished: false, blocked: false };
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
        if (memo.entries.length >= MAX_LIST) {
          memo.finished = true;
          memo.blocked = false;
          return memo;
        }
        const meta = lineup.channels[memo.consumed];
        const key = channelKey(meta);
        if (memo.byKey.has(key)) continue;
        const placement: Placement = { meta, catalog, skip: lineup.skips[memo.consumed], number: meta.channelNumber ?? String(memo.entries.length + 1) };
        memo.entries.push(placement);
        memo.byKey.set(key, placement);
      }
      if (!lineup.done) {
        memo.finished = false;
        memo.blocked = lineup.failedAt !== undefined && state.now() - lineup.failedAt < FAILURE_MS;
        return memo;
      }
    }
    const next = memo.lineups.length;
    if (next >= catalogs.length || memo.entries.length >= MAX_LIST) {
      memo.finished = true;
      memo.blocked = false;
      return memo;
    }
    const lineup = heldLineup(state, lineupKey(base, catalogs[next]));
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
    let lineup = heldLineup(state, key);
    if (!lineup) {
      lineup = emptyLineup(state);
      state.lineups.set(key, lineup);
    }
    if (lineup.done) continue;
    if (lineup.failedAt !== undefined && state.now() - lineup.failedAt < FAILURE_MS) return 'blocked';
    if (!(await readInto(addon, base, catalog, lineup))) {
      lineup.failedAt = state.now();
      return 'failed';
    }
    lineup.failedAt = undefined;
    remeasure(state, key, lineup);
    return 'read';
  }
  return 'done';
}

async function walk(addon: LineupAddon, base: string, catalogs: LiveCatalog[], satisfied: (list: Assembly) => boolean): Promise<Assembly> {
  const state = stateFor(addon);
  // A lineup evicted while the walk goes on would otherwise be read again without end.
  for (let reads = 0; ; reads++) {
    const list = assemble(state, addon, base, catalogs);
    if (satisfied(list) || list.finished || list.blocked || reads > MAX_PAGES * catalogs.length) return list;
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

export async function listPlacements(addon: LineupAddon, base: string, catalogs: LiveCatalog[], limit: number): Promise<Placement[]> {
  const list = await walk(addon, base, catalogs, (l) => l.entries.length >= limit);
  return list.entries.slice(0, limit);
}

/** The first channels, in the full list's order, whose catalog has a guide. */
export async function guideChannels(addon: LineupAddon, base: string, catalogs: LiveCatalog[], limit: number): Promise<ListedChannel[]> {
  const last = catalogs.map((c) => c.guide).lastIndexOf(true);
  if (last < 0) return [];
  const guided = (list: Assembly) => list.entries.filter((p) => p.catalog?.guide);
  const list = await walk(addon, base, catalogs, (l) => l.lineups[last]?.done === true || guided(l).length >= limit);
  return guided(list).slice(0, limit).map(({ meta, number }) => ({ meta, number }));
}

export async function placementFor(
  addon: LineupAddon,
  base: string,
  catalogs: LiveCatalog[],
  { type, id }: { type: string; id: string }
): Promise<Placement | typeof GONE | null> {
  const state = stateFor(addon);
  const key = placementKey(base, type, id);
  const listed = (await walk(addon, base, catalogs, (l) => l.byKey.has(`${type}|${id}`))).byKey.get(`${type}|${id}`);
  if (listed) return listed;
  const held = state.placements.get(key);
  if (held) return held;

  const slowKey = hash(base);
  if (state.failures.has(key) || state.failures.has(slowKey)) return null;
  const path = `/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  const began = state.now();
  const body = await shareInFlight(`livetv:${state.id}|${hash(base)}|${path}`, () => addon.fetchJson(base, path));
  if (!body) {
    state.failures.set(key, true);
    if (state.now() - began >= SLOW_MS) state.failures.set(slowKey, true);
    return null;
  }
  const meta = body.meta ? channelMetaOf({ ...body.meta, id, type }, { type }) : null;
  if (!meta) {
    state.placements.set(key, GONE);
    return GONE;
  }
  const placement: Placement = { meta };
  state.placements.set(key, placement);
  return placement;
}
