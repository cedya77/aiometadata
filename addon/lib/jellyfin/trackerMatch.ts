import { LRUCache } from 'lru-cache';
import { parseStremioId } from './idsCodec';

const database: any = require('../database');

export const MATCH_SERVICES = new Set(['simkl', 'mdblist']);

export interface SeasonLink {
  season: number;
  offset: number;
}

export interface EpisodeRef {
  season: number;
  episode: number;
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

export interface MatchCandidate {
  ids: Record<string, string | number>;
  title: string;
  year: number | null;
  posterUrl: string | null;
  kind: string;
  episodes: number | null;
}

export interface TargetSeason {
  number: number;
  episodes: Array<{ number: number; title: string | null; airedAt: number | null }>;
}

interface Index {
  byBase: Map<string, TrackerMatch>;
  byTheirs: Map<string, TrackerMatch[]>;
}

const indexes = new LRUCache<string, Index>({ max: 500, ttl: 10 * 60 * 1000 });

function theirBases(target: MatchTarget): string[] {
  const out: string[] = [];
  if (target.ids.imdb) out.push(String(target.ids.imdb));
  if (target.ids.tvdb) out.push(`tvdb:${target.ids.tvdb}`);
  if (target.ids.tmdb) out.push(`tmdb:${target.ids.tmdb}`);
  return out;
}

async function indexFor(userUUID: string, service: string): Promise<Index> {
  const key = `${userUUID}|${service}`;
  const held = indexes.get(key);
  if (held) return held;
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
      for (const base of theirBases(match.target)) index.byTheirs.set(base, [...(index.byTheirs.get(base) ?? []), match]);
    }
    index.byBase.set(String(row.base), match);
  }
  indexes.set(key, index);
  return index;
}

export async function listMatches(userUUID: string, service: string): Promise<TrackerMatch[]> {
  return [...new Set((await indexFor(userUUID, service)).byBase.values())];
}

export async function matchFor(userUUID: string | undefined, service: string, base: string): Promise<TrackerMatch | null> {
  if (!userUUID || !MATCH_SERVICES.has(service)) return null;
  return (await indexFor(userUUID, service)).byBase.get(base) ?? null;
}

export async function saveMatch(userUUID: string, service: string, match: Omit<TrackerMatch, 'group' | 'updatedAt'>): Promise<TrackerMatch> {
  const bases = [...new Set(match.bases)];
  const saved: TrackerMatch = { ...match, bases, group: bases[0], updatedAt: Date.now() };
  await database.saveTrackerMatch(userUUID, service, saved.group, bases, JSON.stringify(saved));
  indexes.delete(`${userUUID}|${service}`);
  return saved;
}

export async function removeMatch(userUUID: string, service: string, group: string): Promise<void> {
  await database.deleteTrackerMatch(userUUID, service, group);
  indexes.delete(`${userUUID}|${service}`);
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
  if (!links.length) return match.seasons[String(season)] ? null : { season, episode };
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

export async function matchedTarget(userUUID: string | undefined, service: string, base: string, season?: number, episode?: number): Promise<{ ids: Record<string, string | number>; season?: number; episode?: number; unsent?: true } | null> {
  const match = await matchFor(userUUID, service, base);
  if (!match) return null;
  if (match.kind === 'movie' || episode === undefined || episode === null) return { ids: { ...match.target.ids } };
  if (sendsNothing(match, season ?? 1, episode)) return { ids: { ...match.target.ids }, unsent: true };
  const theirs = theirEpisode(match, season ?? 1, episode);
  return theirs ? { ids: { ...match.target.ids }, ...theirs } : null;
}

export async function unsentAmong(userUUID: string | undefined, service: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!userUUID || !MATCH_SERVICES.has(service)) return out;
  const index = await indexFor(userUUID, service);
  if (!index.byBase.size) return out;
  for (const id of ids) {
    const parsed = parseStremioId(id);
    const match = parsed ? index.byBase.get(parsed.base) : null;
    if (parsed && match && parsed.episode !== null && parsed.episode !== undefined && sendsNothing(match, parsed.season ?? 1, parsed.episode)) out.add(id);
  }
  return out;
}

export async function theirSpellings(userUUID: string, service: string, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!MATCH_SERVICES.has(service)) return out;
  const index = await indexFor(userUUID, service);
  if (!index.byBase.size) return out;
  for (const id of ids) {
    const parsed = parseStremioId(id);
    const match = parsed ? index.byBase.get(parsed.base) : null;
    if (!parsed || !match) continue;
    const bases = theirBases(match.target);
    if (parsed.episode === null || parsed.episode === undefined) {
      out.set(id, bases);
      continue;
    }
    const theirs = theirEpisode(match, parsed.season ?? 1, parsed.episode);
    if (theirs) out.set(id, bases.map((base) => `${base}:${theirs.season}:${theirs.episode}`));
  }
  return out;
}

export async function ourSpellings(userUUID: string, service: string, id: string): Promise<string[]> {
  if (!MATCH_SERVICES.has(service)) return [];
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
    for (const ours of ourEpisodes(match, parsed.season ?? 1, parsed.episode)) out.push(...match.bases.map((base) => `${base}:${ours.season}:${ours.episode}`));
  }
  return out;
}

const simklPoster = (poster: unknown): string | null => (poster ? `https://wsrv.nl/?url=https://simkl.in/posters/${poster}_m.webp&q=90` : null);

async function simklToken(credential: string): Promise<string | null> {
  const { getSimklToken } = require('../../utils/simklUtils');
  return (await getSimklToken(credential).catch(() => null))?.access_token ?? null;
}

export async function searchTargets(service: string, credential: string, query: string, kind: 'movie' | 'series'): Promise<MatchCandidate[]> {
  if (service === 'simkl') {
    const { fetchSimklSearchItems } = require('../../utils/simklUtils');
    const token = await simklToken(credential);
    const types: Array<'movie' | 'tv' | 'anime'> = kind === 'movie' ? ['movie', 'anime'] : ['tv', 'anime'];
    const found = (await Promise.all(types.map((type) => fetchSimklSearchItems(type, query, 10, 1, token).catch(() => [])))).flat();
    return found
      .filter((item: any) => item?.ids?.simkl_id ?? item?.ids?.simkl)
      .map((item: any) => ({
        ids: { simkl: Number(item.ids.simkl_id ?? item.ids.simkl), ...(item.ids.tmdb ? { tmdb: Number(item.ids.tmdb) } : {}) },
        title: String(item.title_en || item.title || ''),
        year: Number(item.year) || null,
        posterUrl: simklPoster(item.poster),
        kind: item.endpoint_type === 'anime' ? 'anime' : item.endpoint_type === 'movies' ? 'movie' : 'tv',
        episodes: Number(item.ep_count) || null,
      }));
  }
  if (service === 'mdblist') {
    const { fetchMdbListSearchItems } = require('../../utils/mdbList');
    const found: any[] = await fetchMdbListSearchItems(query, kind === 'movie' ? 'movie' : 'show', credential).catch(() => []);
    return found.map((item: any) => ({
      ids: {
        ...(item.ids?.imdbid ? { imdb: String(item.ids.imdbid) } : {}),
        ...(item.ids?.tmdbid ? { tmdb: Number(item.ids.tmdbid) } : {}),
        ...(item.ids?.tvdbid ? { tvdb: Number(item.ids.tvdbid) } : {}),
      },
      title: String(item.title ?? ''),
      year: Number(item.year) || null,
      posterUrl: null,
      kind: item.type === 'movie' ? 'movie' : 'tv',
      episodes: null,
    })).filter((item: MatchCandidate) => Object.keys(item.ids).length > 0);
  }
  return [];
}

export async function targetDetail(service: string, credential: string, candidate: MatchCandidate, config: any): Promise<{ ids: Record<string, string | number>; seasons: TargetSeason[] }> {
  if (service === 'simkl') {
    const { fetchSimklItemDetail, makeAuthenticatedSimklRequest } = require('../../utils/simklUtils');
    const token = await simklToken(credential);
    const simkl = Number(candidate.ids.simkl);
    const segment = candidate.kind === 'anime' ? 'anime' : candidate.kind === 'movie' ? 'movie' : 'tv';
    const detail = await fetchSimklItemDetail(segment, simkl, token).catch(() => null);
    const ids: Record<string, string | number> = { simkl };
    if (detail?.ids?.imdb) ids.imdb = String(detail.ids.imdb);
    if (detail?.ids?.tvdb) ids.tvdb = Number(detail.ids.tvdb);
    if (detail?.ids?.tmdb ?? candidate.ids.tmdb) ids.tmdb = Number(detail?.ids?.tmdb ?? candidate.ids.tmdb);
    if (candidate.kind === 'movie') return { ids, seasons: [] };
    const response = await makeAuthenticatedSimklRequest(`https://api.simkl.com/${segment === 'anime' ? 'anime' : 'tv'}/episodes/${simkl}`, token, `Simkl episodes (${simkl})`, 'GET', undefined, 15000).catch(() => null);
    const seasons = new Map<number, TargetSeason>();
    for (const entry of Array.isArray(response?.data) ? response.data : []) {
      if (entry?.type !== 'episode' || !Number.isFinite(Number(entry.episode))) continue;
      const number = segment === 'anime' ? 1 : Number(entry.season);
      if (!Number.isFinite(number)) continue;
      const season = seasons.get(number) ?? { number, episodes: [] };
      season.episodes.push({ number: Number(entry.episode), title: entry.title ? String(entry.title) : null, airedAt: Date.parse(entry.date ?? '') || null });
      seasons.set(number, season);
    }
    return { ids, seasons: [...seasons.values()].sort((a, b) => a.number - b.number) };
  }
  if (service === 'mdblist') {
    const ids = { ...candidate.ids };
    if (candidate.kind === 'movie' || !ids.tmdb) return { ids, seasons: [] };
    const { tvInfo, seasonInfo } = require('../getTmdb');
    const show = await tvInfo({ id: ids.tmdb, language: 'en-US' }, config).catch(() => null);
    const numbers: number[] = (Array.isArray(show?.seasons) ? show.seasons : [])
      .map((season: any) => Number(season?.season_number))
      .filter((number: number) => Number.isFinite(number) && number > 0)
      .slice(0, 40);
    const seasons = await Promise.all(numbers.map(async (number) => {
      const detail = await seasonInfo({ id: ids.tmdb, season_number: number, language: 'en-US' }, config).catch(() => null);
      return {
        number,
        episodes: (Array.isArray(detail?.episodes) ? detail.episodes : []).map((episode: any) => ({
          number: Number(episode.episode_number),
          title: episode.name ? String(episode.name) : null,
          airedAt: Date.parse(episode.air_date ?? '') || null,
        })),
      };
    }));
    return { ids, seasons };
  }
  return { ids: { ...candidate.ids }, seasons: [] };
}
