// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { LRUCache } from 'lru-cache';
import { clockOptions, hash, inBatches, isAddonError, shareInFlight, type AddonDeps } from '../addonReader';
import { AIOSTREAMS_PAGE, catalogKey, endsList, idChunks, isAioStreams, narrowedTo, pagePath, readPage, wholeCatalogs, type LiveCatalog } from './catalogs';
import { bytesOf, clipped, groupNameOf, idOf, MAX_NAME, shortOf, text, urlOf } from './bounds';
import { listSize, programmesOf, type Programme } from './programmes';

const LINEUP_TTL_MS = 60 * 60 * 1000;
const PLACEMENT_TTL_MS = 60 * 60 * 1000;
const FAILURE_MS = 30 * 1000;
const PAUSE_MS = 1000;
const EMPTY_TTL_MS = 60 * 1000;
const MAX_PAGES = 100;
const MAX_LINEUPS = 20000;
const MAX_HELD_BYTES = 256 * 1024 * 1024;
// What one addon may hold of it, so that no other addon's lists give way to one.
const MAX_ADDON_BYTES = MAX_HELD_BYTES / 4;
const MAX_ASSEMBLED = 500000;
const MAX_PLACEMENTS = 20000;
const MAX_LIST = 50000;
const MAX_FAILURES = 5000;
const SLOW_MS = 4000;
const IDLE_MS = 2 * 60 * 60 * 1000;
const SWEEP_MS = 10 * 60 * 1000;
const PARALLEL_META_READS = 8;
const PARALLEL_ID_READS = 4;
const MAX_GROUPS_KEPT = 50;
const DETAILS_FIRST = 4;
// What one request reads of the details of many channels.
const MAX_DETAIL_READS = 100;
const DETAILS_MS = 10 * 1000;
const PARALLEL_PAGES = 4;
const WALK_MS = 20 * 1000;
const LOOKUP_MS = 10 * 1000;
const SMALL_PAGES = 3;
const FULL_REFRESH_MS = 6 * 60 * 60 * 1000;
const SCHEDULE_TTL_MS = 30 * 60 * 1000;
const MAX_SCHEDULES = 5000;
const MAX_SCHEDULE_BYTES = 16 * 1024 * 1024;

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

type LineupAddon = Pick<AddonDeps, 'fetchJson' | 'now' | 'paused'>;

interface Lineup {
  /** The addon it is of. */
  scope: string;
  channels: ChannelMeta[];
  bytes: number;
  /** How many of its bytes are counted in its addon's share. */
  counted: number;
  skips: number[];
  keys: Set<string>;
  next: number;
  pages: number;
  /** Where its last page began, also an empty one. */
  tail: number;
  done: boolean;
  readAt: number;
  usedAt: number;
  failedAt?: number;
  /** The read of its next page, shared by every list that holds it. */
  reading?: Promise<boolean>;
  refreshFailedAt?: number;
  /** What a refresh has read of it so far. */
  fresh?: Lineup;
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
  /** The bytes each addon's lineups hold. */
  shares: Map<string, number>;
  placements: LRUCache<string, Placement | typeof GONE>;
  assemblies: LRUCache<string, Assembly>;
  /** Channel reads that failed lately, and addons whose channel reads time out. */
  failures: LRUCache<string, true>;
  /** Channels the reads by id answered without. */
  unknown: LRUCache<string, true>;
  /** The programmes that came with a channel's details. */
  schedules: LRUCache<string, Programme[]>;
  /** The lineups being refreshed or waiting for it, and each addon's last in line. */
  refreshing: Set<string>;
  turns: Map<string, Promise<void>>;
}

const states = new WeakMap<object, State>();
let serial = 0;

export function stateFor(addon: LineupAddon): State {
  let state = states.get(addon);
  if (!state) {
    const clock = clockOptions(addon.now);
    const assemblies = new LRUCache<string, Assembly>({ max: 500, maxSize: MAX_ASSEMBLED, sizeCalculation: (assembly) => assembly.entries.length + 1 });
    const shares = new Map<string, number>();
    const created: State = {
      id: ++serial,
      now: addon.now,
      lineups: new LRUCache<string, Lineup>({
        max: MAX_LINEUPS,
        maxSize: MAX_HELD_BYTES,
        sizeCalculation: heldBytes,
        ttl: LINEUP_TTL_MS,
        allowStale: true,
        noDeleteOnStaleGet: true,
        dispose: (lineup, _key, reason) => {
          count(shares, lineup, 0);
          if (reason === 'evict' || reason === 'set') dropAssemblies(assemblies, lineup);
        },
        ...clock,
      }),
      shares,
      placements: new LRUCache<string, Placement | typeof GONE>({ max: MAX_PLACEMENTS, ttl: PLACEMENT_TTL_MS, ...clock }),
      assemblies,
      failures: new LRUCache<string, true>({ max: MAX_FAILURES, ttl: FAILURE_MS, ...clock }),
      unknown: new LRUCache<string, true>({ max: MAX_FAILURES, ttl: EMPTY_TTL_MS, ...clock }),
      schedules: new LRUCache<string, Programme[]>({
        max: MAX_SCHEDULES,
        maxSize: MAX_SCHEDULE_BYTES,
        sizeCalculation: listSize,
        ttl: SCHEDULE_TTL_MS,
        ...clock,
      }),
      refreshing: new Set(),
      turns: new Map(),
    };
    states.set(addon, created);
    setInterval(() => purge(created), SWEEP_MS).unref();
    state = created;
  }
  return state;
}

const heldBytes = (lineup: Lineup): number => 1 + lineup.bytes + (lineup.fresh?.bytes ?? 0);

function count(shares: State['shares'], lineup: Lineup, bytes: number): void {
  const share = (shares.get(lineup.scope) ?? 0) + bytes - lineup.counted;
  lineup.counted = bytes;
  if (share > 0) shares.set(lineup.scope, share);
  else shares.delete(lineup.scope);
}

/** Puts a lineup where it belongs, counted as it is now. An addon's other lineups give way to it, the longest unused first. */
function hold(state: State, key: string, lineup: Lineup, ttl: number = LINEUP_TTL_MS): void {
  const held = state.lineups.peek(key);
  if (held && held !== lineup) dropAssemblies(state.assemblies, held);
  state.lineups.delete(key);
  state.lineups.set(key, lineup, { ttl });
  if (state.lineups.peek(key) !== lineup) return;
  count(state.shares, lineup, heldBytes(lineup));
  const share = () => state.shares.get(lineup.scope) ?? 0;
  if (share() <= MAX_ADDON_BYTES) return;
  for (const other of [...state.lineups.rkeys()]) {
    if (share() <= MAX_ADDON_BYTES) return;
    const own = other === key ? undefined : state.lineups.peek(other);
    if (own?.scope !== lineup.scope) continue;
    state.lineups.delete(other);
    dropAssemblies(state.assemblies, own);
  }
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
const groupNames = new LRUCache<string, string>({ max: 20000, maxSize: 4 * 1024 * 1024, sizeCalculation: (name) => bytesOf(name) });

function groupName(name: string): string {
  const held = groupNames.get(name);
  if (held !== undefined) return held;
  groupNames.set(name, name);
  return name;
}

export function channelMetaOf(entry: any, catalog: Pick<LiveCatalog, 'type'>): ChannelMeta | null {
  const id = idOf(entry?.id);
  if (!id) return null;
  const meta: ChannelMeta = { id, type: shortOf(entry.type) ?? catalog.type, name: clipped(entry.name, MAX_NAME) ?? id };
  const logo = urlOf(entry.logo);
  const poster = logo ? undefined : urlOf(entry.poster);
  if (logo) meta.logo = logo;
  if (poster) meta.poster = poster;
  const number = shortOf(typeof entry.channelNumber === 'number' ? String(entry.channelNumber) : text(entry.channelNumber)?.trim());
  if (number) meta.channelNumber = number;
  const catchup = Number(entry.behaviorHints?.catchupDays);
  if (Number.isFinite(catchup) && catchup > 0) meta.catchupDays = catchup;
  const groups = (Array.isArray(entry.genres) ? entry.genres : []).filter((g: unknown): g is string => groupNameOf(g) !== undefined);
  if (groups.length) meta.groups = groups.slice(0, MAX_GROUPS_KEPT).map(groupName);
  return meta;
}

/** About what a channel takes in memory, also as a part of lists. */
export function sizeOf(meta: ChannelMeta): number {
  let size = 300 + 2 * bytesOf(meta.id) + (meta.groups?.length ?? 0) * 8;
  for (const value of [meta.name, meta.logo, meta.poster, meta.channelNumber]) if (value) size += bytesOf(value);
  return size;
}

const lineupKey = (base: string, catalog: LiveCatalog): string => `${hash(base)}|${catalogKey(catalog)}`;
const assemblyKey = (base: string, catalogs: LiveCatalog[]): string => `${hash(base)}|${catalogs.map(catalogKey).join(',')}`;
const placementKey = (base: string, type: string, id: string): string => `${hash(base)}|${type}|${id}`;
const channelKey = (meta: Pick<ChannelMeta, 'type' | 'id'>): string => `${meta.type}|${meta.id}`;

function emptyLineup(state: State, base: string): Lineup {
  return { scope: hash(base), channels: [], bytes: 0, counted: 0, skips: [], keys: new Set(), next: 0, pages: 0, tail: 0, done: false, readAt: state.now(), usedAt: state.now() };
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

function remeasure(state: State, key: string, lineup: Lineup): void {
  if (state.lineups.peek(key) !== lineup) return;
  const ttl = isEmpty(lineup) ? EMPTY_TTL_MS : Math.max(1, state.lineups.getRemainingTTL(key));
  hold(state, key, lineup, ttl);
}

function addPage(catalog: LiveCatalog, lineup: Lineup, page: any[]): void {
  lineup.pages++;
  let added = 0;
  for (const entry of page) {
    const meta = channelMetaOf(entry, catalog);
    if (lineup.channels.length >= MAX_LIST || lineup.bytes >= MAX_ADDON_BYTES) break;
    if (!meta || lineup.keys.has(channelKey(meta))) continue;
    lineup.keys.add(channelKey(meta));
    lineup.channels.push(meta);
    lineup.bytes += sizeOf(meta);
    lineup.skips.push(lineup.next);
    added++;
  }
  lineup.tail = lineup.next;
  lineup.next += page.length;
  if (!catalog.skip || added === 0 || endsList(catalog, page) || lineup.pages >= MAX_PAGES || lineup.channels.length >= MAX_LIST || lineup.bytes >= MAX_ADDON_BYTES) lineup.done = true;
}

async function readInto(addon: LineupAddon, base: string, catalog: LiveCatalog, lineup: Lineup, { ahead = 1, until }: { ahead?: number; until?: number } = {}): Promise<boolean> {
  const skips = Array.from({ length: ahead }, (_, n) => lineup.next + n * AIOSTREAMS_PAGE);
  const pages = await Promise.all(skips.map((skip) => readPage(addon, base, catalog, { skip }, until)));
  let read = false;
  for (const page of pages) {
    if (!page || lineup.done) break;
    addPage(catalog, lineup, page);
    read = true;
    if (page.length !== AIOSTREAMS_PAGE) break;
  }
  return read;
}

/** Whether the first and last pages are as they were, or undefined when one fails. */
async function unchanged(addon: LineupAddon, base: string, catalog: LiveCatalog, old: Lineup): Promise<boolean | undefined> {
  const mark = (meta: ChannelMeta) => `${channelKey(meta)}|${meta.name}|${meta.channelNumber}`;
  for (const skip of new Set([0, old.skips[old.skips.length - 1], old.tail])) {
    const page = await readPage(addon, base, catalog, { skip });
    if (!page) return undefined;
    const is = page.map((entry) => channelMetaOf(entry, catalog)).filter((meta): meta is ChannelMeta => meta !== null);
    const was = old.channels.filter((_, n) => old.skips[n] === skip);
    if (is.map(mark).join('\n') !== was.map(mark).join('\n')) return false;
  }
  return true;
}

async function refresh(state: State, addon: LineupAddon, base: string, catalog: LiveCatalog, old: Lineup): Promise<void> {
  const key = lineupKey(base, catalog);
  const failed = () => {
    old.refreshFailedAt = state.now();
    remeasure(state, key, old);
  };
  if (state.lineups.peek(key) !== old) return;
  if (!old.fresh && old.pages > SMALL_PAGES && state.now() - old.readAt < FULL_REFRESH_MS) {
    const same = await unchanged(addon, base, catalog, old);
    if (same === undefined) return failed();
    if (same) {
      if (state.lineups.peek(key) === old) hold(state, key, old);
      return;
    }
  }
  if (old.fresh && state.now() - old.fresh.readAt > LINEUP_TTL_MS) old.fresh = undefined;
  const fresh = (old.fresh ??= emptyLineup(state, base));
  const limit = old.done ? MAX_PAGES : Math.max(1, old.pages);
  while (!fresh.done && fresh.pages < limit) {
    if (!(await readInto(addon, base, catalog, fresh))) return failed();
    if (!fresh.channels.length && old.channels.length) {
      old.fresh = undefined;
      return failed();
    }
  }
  fresh.usedAt = old.usedAt;
  if (state.lineups.peek(key) === old) hold(state, key, fresh);
}

/** Refreshes the lineups past their time, one after another for each addon. */
function refreshDue(state: State, addon: LineupAddon, base: string, catalogs: LiveCatalog[], lineups: Lineup[]): void {
  lineups.forEach((lineup, n) => {
    const catalog = catalogs[n];
    const key = lineupKey(base, catalog);
    if (state.lineups.getRemainingTTL(key) > 0 || state.refreshing.has(key)) return;
    if (lineup.refreshFailedAt !== undefined && state.now() - lineup.refreshFailedAt < FAILURE_MS) return;
    state.refreshing.add(key);
    const scope = hash(base);
    const turn: Promise<void> = (state.turns.get(scope) ?? Promise.resolve())
      .then(() => refresh(state, addon, base, catalog, lineup))
      .catch(() => undefined)
      .finally(() => {
        state.refreshing.delete(key);
        if (state.turns.get(scope) === turn) state.turns.delete(scope);
      });
    state.turns.set(scope, turn);
  });
}

function assemble(state: State, base: string, catalogs: LiveCatalog[]): Assembly {
  const memoKey = assemblyKey(base, catalogs);
  let memo = state.assemblies.get(memoKey);
  if (memo && memo.lineups.some((lineup, n) => heldLineup(state, lineupKey(base, catalogs[n])) !== lineup)) memo = undefined;
  if (!memo) {
    memo = { lineups: [], consumed: 0, entries: [], byKey: new Map(), finished: false, blocked: false };
    state.assemblies.set(memoKey, memo);
  }
  const before = memo.entries.length;
  extend(state, base, catalogs, memo);
  if (memo.entries.length !== before) {
    state.assemblies.delete(memoKey);
    state.assemblies.set(memoKey, memo);
  }
  return memo;
}

/** Adds what its lineups have come to hold. */
function extend(state: State, base: string, catalogs: LiveCatalog[], memo: Assembly): void {
  for (;;) {
    const at = memo.lineups.length - 1;
    if (at >= 0) {
      const lineup = memo.lineups[at];
      const catalog = catalogs[at];
      for (; memo.consumed < lineup.channels.length; memo.consumed++) {
        if (memo.entries.length >= MAX_LIST) {
          memo.finished = true;
          memo.blocked = false;
          return;
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
        return;
      }
    }
    const next = memo.lineups.length;
    if (next >= catalogs.length || memo.entries.length >= MAX_LIST) {
      memo.finished = true;
      memo.blocked = false;
      return;
    }
    const lineup = heldLineup(state, lineupKey(base, catalogs[next]));
    if (!lineup) {
      memo.finished = false;
      memo.blocked = false;
      return;
    }
    memo.lineups.push(lineup);
    memo.consumed = 0;
  }
}

type Outcome = 'read' | 'failed' | 'blocked' | 'done';

interface WalkOptions {
  /** How many channels are asked for, to read that far ahead. */
  want?: number;
  waitMs?: number;
}

/** How many pages of a list that has proven long can be read at once. */
function pagesAhead(catalog: LiveCatalog, lineup: Lineup, missing: number): number {
  if (!isAioStreams(catalog) || catalog.genre !== undefined || !catalog.skip) return 1;
  if (lineup.pages < PARALLEL_PAGES || lineup.next !== lineup.pages * AIOSTREAMS_PAGE) return 1;
  return Math.max(1, Math.min(PARALLEL_PAGES, Math.ceil(missing / AIOSTREAMS_PAGE), MAX_PAGES - lineup.pages));
}

async function readOn(state: State, addon: LineupAddon, base: string, catalogs: LiveCatalog[], list: Assembly, want: number, until: number): Promise<Outcome> {
  const blocked = (lineup: Lineup) => lineup.failedAt !== undefined && state.now() - lineup.failedAt < FAILURE_MS;
  const due: Array<{ catalog: LiveCatalog; key: string; lineup: Lineup }> = [];
  let missing = want - list.entries.length;
  for (let at = Math.max(0, list.lineups.length - 1); at < catalogs.length; at++) {
    const catalog = catalogs[at];
    const key = lineupKey(base, catalog);
    let lineup = heldLineup(state, key);
    if (due.length) {
      // Further groups of AIOStreams begin beside the first, where the page of each leaves some to read.
      if (lineup) {
        missing -= lineup.channels.length;
        continue;
      }
      if (due.length >= PARALLEL_PAGES || missing <= due.length * AIOSTREAMS_PAGE || catalog.genre === undefined || !isAioStreams(catalog)) break;
    } else if (lineup?.done) continue;
    if (!lineup) {
      lineup = emptyLineup(state, base);
      hold(state, key, lineup);
    }
    if (blocked(lineup)) return 'blocked';
    due.push({ catalog, key, lineup });
  }
  const outcomes = await Promise.all(due.map(async ({ catalog, key, lineup }): Promise<Outcome> => {
    lineup.reading ??= readInto(addon, base, catalog, lineup, { ahead: pagesAhead(catalog, lineup, missing), until })
      .finally(() => { lineup.reading = undefined; });
    if (!(await lineup.reading)) {
      if (!addon.paused?.(base)) lineup.failedAt = state.now();
      return 'failed';
    }
    lineup.failedAt = undefined;
    remeasure(state, key, lineup);
    return 'read';
  }));
  return outcomes[0] ?? 'done';
}

async function walk(
  addon: LineupAddon,
  base: string,
  catalogs: LiveCatalog[],
  satisfied: (list: Assembly) => boolean,
  { want = 0, waitMs = WALK_MS }: WalkOptions = {}
): Promise<Assembly> {
  const state = stateFor(addon);
  const until = addon.now() + waitMs;
  let last: Assembly | undefined;
  for (let reads = 0; ; reads++) {
    const list = assemble(state, base, catalogs);
    // A lineup that gave way to later ones of the same walk would be read again without end.
    const gone = last?.lineups[list.lineups.length];
    if (last && gone && !isEmpty(gone)) return last;
    last = list;
    if (!reads) refreshDue(state, addon, base, catalogs, list.lineups);
    if (satisfied(list) || list.finished || list.blocked || reads > MAX_PAGES * catalogs.length || addon.now() >= until) return list;
    if ((await readOn(state, addon, base, catalogs, list, want, until)) !== 'read') return assemble(state, base, catalogs);
  }
}

export async function listChannels(
  addon: LineupAddon,
  base: string,
  catalogs: LiveCatalog[],
  { startIndex, limit }: { startIndex: number; limit: number }
): Promise<{ channels: ListedChannel[]; total: number }> {
  const end = startIndex + limit;
  const list = await walk(addon, base, catalogs, (l) => l.entries.length >= end, { want: end });
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
  const list = await walk(addon, base, groupCatalogs(catalogs, genre), (l) => l.entries.length >= end, { want: end });
  const state = stateFor(addon);
  const whole = assemble(state, base, catalogs).byKey;
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
  enough: (entries: Placement[]) => boolean = () => false,
  waitMs?: number
): Promise<Placement[]> {
  const list = await walk(addon, base, catalogs, (l) => l.entries.length >= limit || enough(l.entries), { waitMs });
  return list.entries.slice(0, limit);
}

/** Those of the channels that are not among the ones listed so far. */
export function unlisted<T extends { meta: Pick<ChannelMeta, 'type' | 'id'> }>(addon: LineupAddon, base: string, catalogs: LiveCatalog[], channels: T[]): T[] {
  const { byKey } = assemble(stateFor(addon), base, catalogs);
  return channels.filter(({ meta }) => !byKey.has(channelKey(meta)));
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
  const list = await walk(addon, base, catalogs, (l) => l.lineups[last]?.done === true || guided(l).length >= limit, { want: limit });
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
  const until = addon.now() + LOOKUP_MS;
  let left = channels.filter((c) => !state.unknown.has(keyOf(c)) && !state.failures.has(`ids|${keyOf(c)}`));
  for (const catalog of catalogs) {
    if (!catalog.ids || !left.length) continue;
    const found = new Set<string>();
    const read = async (chunk: ChannelRef[]) => {
      const ids = [...new Set(chunk.map((c) => c.id))].sort();
      const entries = await shareInFlight(`livetv:${state.id}|${hash(base)}|${pagePath(catalog, { ids })}`, () => readPage(addon, base, catalog, { ids }, until));
      if (!entries) for (const c of chunk) failed.add(keyOf(c));
      const wanted = new Set(chunk.map(keyOf));
      for (const entry of entries ?? []) {
        const meta = channelMetaOf(entry, catalog);
        if (!meta || !wanted.has(keyOf(meta))) continue;
        rememberFound(addon, base, meta, catalog);
        found.add(keyOf(meta));
      }
    };
    await inBatches(idChunks(left).map((chunk) => () => read(chunk)), PARALLEL_ID_READS);
    left = left.filter((c) => !found.has(keyOf(c)));
  }
  for (const c of left) {
    if (failed.has(keyOf(c))) state.failures.set(`ids|${keyOf(c)}`, true, { ttl: addon.paused?.(base) ? PAUSE_MS : FAILURE_MS });
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
  const programmes = meta ? programmesOf(body.meta) : [];
  if (programmes.length) state.schedules.set(key, programmes);
}

/** The programmes held from a channel's details. */
export function scheduleOf(addon: LineupAddon, base: string, { type, id }: ChannelRef): Programme[] {
  return stateFor(addon).schedules.get(placementKey(base, type, id)) ?? [];
}

/**
 * Where each channel is listed or found: in the list as read so far, by its id
 * in the catalogs that take ids, by its details when few are asked for, and in
 * the lists of the catalogs without ids. When many are asked for, the details of
 * some the lists left out are read last. A list is never read for a number.
 * `guideOnly` reads no details, and only lists that lead to a guide. Catalogs
 * narrowed to groups answer GONE for any other channel, also one found for
 * someone else.
 */
export async function placementsFor(
  addon: LineupAddon,
  base: string,
  catalogs: LiveCatalog[],
  channels: ChannelRef[],
  { guideOnly = false }: { guideOnly?: boolean } = {}
): Promise<Array<Placement | typeof GONE | null>> {
  const state = stateFor(addon);
  const keyOf = (c: ChannelRef) => placementKey(base, c.type, c.id);
  const held = (c: ChannelRef) => state.placements.get(keyOf(c));
  const whole = () => assemble(state, base, catalogs).byKey;
  let admits = admitter(state, base, catalogs);
  const found = (c: ChannelRef): Placement | undefined => {
    const placement = held(c);
    return placement && placement !== GONE && admits(placement.meta, placement.catalog) ? placement : undefined;
  };
  const already = whole();
  const left = [...new Map(channels.filter((c) => !already.has(channelKey(c))).map((c) => [channelKey(c), c])).values()];
  const unplaced = left.filter((c) => {
    const placement = held(c);
    return placement !== GONE && !placement?.catalog;
  });
  if (unplaced.length) await findByIds(state, addon, base, wholeCatalogs(catalogs), unplaced);

  const read = (list: ChannelRef[]) => inBatches(list.map((c) => () => readMeta(state, addon, base, c)), PARALLEL_META_READS);
  const first = !guideOnly && left.length <= DETAILS_FIRST;
  // When a read of many channels fails, as under a rate limit, a read of each would only add to it.
  const readable = (c: ChannelRef) => held(c) === undefined && (channels.length === 1 || !state.failures.has(`ids|${keyOf(c)}`));
  if (first) await read(left.filter(readable));

  const lists = catalogs.filter((c) => !c.ids && (!guideOnly || c.guide));
  const toFind = left.filter((c) => (guideOnly ? !found(c)?.catalog && !state.schedules.has(keyOf(c)) : !found(c)));
  let walked: Assembly | undefined;
  if (lists.length && toFind.length) {
    walked = await walk(addon, base, lists, (w) => toFind.every((c) => w.byKey.has(channelKey(c))));
  }
  if (!guideOnly && !first) {
    const until = state.now() + DETAILS_MS;
    const missing = left.filter((c) => !walked?.byKey.has(channelKey(c)) && readable(c) && !state.failures.has(keyOf(c)));
    const tasks = missing.slice(0, MAX_DETAIL_READS).map((c) => async () => {
      if (state.now() < until && !addon.paused?.(base)) await readMeta(state, addon, base, c);
    });
    await inBatches(tasks, PARALLEL_META_READS);
  }

  const listed = whole();
  admits = admitter(state, base, catalogs);
  return channels.map((c) => {
    const inWhole = listed.get(channelKey(c));
    if (inWhole) return inWhole;
    const inLists = walked?.byKey.get(channelKey(c));
    // Its place in some of the lists is not its place in all of them.
    if (inLists) return lists.length === catalogs.length ? inLists : { ...inLists, number: inLists.meta.channelNumber };
    const placement = held(c);
    return placement && placement !== GONE && !admits(placement.meta, placement.catalog) ? GONE : placement ?? null;
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
