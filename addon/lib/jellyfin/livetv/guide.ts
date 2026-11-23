// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { LRUCache } from 'lru-cache';
import { clockOptions, hash, type AddonDeps } from '../addonReader';
import { readPage, utcDay, type LiveCatalog } from './catalogs';
import { channelMetaOf, GONE, listPlacements, placementFor, type ChannelMeta, type ListedChannel } from './lineup';
import { flag, integer, listOf, timeOf, type Ask } from './query';

const READ_TTL_MS = 30 * 60 * 1000;
const FAILURE_MS = 30 * 1000;
const MAX_READS = 5000;
const PARALLEL_READS = 8;
const DAY_MS = 86400000;
const GUIDE_DAYS_AHEAD = 7;
const MAX_CATCHUP_DAYS = 14;
const MAX_PROGRAMMES = 2000;
const SEARCH_SCAN = 5000;

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
type GuidePage = Map<string, Programme[]>;

interface ReadContext {
  base: string;
  catalog: LiveCatalog;
  skip: number;
  day: string;
}

interface State {
  reads: LRUCache<string, GuidePage, ReadContext>;
  failures: LRUCache<string, true>;
}

const states = new WeakMap<object, State>();

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

function stateFor(addon: GuideAddon): State {
  let state = states.get(addon);
  if (!state) {
    const clock = clockOptions(addon.now);
    const failures = new LRUCache<string, true>({ max: MAX_READS, ttl: FAILURE_MS, ...clock });
    const reads = new LRUCache<string, GuidePage, ReadContext>({
      max: MAX_READS,
      ttl: READ_TTL_MS,
      allowStale: true,
      allowStaleOnFetchRejection: true,
      noDeleteOnFetchRejection: true,
      ...clock,
      fetchMethod: async (key, _stale, { context }) => {
        const entries = await readPage(addon, context.base, context.catalog, { skip: context.skip, date: context.day });
        if (!entries) {
          failures.set(key, true);
          throw new Error('guide read failed');
        }
        const page: GuidePage = new Map();
        for (const entry of entries) {
          const meta = channelMetaOf(entry, context.catalog);
          if (meta) page.set(`${meta.type}|${meta.id}`, programmesOf(entry));
        }
        return page;
      },
    });
    state = { reads, failures };
    states.set(addon, state);
  }
  return state;
}

function readDay(state: State, context: ReadContext): Promise<GuidePage | null> {
  const key = `${hash(context.base)}|${context.catalog.type}|${context.catalog.id}|${context.skip}|${context.day}`;
  const held = state.reads.peek(key, { allowStale: true });
  if (state.failures.has(key)) return Promise.resolve(held ?? null);
  return state.reads.fetch(key, { context }).then(
    (page) => page ?? null,
    () => null
  );
}

async function inBatches<T>(tasks: Array<() => Promise<T>>, size: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const at = next++;
      results[at] = await tasks[at]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker));
  return results;
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
  const placements = await Promise.all(channels.map((channel) => placementFor(addon, base, catalogs, channel)));
  const groups = new Map<string, { catalog: LiveCatalog; skip: number; keys: string[] }>();
  placements.forEach((placement) => {
    if (!placement || typeof placement !== 'object' || !placement.catalog?.guide) return;
    const groupKey = `${placement.catalog.type}|${placement.catalog.id}|${placement.skip ?? 0}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { catalog: placement.catalog, skip: placement.skip ?? 0, keys: [] };
      groups.set(groupKey, group);
    }
    group.keys.push(`${placement.meta.type}|${placement.meta.id}`);
  });

  const days = daysOf(fromMs, toMs);
  const work: Array<{ group: { catalog: LiveCatalog; skip: number; keys: string[] }; day: string }> = [];
  for (const group of groups.values()) for (const day of days) work.push({ group, day });
  const pages = await inBatches(
    work.map(({ group, day }) => () => readDay(state, { base, catalog: group.catalog, skip: group.skip, day })),
    PARALLEL_READS
  );

  const found = new Map<string, Map<number, Programme>>();
  pages.forEach((page, n) => {
    if (!page) return;
    for (const key of work[n].group.keys) {
      for (const programme of page.get(key) ?? []) {
        if (programme.start >= toMs || programme.end <= fromMs) continue;
        let byStart = found.get(key);
        if (!byStart) {
          byStart = new Map();
          found.set(key, byStart);
        }
        if (!byStart.has(programme.start)) byStart.set(programme.start, programme);
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
      ? a.programme.title.localeCompare(b.programme.title) || a.programme.start - b.programme.start
      : a.programme.start - b.programme.start || a.programme.title.localeCompare(b.programme.title)
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
  const found = await programmesFor(addon, base, catalogs, [{ type: t, id: i }], startMs, startMs + 1000);
  const programme = (found.get(`${placement.meta.type}|${placement.meta.id}`) ?? []).find((p) => Math.floor(p.start / 1000) === at);
  if (programme && caughtUp(placement.meta, programme.start, addon.now())) {
    return { channel, programme, live: false, streamId: programme.id, runtimeMs: programme.end - programme.start };
  }
  return { channel, programme, live: true, streamId: placement.meta.id };
}

export async function searchChannels(addon: GuideAddon, base: string, catalogs: LiveCatalog[], term: string, limit: number): Promise<ListedChannel[]> {
  const wanted = String(term ?? '').trim().toLowerCase();
  const terms = wordsOf(wanted);
  const scanned = await listPlacements(addon, base, catalogs, SEARCH_SCAN);
  const numbers = new Map(scanned.map((p) => [`${p.meta.type}|${p.meta.id}`, p.number]));

  const asked = await Promise.all(
    catalogs.filter((c) => c.search).map(async (catalog) => {
      const entries = (await readPage(addon, base, catalog, { search: wanted })) ?? [];
      return entries
        .map((entry) => channelMetaOf(entry, catalog))
        .filter((meta): meta is ChannelMeta => meta !== null)
        .map((meta) => ({ meta, number: numbers.get(`${meta.type}|${meta.id}`) ?? meta.channelNumber }));
    })
  );
  const exactNumber = scanned
    .filter((p) => p.number !== undefined && p.number.toLowerCase() === wanted)
    .map((p) => ({ meta: p.meta, number: p.number }));
  const named = scanned
    .filter((p) => !p.catalog?.search && terms.length > 0 && terms.every((word) => p.meta.name.toLowerCase().includes(word)))
    .map((p) => ({ meta: p.meta, number: p.number }));

  const seen = new Set<string>();
  const all = [...exactNumber, ...asked.flat(), ...named].filter((c) => {
    const key = `${c.meta.type}|${c.meta.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const exact = all.filter((c) => c.number !== undefined && c.number.toLowerCase() === wanted);
  return [...exact, ...all.filter((c) => !exact.includes(c))].slice(0, limit);
}
