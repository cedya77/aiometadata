// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { LRUCache } from 'lru-cache';
import { chunksOf, clockOptions, hash, inBatches, shareInFlight, type AddonDeps } from '../addonReader';
import { catalogKey, IDS_PER_READ, narrowedTo, pagePath, readPage, utcDay, wholeCatalogs, type LiveCatalog } from './catalogs';
import { admitted, channelMetaOf, GONE, listPlacements, placementFor, placementsFor, rememberFound, type ChannelMeta, type ListedChannel, type Placement } from './lineup';
import { flag, integer, listOf, timeOf, type Ask } from './query';

const READ_TTL_MS = 30 * 60 * 1000;
const EMPTY_TTL_MS = 60 * 1000;
const FAILURE_MS = 30 * 1000;
const MAX_READS = 5000;
const PARALLEL_READS = 8;
const DAY_MS = 86400000;
const GUIDE_DAYS_AHEAD = 7;
const MAX_CATCHUP_DAYS = 14;
const MAX_PROGRAMMES = 50000;
const MAX_HELD_BYTES = 128 * 1024 * 1024;
const MAX_SINGLES = 20000;
const MAX_SINGLES_BYTES = 32 * 1024 * 1024;
const IDLE_MS = 60 * 60 * 1000;
const SWEEP_MS = 10 * 60 * 1000;
const SEARCH_SCAN = 5000;
const SEARCH_WAIT_MS = 4000;
const MAX_REQUEST_READS = 400;
const REQUEST_READ_MS = 15 * 1000;

export interface Programme {
  id: string;
  title: string;
  start: number;
  end: number;
  overview?: string;
  image?: string;
  background?: string;
  genres?: string[];
  cast?: string[];
  directors?: string[];
  season?: number;
  episode?: number;
  imdbId?: string;
}

export interface GuideItem {
  channel: ListedChannel;
  programme: Programme;
}

type GuideAddon = Pick<AddonDeps, 'fetchJson' | 'now'>;

interface GuidePage {
  programmes: Map<string, Programme[]>;
  usedAt: number;
  /** How many times in a row it came back without a programme. */
  empties: number;
}

interface ReadContext {
  base: string;
  catalog: LiveCatalog;
  skip: number;
  day: string;
}

interface State {
  id: number;
  now: () => number;
  reads: LRUCache<string, GuidePage, ReadContext>;
  /** One channel's day, for the channels read by their ids. */
  singles: LRUCache<string, GuidePage>;
  failures: LRUCache<string, true>;
}

interface ReadBudget {
  left: number;
  until: number;
}

const states = new WeakMap<object, State>();
let serial = 0;

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];

function wholeNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export function programmesOf(entry: any): Programme[] {
  const parsed: Programme[] = [];
  for (const video of Array.isArray(entry?.videos) ? entry.videos : []) {
    const id = text(video?.id);
    const start = timeOf(video?.startTime);
    const end = timeOf(video?.endTime);
    if (!id || start === null || end === null || end <= start) continue;
    const programme: Programme = { id, title: text(video.title) ?? text(video.name) ?? '', start, end };
    const overview = text(video.description) ?? text(video.overview);
    if (overview) programme.overview = overview;
    const image = text(video.thumbnail);
    const background = text(video.background);
    if (image) programme.image = image;
    if (background) programme.background = background;
    for (const key of ['genres', 'cast', 'directors'] as const) {
      const list = strings(video[key]);
      if (list.length) programme[key] = list;
    }
    const season = wholeNumber(video.season);
    const episode = wholeNumber(video.episode);
    if (season !== undefined) programme.season = season;
    if (episode !== undefined) programme.episode = episode;
    const imdbId = text(video.imdbId);
    if (imdbId) programme.imdbId = imdbId;
    parsed.push(programme);
  }
  parsed.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Programme[] = [];
  for (const programme of parsed) {
    const last = kept[kept.length - 1];
    if (last && last.start === programme.start) continue;
    if (last && last.end > programme.start) last.end = programme.start;
    kept.push(programme);
  }
  return kept;
}

export function airingAt(programmes: Programme[] | undefined, atMs: number): Programme | undefined {
  return programmes?.find((p) => p.start <= atMs && atMs < p.end);
}

export function pageSize(programmes: Map<string, Programme[]>): number {
  let size = 1;
  for (const list of programmes.values()) {
    for (const programme of list) {
      size += 200;
      for (const value of Object.values(programme)) {
        if (typeof value === 'string') size += value.length;
        else if (Array.isArray(value)) for (const part of value) size += part.length + 16;
      }
    }
  }
  return size;
}

const isEmpty = (programmes: Map<string, Programme[]>): boolean => [...programmes.values()].every((list) => !list.length);

// Empty is also how a guide still loading, or an error the addon hides, looks.
const ttlOf = (empties: number): number => (empties ? Math.min(READ_TTL_MS, EMPTY_TTL_MS * 2 ** (empties - 1)) : READ_TTL_MS);

function purge(state: State): void {
  for (const held of [state.reads, state.singles] as Array<LRUCache<string, GuidePage, any>>) {
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
      maxSize: MAX_HELD_BYTES,
      sizeCalculation: (page) => pageSize(page.programmes),
      ttl: READ_TTL_MS,
      allowStale: true,
      allowStaleOnFetchRejection: true,
      noDeleteOnFetchRejection: true,
      ...clock,
      fetchMethod: async (key, stale, { options, context }) => {
        const entries = await readPage(addon, context.base, context.catalog, { skip: context.skip, date: context.day });
        const programmes = new Map<string, Programme[]>();
        for (const entry of entries ?? []) {
          const meta = channelMetaOf(entry, context.catalog);
          if (meta) programmes.set(`${meta.type}|${meta.id}`, programmesOf(entry));
        }
        const empty = isEmpty(programmes);
        if (!entries || (empty && stale && !isEmpty(stale.programmes))) {
          failures.set(key, true);
          throw new Error('guide read failed');
        }
        const empties = empty ? (stale?.empties ?? 0) + 1 : 0;
        if (empty) options.ttl = ttlOf(empties);
        return { programmes, usedAt: addon.now(), empties };
      },
    });
    const singles = new LRUCache<string, GuidePage>({
      max: MAX_SINGLES,
      maxSize: MAX_SINGLES_BYTES,
      sizeCalculation: (page) => pageSize(page.programmes),
      ttl: READ_TTL_MS,
      ...clock,
    });
    const created: State = { id: ++serial, now: addon.now, reads, singles, failures };
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

function readDay(state: State, context: ReadContext, budget: ReadBudget): Promise<GuidePage | null> {
  const key = `${hash(context.base)}|${catalogKey(context.catalog)}|${context.skip}|${context.day}`;
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

/** The programmes of channels read by their ids, kept channel by channel. */
async function readChannels(
  state: State,
  addon: GuideAddon,
  { base, catalog, day }: IdContext,
  channels: ChannelMeta[],
  budget: ReadBudget
): Promise<GuidePage> {
  const scope = `${hash(base)}|${catalogKey(catalog)}|${day}`;
  const nameOf = (c: ChannelMeta) => `${c.type}|${c.id}`;
  const keyOf = (c: ChannelMeta) => `${scope}|${nameOf(c)}`;
  const heldOf = (c: ChannelMeta) => state.singles.peek(keyOf(c), { allowStale: true });

  const load = (wanted: ChannelMeta[]): Promise<void> => {
    const ids = [...new Set(wanted.map((c) => c.id))].sort();
    return shareInFlight(`guide:${state.id}|${scope}|${pagePath(catalog, { ids })}`, async () => {
      const entries = await readPage(addon, base, catalog, { ids, date: day });
      const read = new Map<string, Programme[]>();
      for (const entry of entries ?? []) {
        const meta = channelMetaOf(entry, catalog);
        if (meta) read.set(nameOf(meta), programmesOf(entry));
      }
      for (const channel of wanted) {
        const stale = heldOf(channel);
        const list = read.get(nameOf(channel)) ?? [];
        if (!entries || (!list.length && stale && !isEmpty(stale.programmes))) {
          state.failures.set(keyOf(channel), true);
          continue;
        }
        const empties = list.length ? 0 : (stale?.empties ?? 0) + 1;
        state.singles.set(keyOf(channel), { programmes: new Map([[nameOf(channel), list]]), usedAt: addon.now(), empties }, { ttl: ttlOf(empties) });
      }
    });
  };

  const due = channels.filter((c) => !state.failures.has(keyOf(c)) && state.singles.getRemainingTTL(keyOf(c)) <= 0);
  const serveStale = (c: ChannelMeta) => {
    const held = heldOf(c);
    return held !== undefined && !isEmpty(held.programmes);
  };
  const first = due.filter((c) => !serveStale(c));
  const later = due.filter(serveStale);
  if (first.length && spend(state, budget)) await load(first);
  if (later.length && spend(state, budget)) void load(later);

  const programmes = new Map<string, Programme[]>();
  for (const channel of channels) {
    const held = heldOf(channel);
    if (!held) continue;
    held.usedAt = state.now();
    for (const [name, list] of held.programmes) programmes.set(name, list);
  }
  return { programmes, usedAt: state.now(), empties: 0 };
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
  toMs: number
): Promise<Map<string, Programme[]>> {
  const state = stateFor(addon);
  const placements = await placementsFor(addon, base, catalogs, channels, { guideOnly: true });
  interface Group {
    catalog: LiveCatalog;
    skip?: number;
    channels: ChannelMeta[];
  }
  const groups = new Map<string, Group>();
  placements.forEach((placement) => {
    if (!placement || placement === GONE || !placement.catalog?.guide) return;
    const groupKey = `${catalogKey(placement.catalog)}|${placement.skip ?? 'ids'}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { catalog: placement.catalog, skip: placement.skip, channels: [] };
      groups.set(groupKey, group);
    }
    group.channels.push(placement.meta);
  });

  const now = state.now();
  const away = (day: string) => Math.abs(Date.parse(day) + DAY_MS / 2 - now);
  const days = daysOf(fromMs, toMs).sort((a, b) => away(a) - away(b));
  const batches = [...groups.values()].flatMap((group) =>
    group.skip === undefined ? chunksOf(group.channels, IDS_PER_READ).map((part) => ({ ...group, channels: part })) : [group]
  );
  const work: Array<{ group: Group; day: string }> = [];
  for (const day of days) for (const group of batches) work.push({ group, day });
  const budget: ReadBudget = { left: MAX_REQUEST_READS, until: now + REQUEST_READ_MS };
  const pages = await inBatches(
    work.map(({ group: { catalog, skip, channels: asked }, day }) => () =>
      skip === undefined ? readChannels(state, addon, { base, catalog, day }, asked, budget) : readDay(state, { base, catalog, skip, day }, budget)
    ),
    PARALLEL_READS
  );

  const found = new Map<string, Map<number, Programme>>();
  let rows = 0;
  pages.forEach((page, n) => {
    if (!page || rows >= MAX_PROGRAMMES) return;
    for (const meta of work[n].group.channels) {
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
  { t, i, at }: { t: string; i: string; at: number }
): Promise<ProgrammeTarget | null> {
  const placement = await placementFor(addon, base, catalogs, { type: t, id: i });
  if (!placement || placement === GONE) return null;
  const channel: ListedChannel = { meta: placement.meta, number: placement.number };
  const startMs = at * 1000;
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

export async function searchChannels(addon: GuideAddon, base: string, catalogs: LiveCatalog[], term: string, limit: number): Promise<ListedChannel[]> {
  const wanted = String(term ?? '').trim().toLowerCase();
  const terms = wordsOf(wanted);
  const until = addon.now() + SEARCH_WAIT_MS;
  const narrowed = narrowedTo(catalogs) !== undefined;

  const answered = new Set<string>();
  const found = (
    await Promise.all(
      wholeCatalogs(catalogs).filter((c) => c.search).map(async (catalog) => {
        const entries = await readPage(addon, base, catalog, { search: wanted });
        if (!entries) return [];
        answered.add(`${catalog.type}|${catalog.id}`);
        const metas = entries.map((entry) => channelMetaOf(entry, catalog)).filter((meta): meta is ChannelMeta => meta !== null);
        for (const meta of metas) rememberFound(addon, base, meta, catalog);
        return metas;
      })
    )
  ).flat();

  const hits = admitted(addon, base, catalogs, found);

  // A catalog without a search is read in full. Otherwise the list only adds to what the searches answered.
  // A search of the whole addon may be full of other groups' channels, so groups are matched by name as well.
  const unsearchable = catalogs.some((c) => !c.search);
  const answeredAll = !narrowed && catalogs.every((c) => answered.has(`${c.type}|${c.id}`)) && hits.every((meta) => meta.channelNumber !== undefined);
  const isNumber = (number: string | undefined) => number?.toLowerCase() === wanted;
  const settled = (entries: Placement[]) =>
    !/^\d\S*$/.test(wanted) || hits.some((meta) => isNumber(meta.channelNumber)) || entries.some((p) => isNumber(p.number));
  const scanned = await listPlacements(addon, base, catalogs, SEARCH_SCAN, (entries) =>
    !unsearchable && (addon.now() >= until || (answeredAll && settled(entries)))
  );
  const numbers = new Map(scanned.map((p) => [`${p.meta.type}|${p.meta.id}`, p.number]));
  const asked = hits.map((meta) => ({ meta, number: numbers.get(`${meta.type}|${meta.id}`) ?? meta.channelNumber }));
  const exactNumber = scanned
    .filter((p) => isNumber(p.number))
    .map((p) => ({ meta: p.meta, number: p.number }));
  const named = scanned
    .filter((p) => (narrowed || !answered.has(`${p.catalog?.type}|${p.catalog?.id}`)) && terms.length > 0 && terms.every((word) => p.meta.name.toLowerCase().includes(word)))
    .map((p) => ({ meta: p.meta, number: p.number }));

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
