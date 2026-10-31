import { LRUCache } from 'lru-cache';
import { parseStremioId } from './idsCodec';
import { videoIdAliases } from './aliases';
import { isMatchable as matchable, trackerOf } from '../trackers';
import type { EpisodeRef, MatchCandidate, MatchDetail, TargetSeason } from '../trackers/match';

const database: any = require('../database');

export type { EpisodeRef, MatchCandidate, MatchDetail, TargetSeason } from '../trackers/match';


export interface SeasonLink {
  season: number;
  offset: number;
}

export interface MatchTarget {
  ids: Record<string, string | number>;
  title: string;
  year: number | null;
  posterUrl: string | null;
  kind: string;
}

export interface TrackerMatch {
  group: string;
  bases: string[];
  kind: 'movie' | 'series';
  title: string | null;
  open: { id: string; type: 'movie' | 'series' } | null;
  target: MatchTarget;
  seasons: Record<string, SeasonLink>;
  episodes?: Record<string, EpisodeRef | null>;
  updatedAt: number;
}

interface Index {
  byBase: Map<string, TrackerMatch>;
  byTheirs: Map<string, TrackerMatch[]>;
}

const indexes = new LRUCache<string, Index>({ max: 500, ttl: 10 * 60 * 1000 });
const epochs = new Map<string, number>();

function theirBases(target: MatchTarget): string[] {
  const out: string[] = [];
  if (target.ids.imdb) out.push(String(target.ids.imdb));
  if (target.ids.tvdb) out.push(`tvdb:${target.ids.tvdb}`);
  if (target.ids.tmdb) out.push(`tmdb:${target.ids.tmdb}`);
  return out;
}

const spelledToo = new WeakMap<TrackerMatch, string[]>();

export function matchBases(match: TrackerMatch): string[] {
  return [...new Set([...theirBases(match.target), ...(spelledToo.get(match) ?? [])])];
}

async function noteSpellings(service: string, match: TrackerMatch): Promise<void> {
  const spellings = trackerOf(service)?.match?.spellings;
  const out = spellings ? await spellings(match.target?.ids ?? {}, match.kind) : [];
  if (out.length) spelledToo.set(match, out);
}

async function indexFor(userUUID: string, service: string): Promise<Index> {
  const key = `${userUUID}|${service}`;
  const held = indexes.get(key);
  if (held) return held;
  const epoch = epochs.get(key) ?? 0;
  const index: Index = { byBase: new Map(), byTheirs: new Map() };
  const groups = new Map<string, TrackerMatch>();
  for (const row of await database.listTrackerMatches(userUUID, service).catch(() => [])) {
    let match = groups.get(String(row.match_group));
    if (!match) {
      try {
        match = JSON.parse(String(row.data)) as TrackerMatch;
      } catch {
        continue;
      }
      groups.set(String(row.match_group), match);
      await noteSpellings(service, match);
      for (const base of matchBases(match)) index.byTheirs.set(base, [...(index.byTheirs.get(base) ?? []), match]);
    }
    index.byBase.set(String(row.base), match);
  }
  // A build that read the rows before a change is not kept.
  if ((epochs.get(key) ?? 0) === epoch) indexes.set(key, index);
  return index;
}

/** Matches written outside saveMatch and removeMatch are read again. */
export function forgetMatches(userUUID: string, service: string): void {
  const key = `${userUUID}|${service}`;
  epochs.set(key, (epochs.get(key) ?? 0) + 1);
  indexes.delete(key);
}

export async function listMatches(userUUID: string, service: string): Promise<TrackerMatch[]> {
  return [...new Set((await indexFor(userUUID, service)).byBase.values())];
}

export async function matchFor(userUUID: string | undefined, service: string, base: string): Promise<TrackerMatch | null> {
  if (!userUUID || !matchable(service)) return null;
  return (await indexFor(userUUID, service)).byBase.get(base) ?? null;
}

export async function saveMatch(userUUID: string, service: string, match: Omit<TrackerMatch, 'group' | 'updatedAt'>): Promise<TrackerMatch> {
  const bases = [...new Set(match.bases)];
  const saved: TrackerMatch = { ...match, bases, group: bases[0], updatedAt: Date.now() };
  // A match made earlier for any of these ids is replaced whole, or its other ids would keep the old target.
  const replaced = new Set<string>(((await database.listTrackerMatches(userUUID, service)) as any[]).filter((row) => bases.includes(String(row.base))).map((row) => String(row.match_group)));
  for (const group of replaced) await database.deleteTrackerMatch(userUUID, service, group);
  await database.saveTrackerMatch(userUUID, service, saved.group, bases, JSON.stringify(saved));
  forgetMatches(userUUID, service);
  return saved;
}

export async function removeMatch(userUUID: string, service: string, group: string): Promise<void> {
  await database.deleteTrackerMatch(userUUID, service, group);
  forgetMatches(userUUID, service);
}

interface EpisodeLookup {
  forward: Map<string, EpisodeRef | null>;
  covered: Set<string>;
  reverse: Map<string, EpisodeRef[]>;
}

const lookups = new WeakMap<TrackerMatch, EpisodeLookup>();
const refKey = (season: number, episode: number) => `${season}:${episode}`;

function lookupOf(match: TrackerMatch): EpisodeLookup {
  const held = lookups.get(match);
  if (held) return held;
  const lookup: EpisodeLookup = { forward: new Map(), covered: new Set(), reverse: new Map() };
  const entries = Object.entries(match.episodes ?? {})
    .map(([key, theirs]) => {
      const [season, episode] = key.split(':').map(Number);
      return { key, season, episode, theirs };
    })
    .filter((entry) => Number.isInteger(entry.season) && Number.isInteger(entry.episode))
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  const claimed = new Set<string>();
  for (const entry of entries) {
    lookup.forward.set(entry.key, entry.theirs);
    if (!entry.theirs) continue;
    const theirs = refKey(entry.theirs.season, entry.theirs.episode);
    if (claimed.has(theirs)) lookup.covered.add(entry.key);
    claimed.add(theirs);
    lookup.reverse.set(theirs, [...(lookup.reverse.get(theirs) ?? []), { season: entry.season, episode: entry.episode }]);
  }
  lookups.set(match, lookup);
  return lookup;
}

export function theirEpisode(match: TrackerMatch, season: number, episode: number): EpisodeRef | null {
  const lookup = lookupOf(match);
  const key = refKey(season, episode);
  if (lookup.forward.has(key)) return lookup.forward.get(key) ?? null;
  const link = match.seasons[String(season)];
  // A match is planned for the regular seasons; specials are not the target's specials.
  if (!link && season === 0) return null;
  const number = episode + (link?.offset ?? 0);
  return number >= 1 ? { season: link ? link.season : season, episode: number } : null;
}

export function sendsNothing(match: TrackerMatch, season: number, episode: number): boolean {
  const lookup = lookupOf(match);
  const key = refKey(season, episode);
  return lookup.covered.has(key) || (lookup.forward.has(key) && !lookup.forward.get(key));
}

function linkedEpisode(match: TrackerMatch, season: number, episode: number): EpisodeRef | null {
  const links = Object.entries(match.seasons)
    .filter(([, link]) => link.season === season)
    .map(([ours, link]) => ({ season: Number(ours), offset: link.offset }));
  if (!links.length) return match.seasons[String(season)] || season === 0 ? null : { season, episode };
  const best = links.filter((link) => episode - link.offset >= 1).sort((a, b) => b.offset - a.offset)[0];
  return best ? { season: best.season, episode: episode - best.offset } : null;
}

export function ourEpisodes(match: TrackerMatch, season: number, episode: number): EpisodeRef[] {
  const lookup = lookupOf(match);
  const listed = lookup.reverse.get(refKey(season, episode));
  if (listed?.length) return listed;
  const linked = linkedEpisode(match, season, episode);
  return linked && !lookup.forward.has(refKey(linked.season, linked.episode)) ? [linked] : [];
}

const ANIME_SCHEME = /^(kitsu|mal|anilist|anidb):/;

const spelled = (base: string, season: number, episode: number) => (ANIME_SCHEME.test(base) ? `${base}:${episode}` : `${base}:${season}:${episode}`);

const openedBase = (match: TrackerMatch): string | null => (match.open ? parseStremioId(match.open.id)?.base ?? null : null);

const sameNumbering = (a: string, b: string) => ANIME_SCHEME.test(a) === ANIME_SCHEME.test(b);

// A match numbers episodes as the title it was made on lists them, so another spelling of that title is renumbered into it first.
async function asOpened(match: TrackerMatch, base: string, season: number, episode: number): Promise<EpisodeRef | null> {
  const opened = openedBase(match);
  if (!opened || opened === base) return { season, episode };
  for (const alias of await videoIdAliases(spelled(base, season, episode)).catch(() => [] as string[])) {
    const parsed = parseStremioId(alias);
    if (parsed?.base === opened && parsed.episode !== null && parsed.episode !== undefined) return { season: parsed.season ?? 1, episode: parsed.episode };
  }
  return sameNumbering(base, opened) ? { season, episode } : null;
}

async function ourSpelled(match: TrackerMatch, ours: EpisodeRef): Promise<string[]> {
  const opened = openedBase(match);
  const aliases = opened ? await videoIdAliases(spelled(opened, ours.season, ours.episode)).catch(() => [] as string[]) : [];
  return match.bases.flatMap((base) =>
    !opened || base === opened || sameNumbering(base, opened) ? [spelled(base, ours.season, ours.episode)] : aliases.filter((alias) => parseStremioId(alias)?.base === base)
  );
}

export async function matchedTarget(userUUID: string | undefined, service: string, base: string, season?: number, episode?: number): Promise<{ ids: Record<string, string | number>; season?: number; episode?: number; unsent?: true } | null> {
  const match = await matchFor(userUUID, service, base);
  if (!match) return null;
  if (match.kind === 'movie' || episode === undefined || episode === null) return { ids: { ...match.target.ids } };
  const ours = await asOpened(match, base, season ?? 1, episode);
  if (!ours) return null;
  if (sendsNothing(match, ours.season, ours.episode)) return { ids: { ...match.target.ids }, unsent: true };
  const theirs = theirEpisode(match, ours.season, ours.episode);
  return theirs ? { ids: { ...match.target.ids }, ...theirs } : null;
}

export async function unsentAmong(userUUID: string | undefined, service: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!userUUID || !matchable(service)) return out;
  const index = await indexFor(userUUID, service);
  if (!index.byBase.size) return out;
  for (const id of ids) {
    const parsed = parseStremioId(id);
    const match = parsed ? index.byBase.get(parsed.base) : null;
    if (!parsed || !match || parsed.episode === null || parsed.episode === undefined) continue;
    const ours = await asOpened(match, parsed.base, parsed.season ?? 1, parsed.episode);
    if (ours && sendsNothing(match, ours.season, ours.episode)) out.add(id);
  }
  return out;
}

export async function theirSpellings(userUUID: string, service: string, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!matchable(service)) return out;
  const index = await indexFor(userUUID, service);
  if (!index.byBase.size) return out;
  for (const id of ids) {
    const parsed = parseStremioId(id);
    const match = parsed ? index.byBase.get(parsed.base) : null;
    if (!parsed || !match) continue;
    const bases = matchBases(match);
    if (parsed.episode === null || parsed.episode === undefined) {
      out.set(id, bases);
      continue;
    }
    const ours = await asOpened(match, parsed.base, parsed.season ?? 1, parsed.episode);
    const theirs = ours ? theirEpisode(match, ours.season, ours.episode) : null;
    if (theirs) out.set(id, bases.map((base) => `${base}:${theirs.season}:${theirs.episode}`));
  }
  return out;
}

export async function ourSpellings(userUUID: string, service: string, id: string): Promise<string[]> {
  if (!matchable(service)) return [];
  const index = await indexFor(userUUID, service);
  if (!index.byTheirs.size) return [];
  const parsed = parseStremioId(id);
  const matches = parsed ? index.byTheirs.get(parsed.base) : null;
  if (!parsed || !matches?.length) return [];
  const out: string[] = [];
  for (const match of matches) {
    if (parsed.episode === null || parsed.episode === undefined) {
      if (match.kind === 'movie') out.push(...match.bases);
      continue;
    }
    for (const ours of ourEpisodes(match, parsed.season ?? 1, parsed.episode)) out.push(...(await ourSpelled(match, ours)));
  }
  return out;
}

export async function searchTargets(service: string, credential: string, query: string, kind: 'movie' | 'series', config: any = {}): Promise<MatchCandidate[]> {
  const match = trackerOf(service)?.match;
  return match ? match.search(credential, query, kind, config) : [];
}

export async function targetDetail(service: string, credential: string, candidate: MatchCandidate, config: any): Promise<MatchDetail> {
  const match = trackerOf(service)?.match;
  return match ? match.detail(credential, candidate, config) : { ids: { ...candidate.ids }, seasons: [] };
}
