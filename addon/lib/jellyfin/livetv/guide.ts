// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { LRUCache } from 'lru-cache';
import { clockOptions, hash, type AddonDeps } from '../addonReader';
import { readPage, utcDay, type LiveCatalog } from './catalogs';
import { channelMetaOf, placementFor } from './lineup';

const READ_TTL_MS = 30 * 60 * 1000;
const FAILURE_MS = 30 * 1000;
const MAX_READS = 5000;
const PARALLEL_READS = 8;
const DAY_MS = 86400000;

export interface Programme {
  id: string;
  title: string;
  start: number;
  end: number;
  overview?: string;
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

function timeOf(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
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
