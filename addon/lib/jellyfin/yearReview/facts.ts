import { envInt } from '../../../utils/envNumber';
import { mapWithConcurrency } from '../../../utils/concurrency';
import { fetchMetaBeforeArt, originalLanguage, parseRuntimeTicks } from '../items';
import type { YearPlay } from './plays';

export interface TitleFacts {
  id: string;
  kind: 'movie' | 'series';
  name: string;
  year: number | null;
  poster: string | null;
  background: string | null;
  logo: string | null;
  genres: string[];
  countries: string[];
  networks: string[];
  studios: string[];
  language: string | null;
  status: string | null;
  anime: boolean;
  runtimeMs: number;
  episodeRuntimes: Record<string, number>;
  episodeCount: number;
  ids: Record<string, string>;
  source: 'cache' | 'built';
}

const PER_ENTRY_ANIME = /^(kitsu|mal|anilist|anidb):/i;
const ANIME_SPELLING = /^(kitsu|mal|anilist|anidb):/i;

export function runtimeMsOf(runtime: unknown): number {
  if (typeof runtime === 'number' && Number.isFinite(runtime) && runtime > 0) return Math.round(runtime * 60_000);
  return Math.round((parseRuntimeTicks(runtime) ?? 0) / 10_000);
}

export const episodeKey = (season: number | null, episode: number): string => `${season ?? ''}:${episode}`;

function names(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const out = list.map((entry: any) => String(typeof entry === 'string' ? entry : entry?.name ?? '').trim()).filter(Boolean);
  return [...new Set(out)];
}

function yearOf(meta: any): number | null {
  const year = parseInt(String(meta.year || meta.releaseInfo || meta.released || '').slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function idsOf(meta: any): Record<string, string> {
  const ids: Record<string, string> = {};
  const imdb = meta._imdbId || meta.imdb_id;
  if (imdb) ids.imdb = String(imdb);
  for (const [field, name] of [['_tmdbId', 'tmdb'], ['_tvdbId', 'tvdb'], ['_malId', 'mal'], ['_kitsuId', 'kitsu'], ['_anilistId', 'anilist'], ['_anidbId', 'anidb']]) {
    if (meta[field]) ids[name] = String(meta[field]);
  }
  return ids;
}

function isAnime(meta: any, genres: string[], language: string | null): boolean {
  if (PER_ENTRY_ANIME.test(String(meta.id ?? '')) || meta._providerArt?.anime) return true;
  if (genres.some((genre) => genre.toLowerCase() === 'anime')) return true;
  return (language === 'ja' || language === 'jpn') && genres.some((genre) => genre.toLowerCase() === 'animation');
}

export function factsFromMeta(meta: any, kind: 'movie' | 'series', source: 'cache' | 'built', watched: Set<string>): TitleFacts {
  const genres = names(meta.genres);
  const language = originalLanguage(meta);
  const episodeRuntimes: Record<string, number> = {};
  let episodeCount = 0;
  for (const video of Array.isArray(meta.videos) ? meta.videos : []) {
    const episode = Number(video?.episode);
    if (!Number.isFinite(episode)) continue;
    const season = Number.isInteger(video?.season) ? video.season : null;
    if (season !== 0) episodeCount += 1;
    const key = episodeKey(season, episode);
    const runtime = runtimeMsOf(video?.runtime);
    if (runtime > 0 && watched.has(key)) episodeRuntimes[key] = runtime;
  }
  return {
    id: String(meta.id),
    kind,
    name: String(meta.name ?? meta.id),
    year: yearOf(meta),
    poster: meta.poster || null,
    background: meta.background || null,
    logo: meta.logo || null,
    genres,
    countries: names(meta.countries?.length ? meta.countries : meta.country),
    networks: names(meta.networks),
    studios: names(meta.studios),
    language,
    status: meta.status ? String(meta.status) : null,
    anime: isAnime(meta, genres, language),
    runtimeMs: runtimeMsOf(meta.runtime),
    episodeRuntimes,
    episodeCount,
    ids: idsOf(meta),
    source,
  };
}

async function routeConfig(userUUID: string): Promise<any | null> {
  const config = await require('../../configApi').loadRouteConfig(userUUID).catch(() => null);
  if (!config) return null;
  config.userUUID = userUUID;
  config.addonIdentifier = userUUID;
  return config;
}

async function heldMeta(userUUID: string, config: any, type: string, id: string): Promise<any | null> {
  const { reconstructMetaFromComponents } = require('../../getCache');
  const read = await reconstructMetaFromComponents(userUUID, id, undefined, { config }, type, true, false).catch(() => null);
  return read?.meta ?? null;
}

export interface FactsRequest {
  titleKey: string;
  kind: 'movie' | 'series';
  weight: number;
  watched: Set<string>;
}

export async function titleFacts(userUUID: string, requests: FactsRequest[]): Promise<{ facts: Map<string, TitleFacts>; built: number; held: number; missing: number }> {
  const buildBudget = envInt('JELLYFIN_YEAR_REVIEW_BUILD_TITLES', 400, 0);
  const width = envInt('JELLYFIN_YEAR_REVIEW_META_CONCURRENCY', 4, 1);
  const ranked = [...requests].sort((a, b) => b.weight - a.weight);
  const facts = new Map<string, TitleFacts>();
  const config = await routeConfig(userUUID);
  let built = 0;
  let held = 0;
  await mapWithConcurrency(ranked, width, async (request, rank) => {
    const cached = config ? await heldMeta(userUUID, config, request.kind, request.titleKey) : null;
    if (cached) {
      held += 1;
      facts.set(request.titleKey, factsFromMeta(cached, request.kind, 'cache', request.watched));
      return;
    }
    if (rank >= buildBudget) return;
    const fresh = await fetchMetaBeforeArt(userUUID, request.kind, request.titleKey).catch(() => null);
    if (!fresh) return;
    built += 1;
    facts.set(request.titleKey, factsFromMeta(fresh, request.kind, 'built', request.watched));
  });
  return { facts, built, held, missing: requests.length - facts.size };
}

export function factsRequests(plays: YearPlay[]): FactsRequest[] {
  const byTitle = new Map<string, FactsRequest>();
  for (const play of plays) {
    const request = byTitle.get(play.titleKey) ?? { titleKey: play.titleKey, kind: play.kind === 'movie' ? 'movie' as const : 'series' as const, weight: 0, watched: new Set<string>() };
    request.weight += 1;
    if (play.episode !== null) request.watched.add(episodeKey(play.season, play.episode));
    if (play.episode !== null && play.season === null) request.watched.add(episodeKey(1, play.episode));
    byTitle.set(play.titleKey, request);
  }
  return [...byTitle.values()];
}

export function spelledAsAnime(plays: YearPlay[]): Set<string> {
  const out = new Set<string>();
  for (const play of plays) if (play.spellings.some((id) => ANIME_SPELLING.test(id))) out.add(play.titleKey);
  return out;
}
