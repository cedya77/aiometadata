// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { LRUCache } from 'lru-cache';
import { chunksOf, clockOptions, hash, inBatches, shareInFlight, type AddonDeps } from '../addonReader';
import { catalogKey, endsList, IDS_PER_READ, isAddonError, narrowedTo, pagePath, readPage, wholeCatalogs, type LiveCatalog } from './catalogs';

const LINEUP_TTL_MS = 60 * 60 * 1000;
const PLACEMENT_TTL_MS = 60 * 60 * 1000;
const FAILURE_MS = 30 * 1000;
const EMPTY_TTL_MS = 60 * 1000;
const MAX_PAGES = 100;
const MAX_LINEUPS = 2000;
const MAX_PLACEMENTS = 20000;
const MAX_LIST = 50000;
const MAX_FAILURES = 5000;
const SLOW_MS = 4000;
const MAX_HELD_CHANNELS = 400000;
const IDLE_MS = 2 * 60 * 60 * 1000;
const SWEEP_MS = 10 * 60 * 1000;
const PARALLEL_META_READS = 8;
const PARALLEL_ID_READS = 4;
const MAX_GROUPS_KEPT = 50;

export interface ChannelMeta {
  id: string;
  type: string;
  name: string;
  logo?: string;
  poster?: string;
  channelNumber?: string;
  catchupDays?: number;
  /** The groups the addon says it is in. */
  groups?: string[];
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
  /** Channels the reads by id answered without. */
  unknown: LRUCache<string, true>;
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
      unknown: new LRUCache<string, true>({ max: MAX_FAILURES, ttl: EMPTY_TTL_MS, ...clock }),
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

// The same few names come with every channel.
const groupNames = new LRUCache<string, string>({ max: 20000 });

function groupName(name: string): string {
  const held = groupNames.get(name);
  if (held !== undefined) return held;
  groupNames.set(name, name);
  return name;
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
  const groups = (Array.isArray(entry.genres) ? entry.genres : []).filter((g: unknown): g is string => typeof g === 'string' && g.length > 0);
  if (groups.length) meta.groups = groups.slice(0, MAX_GROUPS_KEPT).map(groupName);
  return meta;
}

const lineupKey = (base: string, catalog: LiveCatalog): string => `${hash(base)}|${catalogKey(catalog)}`;
const assemblyKey = (base: string, catalogs: LiveCatalog[]): string => `${hash(base)}|${catalogs.map(catalogKey).join(',')}`;
const placementKey = (base: string, type: string, id: string): string => `${hash(base)}|${type}|${id}`;
const channelKey = (meta: Pick<ChannelMeta, 'type' | 'id'>): string => `${meta.type}|${meta.id}`;

function emptyLineup(state: State): Lineup {
  return { channels: [], skips: [], keys: new Set(), next: 0, pages: 0, done: false, usedAt: state.now() };
}

const isEmpty = (lineup: Lineup): boolean => lineup.done && !lineup.channels.length;

function heldLineup(state: State, key: string): Lineup | undefined {
  const lineup = state.lineups.get(key);
  if (!lineup) return undefined;
  if (isEmpty(lineup) && state.lineups.getRemainingTTL(key) <= 0) {
    state.lineups.delete(key);
    return undefined;
  }
  lineup.usedAt = state.now();
  return lineup;
}

// Setting the same value again does not measure it again, so a grown lineup is put back under its remaining lifetime.
function remeasure(state: State, key: string, lineup: Lineup): void {
  if (state.lineups.peek(key) !== lineup) return;
  const ttl = isEmpty(lineup) ? EMPTY_TTL_MS : Math.max(1, state.lineups.getRemainingTTL(key));
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
  if (!catalog.skip || added === 0 || endsList(catalog, page) || lineup.pages >= MAX_PAGES || lineup.channels.length >= MAX_LIST) lineup.done = true;
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
  const memoKey = assemblyKey(base, catalogs);
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
        const placement: Placement = { meta, catalog, skip: lineup.skips[memo.consumed], number: meta.channelNumber ?? (catalog.genre === undefined ? String(memo.entries.length + 1) : undefined) };
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
    const outcome = await shareInFlight(`livetv:${state.id}|${assemblyKey(base, catalogs)}|walk`, () => readNextPage(state, addon, base, catalogs));
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
  const page = list.entries.slice(startIndex, end);
  for (const entry of page) rememberListed(addon, base, entry, entry.number);
  return { channels: page.map(({ meta, number }) => ({ meta, number })), total: list.finished ? list.entries.length : list.entries.length + 1 };
}

/** Keeps where a group's channel is, for what opens it without the group. */
function rememberListed(addon: LineupAddon, base: string, entry: Placement, number: string | undefined): void {
  if (entry.catalog?.genre === undefined) return;
  const [catalog] = wholeCatalogs([entry.catalog]);
  if (catalog.ids) rememberFound(addon, base, entry.meta, catalog);
  else stateFor(addon).placements.set(placementKey(base, entry.meta.type, entry.meta.id), { ...entry, number });
}

export function groupCatalogs(catalogs: LiveCatalog[], genre: string): LiveCatalog[] {
  return catalogs.filter((c) => c.groups.includes(genre)).map((c) => ({ ...c, genre }));
}

/** A group's channels, which keep the numbers of the whole list. */
export async function listGroup(
  addon: LineupAddon,
  base: string,
  catalogs: LiveCatalog[],
  genre: string,
  { startIndex, limit }: { startIndex: number; limit: number }
): Promise<{ channels: ListedChannel[]; total: number }> {
  const end = startIndex + limit;
  const list = await walk(addon, base, groupCatalogs(catalogs, genre), (l) => l.entries.length >= end);
  const state = stateFor(addon);
  const whole = assemble(state, addon, base, catalogs).byKey;
  const channels = list.entries.slice(startIndex, end).map((entry) => {
    const listed = whole.get(channelKey(entry.meta));
    const number = entry.number ?? listed?.number;
    if (!listed) rememberListed(addon, base, entry, number);
    return { meta: entry.meta, number };
  });
  return { channels, total: list.finished ? list.entries.length : list.entries.length + 1 };
}

/** The first channels, read as far as `enough` asks when it is given. */
export async function listPlacements(
  addon: LineupAddon,
  base: string,
  catalogs: LiveCatalog[],
  limit: number,
  enough: (entries: Placement[]) => boolean = () => false
): Promise<Placement[]> {
  const list = await walk(addon, base, catalogs, (l) => l.entries.length >= limit || enough(l.entries));
  return list.entries.slice(0, limit);
}

/** Whether a channel is among those listed so far. */
export function isListed(addon: LineupAddon, base: string, catalogs: LiveCatalog[], meta: Pick<ChannelMeta, 'type' | 'id'>): boolean {
  return assemble(stateFor(addon), addon, base, catalogs).byKey.has(channelKey(meta));
}

/** Keeps where a channel was found, for one the list does not reach. */
export function rememberFound(addon: LineupAddon, base: string, meta: ChannelMeta, catalog: LiveCatalog): void {
  if (!catalog.ids) return;
  stateFor(addon).placements.set(placementKey(base, meta.type, meta.id), { meta, catalog, number: meta.channelNumber });
}

/** The first channels, in the full list's order, whose catalog has a guide. */
export async function guideChannels(addon: LineupAddon, base: string, catalogs: LiveCatalog[], limit: number): Promise<ListedChannel[]> {
  const last = catalogs.map((c) => c.guide).lastIndexOf(true);
  if (last < 0) return [];
  const guided = (list: Assembly) => list.entries.filter((p) => p.catalog?.guide);
  const list = await walk(addon, base, catalogs, (l) => l.lineups[last]?.done === true || guided(l).length >= limit);
  return guided(list).slice(0, limit).map(({ meta, number }) => ({ meta, number }));
}

type ChannelRef = Pick<ChannelMeta, 'type' | 'id'>;

/** Whether narrowed catalogs hold a channel: listed from one of their groups, or in one by its own account. */
function admitter(state: State, base: string, catalogs: LiveCatalog[]): (meta: ChannelMeta, from?: LiveCatalog) => boolean {
  const names = narrowedTo(catalogs);
  if (!names) return () => true;
  const lineups = catalogs.map((c) => state.lineups.peek(lineupKey(base, c), { allowStale: true }));
  return (meta, from) =>
    (meta.groups ?? []).some((g) => names.has(g)) ||
    (from?.genre !== undefined && names.has(from.genre)) ||
    lineups.some((l) => l?.keys.has(channelKey(meta)));
}

/** Those of the channels found that these catalogs hold. */
export function admitted(addon: LineupAddon, base: string, catalogs: LiveCatalog[], metas: ChannelMeta[]): ChannelMeta[] {
  const admits = admitter(stateFor(addon), base, catalogs);
  return metas.filter((meta) => admits(meta));
}

async function findByIds(state: State, addon: LineupAddon, base: string, catalogs: LiveCatalog[], channels: ChannelRef[]): Promise<void> {
  const keyOf = (c: ChannelRef) => placementKey(base, c.type, c.id);
  const failed = new Set<string>();
  let left = channels.filter((c) => !state.unknown.has(keyOf(c)) && !state.failures.has(`ids|${keyOf(c)}`));
  for (const catalog of catalogs) {
    if (!catalog.ids || !left.length) continue;
    const found = new Set<string>();
    const read = async (chunk: ChannelRef[]) => {
      const ids = [...new Set(chunk.map((c) => c.id))].sort();
      const entries = await shareInFlight(`livetv:${state.id}|${hash(base)}|${pagePath(catalog, { ids })}`, () => readPage(addon, base, catalog, { ids }));
      if (!entries) for (const c of chunk) failed.add(keyOf(c));
      const wanted = new Set(chunk.map(keyOf));
      for (const entry of entries ?? []) {
        const meta = channelMetaOf(entry, catalog);
        if (!meta || !wanted.has(keyOf(meta))) continue;
        rememberFound(addon, base, meta, catalog);
        found.add(keyOf(meta));
      }
    };
    await inBatches(chunksOf(left, IDS_PER_READ).map((chunk) => () => read(chunk)), PARALLEL_ID_READS);
    left = left.filter((c) => !found.has(keyOf(c)));
  }
  for (const c of left) {
    if (failed.has(keyOf(c))) state.failures.set(`ids|${keyOf(c)}`, true);
    else state.unknown.set(keyOf(c), true);
  }
}

async function readMeta(state: State, addon: LineupAddon, base: string, { type, id }: ChannelRef): Promise<void> {
  const key = placementKey(base, type, id);
  const slowKey = hash(base);
  if (state.failures.has(key) || state.failures.has(slowKey)) return;
  const path = `/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  const began = state.now();
  const body = await shareInFlight(`livetv:${state.id}|${hash(base)}|${path}`, () => addon.fetchJson(base, path));
  if (!body || isAddonError(body.meta)) {
    state.failures.set(key, true);
    if (state.now() - began >= SLOW_MS) state.failures.set(slowKey, true);
    return;
  }
  const meta = body.meta ? channelMetaOf({ ...body.meta, id, type }, { type }) : null;
  // Found this way it has no guide, so it is looked up by its id again soon.
  const ttl = state.failures.has(`ids|${key}`) ? FAILURE_MS : PLACEMENT_TTL_MS;
  state.placements.set(key, meta ? { meta, number: meta.channelNumber } : GONE, { ttl });
}

/**
 * Where each channel is listed or found: in the list as read so far, by its id
 * in the catalogs that take ids, further down the list where one does not, and
 * by its meta. `guideOnly` leaves out what only the channel's own name or
 * number needs. Catalogs narrowed to groups answer GONE for any other channel,
 * also one found for someone else.
 */
export async function placementsFor(
  addon: LineupAddon,
  base: string,
  catalogs: LiveCatalog[],
  channels: ChannelRef[],
  { guideOnly = false }: { guideOnly?: boolean } = {}
): Promise<Array<Placement | typeof GONE | null>> {
  const state = stateFor(addon);
  let list = assemble(state, addon, base, catalogs);
  const keyOf = (c: ChannelRef) => placementKey(base, c.type, c.id);
  const held = (c: ChannelRef) => state.placements.get(keyOf(c));
  const located = (c: ChannelRef): Placement | undefined => {
    const placement = held(c);
    return placement && placement !== GONE && placement.catalog ? placement : undefined;
  };
  const unlisted = () => [...new Map(channels.filter((c) => !list.byKey.has(channelKey(c))).map((c) => [channelKey(c), c])).values()];

  let left = unlisted();
  if (left.length) await findByIds(state, addon, base, wholeCatalogs(catalogs), left.filter((c) => !located(c)));
  const allById = catalogs.every((c) => c.ids);
  const toWalk = left.filter((c) => {
    const placement = located(c);
    return placement ? !guideOnly && placement.number === undefined && placement.skip === undefined : !allById;
  });
  if (toWalk.length) {
    list = await walk(addon, base, catalogs, (l) => toWalk.every((c) => l.byKey.has(channelKey(c))));
    left = unlisted();
  }
  if (!guideOnly) {
    // When a read of many channels fails, as under a rate limit, a read of each would only add to it.
    const readable = left.filter((c) => held(c) === undefined && (channels.length === 1 || !state.failures.has(`ids|${keyOf(c)}`)));
    await inBatches(readable.map((c) => () => readMeta(state, addon, base, c)), PARALLEL_META_READS);
  }
  const admits = admitter(state, base, catalogs);
  return channels.map((c) => {
    const listed = list.byKey.get(channelKey(c));
    if (listed) return listed;
    const found = held(c);
    return found && found !== GONE && !admits(found.meta, found.catalog) ? GONE : found ?? null;
  });
}

export async function placementFor(
  addon: LineupAddon,
  base: string,
  catalogs: LiveCatalog[],
  channel: ChannelRef
): Promise<Placement | typeof GONE | null> {
  const [placement] = await placementsFor(addon, base, catalogs, [channel]);
  return placement;
}
