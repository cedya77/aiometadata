// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { LRUCache } from 'lru-cache';
import { clockOptions, hash, inBatches, inTime, shareInFlight, type AddonDeps } from '../addonReader';
import { AIOSTREAMS_PAGE, catalogKey, idChunks, isAioStreams, narrowedTo, pagePath, readPage, utcDay, wholeCatalogs, type LiveCatalog } from './catalogs';
import { admitted, channelMetaOf, GONE, listPlacements, placementFor, placementsFor, rememberFound, scheduleOf, sizeOf, type ChannelMeta, type ListedChannel, type Placement } from './lineup';
import { bytesOf } from './bounds';
import { guideBytes, guideTtlMs } from './limits';
import { listSize, pageSize, programmesOf, type Programme } from './programmes';
import { flag, integer, listOf, timeOf, type Ask } from './query';

export { airingAt, pageSize, programmesOf, type Programme } from './programmes';

const EMPTY_TTL_MS = 60 * 1000;
const FAILURE_MS = 30 * 1000;
const MAX_READS = 5000;
const PARALLEL_READS = 8;
const DAY_MS = 86400000;
const GUIDE_DAYS_AHEAD = 7;
const MAX_CATCHUP_DAYS = 14;
const MAX_PROGRAMMES = 50000;
const MAX_SINGLES = 20000;
const MAX_SINGLES_BYTES = 32 * 1024 * 1024;
const IDLE_MS = 60 * 60 * 1000;
const SWEEP_MS = 10 * 60 * 1000;
const SEARCH_SCAN = 5000;
const SEARCH_WAIT_MS = 4000;
const PICKED_WAIT_MS = 2000;
const SEARCH_READ_MS = 8000;
const DATED_WAIT_MS = 2500;
const SEARCH_TTL_MS = 2 * 60 * 1000;
const MAX_SEARCHES = 500;
const MAX_SEARCH_BYTES = 16 * 1024 * 1024;
const MAX_SEARCHED = 1000;
const MAX_TERM = 100;
const FEW_OF_A_PAGE = 25;
const MAX_REQUEST_READS = 400;
const REQUEST_READ_MS = 15 * 1000;

export interface GuideItem {
  channel: ListedChannel;
  programme: Programme;
}

type GuideAddon = Pick<AddonDeps, 'fetchJson' | 'now' | 'paused'>;

interface GuidePage {
  programmes: Map<string, Programme[]>;
  usedAt: number;
  /** How many times in a row it came back without a programme. */
  empties: number;
}

/** One channel's day. */
interface Single {
  programmes: Programme[];
  usedAt: number;
  empties: number;
}

interface ReadContext {
  base: string;
  catalog: LiveCatalog;
  skip: number;
  day: string;
  until: number;
}

interface State {
  id: number;
  now: () => number;
  reads: LRUCache<string, GuidePage, ReadContext>;
  /** The channels read by their ids. */
  singles: LRUCache<string, Single>;
  failures: LRUCache<string, true>;
  /** What each catalog answered to a search. */
  searches: LRUCache<string, ChannelMeta[]>;
}

interface ReadBudget {
  left: number;
  until: number;
}

const states = new WeakMap<object, State>();
let serial = 0;

const isEmpty = (programmes: Map<string, Programme[]>): boolean => programmes.size === 0;

// Empty is also how a guide still loading, or an error the addon hides, looks.
const ttlOf = (empties: number): number => (empties ? Math.min(guideTtlMs(), EMPTY_TTL_MS * 2 ** (empties - 1)) : guideTtlMs());

function purge(state: State): void {
  for (const held of [state.reads, state.singles] as Array<LRUCache<string, { usedAt: number }, any>>) {
    for (const key of [...held.keys()]) {
      const page = held.peek(key);
      if (page && state.now() - page.usedAt > IDLE_MS) held.delete(key);
    }
  }
}

export function purgeGuide(addon: GuideAddon): void {
  purge(stateFor(addon));
}

function stateFor(addon: GuideAddon): State {
  let state = states.get(addon);
  if (!state) {
    const clock = clockOptions(addon.now);
    const failures = new LRUCache<string, true>({ max: MAX_READS, ttl: FAILURE_MS, ...clock });
    const reads = new LRUCache<string, GuidePage, ReadContext>({
      max: MAX_READS,
      maxSize: guideBytes(),
      sizeCalculation: (page) => pageSize(page.programmes),
      ttl: guideTtlMs(),
      allowStale: true,
      allowStaleOnFetchRejection: true,
      noDeleteOnFetchRejection: true,
      ...clock,
      fetchMethod: async (key, stale, { options, context }) => {
        const entries = await readPage(addon, context.base, context.catalog, { skip: context.skip, date: context.day }, context.until);
        const programmes = new Map<string, Programme[]>();
        for (const entry of entries ?? []) {
          const meta = channelMetaOf(entry, context.catalog);
          const list = meta ? programmesOf(entry) : [];
          if (meta && list.length) programmes.set(`${meta.type}|${meta.id}`, list);
        }
        const empty = isEmpty(programmes);
        if (!entries || (empty && stale && !isEmpty(stale.programmes))) {
          if (!addon.paused?.(context.base)) failures.set(key, true);
          throw new Error('guide read failed');
        }
        const empties = empty ? (stale?.empties ?? 0) + 1 : 0;
        options.ttl = ttlOf(empties);
        return { programmes, usedAt: addon.now(), empties };
      },
    });
    const singles = new LRUCache<string, Single>({
      max: MAX_SINGLES,
      maxSize: MAX_SINGLES_BYTES,
      sizeCalculation: (single, key) => bytesOf(key) + listSize(single.programmes),
      ttl: guideTtlMs(),
      allowStale: true,
      noDeleteOnStaleGet: true,
      ...clock,
    });
    const searches = new LRUCache<string, ChannelMeta[]>({
      max: MAX_SEARCHES,
      maxSize: MAX_SEARCH_BYTES,
      sizeCalculation: (metas) => metas.reduce((size, meta) => size + sizeOf(meta), 200),
      ttl: SEARCH_TTL_MS,
      ...clock,
    });
    const created: State = { id: ++serial, now: addon.now, reads, singles, failures, searches };
    states.set(addon, created);
    setInterval(() => purge(created), SWEEP_MS).unref();
    state = created;
  }
  return state;
}

function spend(state: State, budget: ReadBudget): boolean {
  if (budget.left <= 0 || state.now() >= budget.until) return false;
  budget.left--;
  return true;
}

const dayKey = ({ base, catalog, skip, day }: Omit<ReadContext, 'until'>): string => `${hash(base)}|${catalogKey(catalog)}|${skip}|${day}`;

function readDay(state: State, context: ReadContext, budget: ReadBudget): Promise<GuidePage | null> {
  const key = dayKey(context);
  const held = state.reads.peek(key, { allowStale: true });
  if (held) held.usedAt = state.now();
  if (state.failures.has(key)) return Promise.resolve(held ?? null);
  if (!held || state.reads.getRemainingTTL(key) <= 0) {
    if (!spend(state, budget)) return Promise.resolve(held ?? null);
  }
  return state.reads.fetch(key, { context, allowStale: !held || !isEmpty(held.programmes) }).then(
    (page) => page ?? null,
    () => null
  );
}

interface IdContext {
  base: string;
  catalog: LiveCatalog;
  day: string;
}

const singleKey = ({ base, catalog, day }: IdContext, { type, id }: ChannelMeta): string =>
  `${hash(base)}|${catalogKey(catalog)}|${day}|${type}|${id}`;

const nameOf = ({ type, id }: ChannelMeta): string => `${type}|${id}`;

/** Keeps the programmes of the channels that were asked for, from what was read of them. */
function keepSingles(state: State, addon: GuideAddon, context: IdContext, wanted: ChannelMeta[], entries: any[] | null): void {
  const read = new Map<string, Programme[]>();
  for (const entry of entries ?? []) {
    const meta = channelMetaOf(entry, context.catalog);
    if (meta) read.set(nameOf(meta), programmesOf(entry));
  }
  // A channel without programmes beside ones that have them has none, rather than a guide still loading.
  const loaded = [...read.values()].some((list) => list.length > 0);
  for (const channel of wanted) {
    const key = singleKey(context, channel);
    const stale = state.singles.peek(key, { allowStale: true });
    const list = read.get(nameOf(channel)) ?? [];
    if (!entries || (!list.length && !loaded && stale?.programmes.length)) {
      if (!addon.paused?.(context.base)) state.failures.set(key, true);
      continue;
    }
    const empties = list.length || loaded ? 0 : (stale?.empties ?? 0) + 1;
    state.singles.set(key, { programmes: list, usedAt: state.now(), empties }, { ttl: ttlOf(empties) });
  }
}

/** The programmes of channels read by their ids, kept channel by channel. */
async function readChannels(
  state: State,
  addon: GuideAddon,
  context: IdContext,
  channels: ChannelMeta[],
  budget: ReadBudget
): Promise<GuidePage> {
  const { base, catalog, day } = context;
  const keyOf = (c: ChannelMeta) => singleKey(context, c);
  const heldOf = (c: ChannelMeta) => state.singles.peek(keyOf(c), { allowStale: true });

  const load = (wanted: ChannelMeta[]): Promise<void> => {
    const ids = [...new Set(wanted.map((c) => c.id))].sort();
    return shareInFlight(`guide:${state.id}|${hash(base)}|${pagePath(catalog, { ids, date: day })}`, async () => {
      keepSingles(state, addon, context, wanted, await readPage(addon, base, catalog, { ids, date: day }, budget.until));
    });
  };

  const due = channels.filter((c) => !state.failures.has(keyOf(c)) && state.singles.getRemainingTTL(keyOf(c)) <= 0);
  const serveStale = (c: ChannelMeta) => Boolean(heldOf(c)?.programmes.length);
  const first = due.filter((c) => !serveStale(c));
  const later = due.filter(serveStale);
  if (first.length && spend(state, budget)) await load(first);
  if (later.length && spend(state, budget)) void load(later);

  const programmes = new Map<string, Programme[]>();
  for (const channel of channels) {
    const held = state.singles.get(keyOf(channel));
    if (!held) continue;
    held.usedAt = state.now();
    if (held.programmes.length) programmes.set(nameOf(channel), held.programmes);
  }
  return { programmes, usedAt: state.now(), empties: 0 };
}

interface PageGroup {
  catalog: LiveCatalog;
  skip: number;
  channels: ChannelMeta[];
}

/**
 * The pages to read by their channels' ids instead: those asked for few of their
 * channels and not held, where that takes fewer reads, or whose channels are held.
 */
function readByIds(state: State, base: string, pages: PageGroup[], day: string): Set<PageGroup> {
  const byIds = new Set<PageGroup>();
  const few = new Map<string, PageGroup[]>();
  for (const page of pages) {
    const { catalog, skip, channels } = page;
    if (!catalog.ids || channels.length >= FEW_OF_A_PAGE || state.reads.peek(dayKey({ base, catalog, skip, day }), { allowStale: true })) continue;
    const [whole] = wholeCatalogs([catalog]);
    if (channels.every((c) => state.singles.has(singleKey({ base, catalog: whole, day }, c)))) {
      byIds.add(page);
      continue;
    }
    const key = catalogKey(whole);
    few.set(key, [...(few.get(key) ?? []), page]);
  }
  for (const group of few.values()) {
    if (group.length - idChunks(group.flatMap((page) => page.channels)).length >= 2) for (const page of group) byIds.add(page);
  }
  return byIds;
}

export function daysOf(fromMs: number, toMs: number): string[] {
  const days: string[] = [];
  const last = Math.max(fromMs, toMs - 1);
  for (let at = Math.floor(fromMs / DAY_MS) * DAY_MS; at <= last; at += DAY_MS) days.push(utcDay(at));
  return days;
}

export async function programmesFor(
  addon: GuideAddon,
  base: string,
  catalogs: LiveCatalog[],
  channels: Array<{ type: string; id: string }>,
  fromMs: number,
  toMs: number,
  { waitMs }: { waitMs?: number } = {}
): Promise<Map<string, Programme[]>> {
  const state = stateFor(addon);
  const until = waitMs === undefined ? undefined : state.now() + waitMs;
  // Half the wait at most, so that a channel not found leaves the others time for their guide.
  const placements = await placementsFor(addon, base, catalogs, channels, { guideOnly: true, waitMs: waitMs === undefined ? undefined : waitMs / 2 });
  const paged = new Map<string, PageGroup>();
  const single = new Map<string, { catalog: LiveCatalog; channels: ChannelMeta[] }>();
  const addTo = (map: typeof single, catalog: LiveCatalog, metas: ChannelMeta[]) => {
    const key = catalogKey(catalog);
    const group = map.get(key) ?? { catalog, channels: [] };
    group.channels.push(...metas);
    map.set(key, group);
  };
  placements.forEach((placement) => {
    if (!placement || placement === GONE || !placement.catalog?.guide) return;
    const { catalog, skip, meta } = placement;
    if (skip === undefined) {
      addTo(single, catalog, [meta]);
      return;
    }
    const key = `${catalogKey(catalog)}|${skip}`;
    const group = paged.get(key) ?? { catalog, skip, channels: [] };
    group.channels.push(meta);
    paged.set(key, group);
  });

  const now = state.now();
  const away = (day: string) => Math.abs(Date.parse(day) + DAY_MS / 2 - now);
  const days = daysOf(fromMs, toMs).sort((a, b) => away(a) - away(b));
  const budget: ReadBudget = { left: MAX_REQUEST_READS, until: now + REQUEST_READ_MS };
  const work: Array<{ channels: ChannelMeta[]; read: () => Promise<GuidePage | null> }> = [];
  for (const day of days) {
    const pages = [...paged.values()];
    const byIds = readByIds(state, base, pages, day);
    const ids: typeof single = new Map();
    for (const { catalog, channels: metas } of single.values()) addTo(ids, catalog, metas);
    for (const page of pages) {
      const { catalog, skip } = page;
      if (byIds.has(page)) addTo(ids, wholeCatalogs([catalog])[0], page.channels);
      else work.push({ channels: page.channels, read: () => readDay(state, { base, catalog, skip, day, until: budget.until }, budget) });
    }
    for (const { catalog, channels: metas } of ids.values()) {
      for (const part of idChunks(metas)) work.push({ channels: part, read: () => readChannels(state, addon, { base, catalog, day }, part, budget) });
    }
  }
  const pages: Array<GuidePage | null> = [];
  const reading = inBatches(work.map(({ read }, n) => async () => { pages[n] = await read(); }), PARALLEL_READS);
  await (until === undefined ? reading : inTime(reading, Math.max(0, until - state.now())));

  const found = new Map<string, Map<number, Programme>>();
  let rows = 0;
  pages.forEach((page, n) => {
    if (!page || rows >= MAX_PROGRAMMES) return;
    for (const meta of work[n].channels) {
      const key = `${meta.type}|${meta.id}`;
      for (const programme of page.programmes.get(key) ?? []) {
        if (programme.start >= toMs || programme.end <= fromMs) continue;
        let byStart = found.get(key);
        if (!byStart) {
          byStart = new Map();
          found.set(key, byStart);
        }
        if (byStart.has(programme.start)) continue;
        byStart.set(programme.start, programme);
        rows++;
      }
    }
  });

  const merged = new Map<string, Programme[]>();
  placements.forEach((placement, n) => {
    if (!placement || placement === GONE || placement.catalog?.guide) return;
    const own = scheduleOf(addon, base, channels[n]).filter((p) => p.start < toMs && p.end > fromMs);
    if (own.length) merged.set(`${placement.meta.type}|${placement.meta.id}`, own);
  });
  for (const [key, byStart] of found) merged.set(key, [...byStart.values()].sort((a, b) => a.start - b.start));
  return merged;
}

export interface ProgrammeFlags {
  IsMovie: boolean;
  IsNews: boolean;
  IsKids: boolean;
  IsSports: boolean;
  IsSeries: boolean;
}

const GENRE_WORDS: Array<[keyof ProgrammeFlags, string[]]> = [
  ['IsMovie', ['movie', 'film']],
  ['IsNews', ['news']],
  ['IsKids', ['kids', 'children', 'animation', 'cartoon']],
  ['IsSports', ['sport']],
];

export function flagsOf(programme: Programme): ProgrammeFlags {
  const genres = (programme.genres ?? []).join(' ').toLowerCase();
  const flags: ProgrammeFlags = { IsMovie: false, IsNews: false, IsKids: false, IsSports: false, IsSeries: false };
  for (const [name, words] of GENRE_WORDS) flags[name] = words.some((word) => genres.includes(word));
  flags.IsSeries = programme.season !== undefined || programme.episode !== undefined;
  return flags;
}

export function guideRange(manifest: any, now: number): { start: number; end: number } {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const hint = Number(manifest?.behaviorHints?.catchupDays);
  const back = Number.isFinite(hint) && hint > 0 ? Math.min(MAX_CATCHUP_DAYS, Math.floor(hint)) : 0;
  return { start: today - back * DAY_MS, end: today + GUIDE_DAYS_AHEAD * DAY_MS };
}

const collator = new Intl.Collator();

const wordsOf = (value: unknown): string[] => String(value ?? '').toLowerCase().split(/\s+/).filter(Boolean);

export function filterProgrammes(items: GuideItem[], ask: Ask, now: number): { items: GuideItem[]; total: number } {
  const minStart = timeOf(ask('MinStartDate'));
  const maxStart = timeOf(ask('MaxStartDate'));
  const minEnd = timeOf(ask('MinEndDate'));
  const maxEnd = timeOf(ask('MaxEndDate'));
  const airing = flag(ask('IsAiring'));
  const aired = flag(ask('HasAired'));
  const genres = listOf(ask('Genres'), '|').map((g) => g.toLowerCase());
  const wanted = (['IsMovie', 'IsNews', 'IsKids', 'IsSports', 'IsSeries'] as const)
    .map((name) => [name, flag(ask(name))] as const)
    .filter(([, value]) => value !== undefined);
  const term = wordsOf(ask('SearchTerm'));

  const kept = items.filter(({ programme: p }) => {
    if (minStart !== null && p.start < minStart) return false;
    if (maxStart !== null && p.start > maxStart) return false;
    if (minEnd !== null && p.end < minEnd) return false;
    if (maxEnd !== null && p.end > maxEnd) return false;
    if (airing !== undefined && (p.start <= now && now < p.end) !== airing) return false;
    if (aired !== undefined && (p.end <= now) !== aired) return false;
    if (genres.length && !(p.genres ?? []).some((g) => genres.includes(g.toLowerCase()))) return false;
    if (wanted.length) {
      const flags = flagsOf(p);
      if (wanted.some(([name, value]) => flags[name] !== value)) return false;
    }
    if (term.length) {
      const title = p.title.toLowerCase();
      if (!term.every((word) => title.includes(word))) return false;
    }
    return true;
  });

  const sortBy = listOf(ask('SortBy')).map((v) => v.toLowerCase());
  const byName = sortBy.includes('sortname') || sortBy.includes('name');
  kept.sort((a, b) =>
    byName
      ? collator.compare(a.programme.title, b.programme.title) || a.programme.start - b.programme.start
      : a.programme.start - b.programme.start || collator.compare(a.programme.title, b.programme.title)
  );
  if (String(listOf(ask('SortOrder'))[0] ?? '').toLowerCase() === 'descending') kept.reverse();

  const startIndex = Math.max(0, integer(ask('StartIndex'), 0));
  const limit = Math.min(MAX_PROGRAMMES, Math.max(1, integer(ask('Limit'), MAX_PROGRAMMES)));
  return { items: kept.slice(startIndex, startIndex + limit), total: kept.length };
}

export function caughtUp(meta: Pick<ChannelMeta, 'catchupDays'>, startMs: number, now: number): boolean {
  return meta.catchupDays !== undefined && now - meta.catchupDays * DAY_MS <= startMs && startMs <= now;
}

export interface ProgrammeTarget {
  channel: ListedChannel;
  programme?: Programme;
  live: boolean;
  streamId: string;
  runtimeMs?: number;
}

export async function programmeTarget(
  addon: GuideAddon,
  base: string,
  catalogs: LiveCatalog[],
  { t, i, at }: { t: string; i: string; at: number },
  { playing = false }: { playing?: boolean } = {}
): Promise<ProgrammeTarget | null> {
  const placement = await placementFor(addon, base, catalogs, { type: t, id: i });
  if (!placement || placement === GONE) return null;
  const channel: ListedChannel = { meta: placement.meta, number: placement.number };
  const startMs = at * 1000;
  // An id holds its start to the second.
  if (playing && ![startMs, startMs + 999].some((start) => caughtUp(placement.meta, start, addon.now()))) {
    return { channel, live: true, streamId: placement.meta.id };
  }
  const startingIn = async (fromMs: number): Promise<Programme | undefined> => {
    const found = await programmesFor(addon, base, catalogs, [{ type: t, id: i }], fromMs, fromMs + 1000);
    return (found.get(`${placement.meta.type}|${placement.meta.id}`) ?? []).find((p) => Math.floor(p.start / 1000) === at);
  };
  // One still on at midnight is on the next day's page too.
  const programme = (await startingIn(startMs)) ?? (await startingIn((Math.floor(startMs / DAY_MS) + 1) * DAY_MS));
  if (programme && caughtUp(placement.meta, programme.start, addon.now())) {
    return { channel, programme, live: false, streamId: programme.id, runtimeMs: programme.end - programme.start };
  }
  return { channel, programme, live: true, streamId: placement.meta.id };
}

/** The channels a catalog's search answers, with what is on them where one read can bring both. */
async function searchIn(state: State, addon: GuideAddon, base: string, catalog: LiveCatalog, wanted: string): Promise<ChannelMeta[] | null> {
  const key = `${hash(base)}|${catalogKey(catalog)}|${wanted}`;
  const held = state.searches.get(key);
  if (held) return held;
  return shareInFlight(`search:${state.id}|${key}`, async () => {
    const until = addon.now() + SEARCH_READ_MS;
    const metasOf = (entries: any[]) =>
      entries.slice(0, MAX_SEARCHED).map((entry) => channelMetaOf(entry, catalog)).filter((meta): meta is ChannelMeta => meta !== null);
    const read = async (day?: string): Promise<ChannelMeta[] | null> => {
      const entries = await readPage(addon, base, catalog, { search: wanted, date: day }, until);
      if (!entries) return null;
      const metas = metasOf(entries);
      if (day) keepSingles(state, addon, { base, catalog, day }, metas, entries);
      if (wanted.length <= MAX_TERM) state.searches.set(key, metas);
      return metas;
    };
    const slow = `search|${hash(base)}|${catalogKey(catalog)}`;
    if (!catalog.guide || !isAioStreams(catalog) || state.failures.has(slow)) return read();
    const dated = await inTime(read(utcDay(addon.now())), DATED_WAIT_MS);
    if (dated !== undefined) return dated;
    state.failures.set(slow, true);
    return read();
  });
}

export async function searchChannels(addon: GuideAddon, base: string, catalogs: LiveCatalog[], term: string, limit: number): Promise<ListedChannel[]> {
  const wanted = String(term ?? '').trim().toLowerCase();
  const terms = wordsOf(wanted);
  const narrowed = narrowedTo(catalogs) !== undefined;
  const waitMs = narrowed ? PICKED_WAIT_MS : SEARCH_WAIT_MS;
  const state = stateFor(addon);

  const answered = new Set<string>();
  let complete = true;
  const found = (
    await Promise.all(
      wholeCatalogs(catalogs).filter((c) => c.search).map(async (catalog) => {
        const metas = await searchIn(state, addon, base, catalog, wanted);
        if (!metas) return [];
        answered.add(`${catalog.type}|${catalog.id}`);
        if (!isAioStreams(catalog) || metas.length >= AIOSTREAMS_PAGE || metas.some((meta) => !meta.groups)) complete = false;
        for (const meta of metas) rememberFound(addon, base, meta, catalog);
        return metas;
      })
    )
  ).flat();

  const hits = admitted(addon, base, catalogs, found);

  // The lists of catalogs without a search are read in full, and the whole list only as far as it adds to
  // what the searches answered. A search of the whole addon may be full of other groups' channels, so
  // picked groups are matched by name as well, unless it answered all there is.
  const isNumber = (number: string | undefined) => number?.toLowerCase() === wanted;
  const answeredAll = catalogs.every((c) => !c.search || answered.has(`${c.type}|${c.id}`));
  const numeric = /^\d\S*$/.test(wanted);
  const searchless = narrowed && (numeric || !complete || !answeredAll) ? catalogs : catalogs.filter((c) => !c.search);
  const patient = searchless.some((c) => !c.search);
  const unsearched = searchless.length ? await listPlacements(addon, base, searchless, SEARCH_SCAN, undefined, patient ? undefined : waitMs) : [];
  const settled = (entries: Placement[]) =>
    !numeric || hits.some((meta) => isNumber(meta.channelNumber)) || entries.some((p) => isNumber(p.number));
  const scanned = searchless.length === catalogs.length ? unsearched : await listPlacements(addon, base, catalogs, SEARCH_SCAN, (entries) =>
    answeredAll && settled(entries), waitMs
  );
  const numbers = new Map(scanned.map((p) => [`${p.meta.type}|${p.meta.id}`, p.number]));
  const asked = hits.map((meta) => ({ meta, number: numbers.get(`${meta.type}|${meta.id}`) ?? meta.channelNumber }));
  const exactNumber = [
    ...scanned.filter((p) => isNumber(p.number)).map((p) => ({ meta: p.meta, number: p.number })),
    ...unsearched.filter((p) => isNumber(p.meta.channelNumber)).map((p) => ({ meta: p.meta, number: p.meta.channelNumber })),
  ];
  const named = [...scanned, ...unsearched]
    .filter((p) => (narrowed || !answered.has(`${p.catalog?.type}|${p.catalog?.id}`)) && terms.length > 0 && terms.every((word) => p.meta.name.toLowerCase().includes(word)))
    .map((p) => ({ meta: p.meta, number: numbers.get(`${p.meta.type}|${p.meta.id}`) ?? p.meta.channelNumber }));

  const seen = new Set<string>();
  const all = [...exactNumber, ...asked, ...named].filter((c) => {
    const key = `${c.meta.type}|${c.meta.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const exact = all.filter((c) => isNumber(c.number));
  return [...exact, ...all.filter((c) => !exact.includes(c))].slice(0, limit);
}
