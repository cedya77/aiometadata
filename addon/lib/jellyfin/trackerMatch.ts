import { LRUCache } from 'lru-cache';
import { parseStremioId } from './idsCodec';
import { videoIdAliases } from './aliases';

const database: any = require('../database');

export const MATCH_SERVICES = new Set(['simkl', 'mdblist', 'publicmetadb']);

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
  episodes: Array<{ number: number; title: string | null; airedAt: number | null; sends?: EpisodeRef }>;
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
  const ids = match.target?.ids ?? {};
  if (service !== 'publicmetadb' || !ids.tmdb || ids.imdb) return;
  const { movieExternalIds, tvExternalIds } = require('../getTmdb');
  const external = await (match.kind === 'movie' ? movieExternalIds : tvExternalIds)(String(ids.tmdb), {}).catch(() => null);
  const out: string[] = [];
  if (/^tt\d+$/.test(String(external?.imdb_id ?? ''))) out.push(String(external.imdb_id));
  if (!ids.tvdb && Number(external?.tvdb_id) > 0) out.push(`tvdb:${Number(external.tvdb_id)}`);
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
  if (!userUUID || !MATCH_SERVICES.has(service)) return null;
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
  if (!userUUID || !MATCH_SERVICES.has(service)) return out;
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
  if (!MATCH_SERVICES.has(service)) return out;
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
    for (const ours of ourEpisodes(match, parsed.season ?? 1, parsed.episode)) out.push(...(await ourSpelled(match, ours)));
  }
  return out;
}

const simklPoster = (poster: unknown): string | null => (poster ? `https://wsrv.nl/?url=https://simkl.in/posters/${poster}_m.webp&q=90` : null);

async function simklToken(credential: string): Promise<string | null> {
  const { getSimklToken } = require('../../utils/simklUtils');
  return (await getSimklToken(credential).catch(() => null))?.access_token ?? null;
}

export async function searchTargets(service: string, credential: string, query: string, kind: 'movie' | 'series', config: any = {}): Promise<MatchCandidate[]> {
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
      posterUrl: /^tt\d+$/.test(String(item.ids?.imdbid ?? '')) ? `https://images.metahub.space/poster/small/${item.ids.imdbid}/img` : null,
      kind: item.type === 'movie' ? 'movie' : 'tv',
      episodes: null,
    })).filter((item: MatchCandidate) => Object.keys(item.ids).length > 0);
  }
  if (service === 'publicmetadb') {
    const { searchMovie, searchTv } = require('../getTmdb');
    const found = await (kind === 'movie' ? searchMovie : searchTv)({ query, language: 'en-US' }, config).catch(() => null);
    return (Array.isArray(found?.results) ? found.results : [])
      .filter((item: any) => Number(item?.id) > 0)
      .slice(0, 20)
      .map((item: any) => ({
        ids: { tmdb: Number(item.id) },
        title: String(item.title ?? item.name ?? ''),
        year: Number(String(item.release_date ?? item.first_air_date ?? '').slice(0, 4)) || null,
        posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w185${item.poster_path}` : null,
        kind: kind === 'movie' ? 'movie' : 'tv',
        episodes: null,
      }));
  }
  return [];
}

async function tmdbSeasons(tmdb: number, config: any): Promise<TargetSeason[]> {
  const { tvInfo, seasonInfo } = require('../getTmdb');
  const show = await tvInfo({ id: tmdb, language: 'en-US' }, config).catch(() => null);
  const numbers: number[] = (Array.isArray(show?.seasons) ? show.seasons : [])
    .map((season: any) => Number(season?.season_number))
    .filter((number: number) => Number.isInteger(number) && number >= 0)
    .sort((a: number, b: number) => (a === 0 ? 1 : b === 0 ? -1 : a - b))
    .slice(0, 40);
  return Promise.all(numbers.map(async (number) => {
    const detail = await seasonInfo({ id: tmdb, season_number: number, language: 'en-US' }, config).catch(() => null);
    return {
      number,
      episodes: (Array.isArray(detail?.episodes) ? detail.episodes : []).map((episode: any) => ({
        number: Number(episode.episode_number),
        title: episode.name ? String(episode.name) : null,
        airedAt: Date.parse(episode.air_date ?? '') || null,
      })),
    };
  }));
}

export async function targetDetail(service: string, credential: string, candidate: MatchCandidate, config: any): Promise<{ ids: Record<string, string | number>; seasons: TargetSeason[]; tvdbSeasons?: TargetSeason[]; tvdbDefault?: boolean }> {
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
    const { mdblistTvdbEpisodes } = require('../../utils/mdbList');
    const [seasons, map] = await Promise.all([
      tmdbSeasons(Number(ids.tmdb), config),
      credential ? mdblistTvdbEpisodes(Number(ids.tmdb), credential).catch(() => null) : null,
    ]);
    if (!map) return { ids, seasons };
    const known = new Map(seasons.flatMap((season) => season.episodes.map((episode) => [`${season.number}:${episode.number}`, episode] as const)));
    const tvdb = new Map<number, TargetSeason>();
    for (const entry of map.episodes) {
      if (entry.showTmdb) continue;
      const episode = known.get(`${entry.tmdbSeason}:${entry.tmdbEpisode}`);
      if (!episode) continue;
      const season = tvdb.get(entry.season) ?? { number: entry.season, episodes: [] };
      if (season.episodes.some((listed) => listed.number === entry.episode)) continue;
      season.episodes.push({ number: entry.episode, title: episode.title, airedAt: episode.airedAt, sends: { season: entry.tmdbSeason, episode: entry.tmdbEpisode } });
      tvdb.set(entry.season, season);
    }
    for (const season of tvdb.values()) season.episodes.sort((a, b) => a.number - b.number);
    const tvdbSeasons = [...tvdb.values()].sort((a, b) => (a.number === 0 ? 1 : b.number === 0 ? -1 : a.number - b.number));
    return tvdbSeasons.length ? { ids, seasons, tvdbSeasons, tvdbDefault: map.tvdbDefault } : { ids, seasons };
  }
  if (service === 'publicmetadb') {
    const ids = { ...candidate.ids };
    if (!ids.tmdb) return { ids, seasons: [] };
    const { movieExternalIds, tvExternalIds } = require('../getTmdb');
    const movie = candidate.kind === 'movie';
    const [external, seasons] = await Promise.all([
      (movie ? movieExternalIds : tvExternalIds)(String(ids.tmdb), config).catch(() => null),
      movie ? [] : tmdbSeasons(Number(ids.tmdb), config),
    ]);
    if (/^tt\d+$/.test(String(external?.imdb_id ?? ''))) ids.imdb = String(external.imdb_id);
    if (Number(external?.tvdb_id) > 0) ids.tvdb = Number(external.tvdb_id);
    return { ids, seasons };
  }
  return { ids: { ...candidate.ids }, seasons: [] };
}
