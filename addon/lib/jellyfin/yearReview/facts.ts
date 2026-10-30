import { envInt } from '../../../utils/envNumber';
import { mapWithConcurrency } from '../../../utils/concurrency';
import { fetchMetaBeforeArt, originalLanguage, parseRuntimeTicks } from '../items';
import type { YearPlay } from './plays';

const database: any = require('../../database');

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
  source: FactsSource;
}

export type FactsSource = 'stored' | 'cache' | 'built';

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

export function factsFromMeta(meta: any, kind: 'movie' | 'series', source: FactsSource): TitleFacts {
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
    if (runtime > 0) episodeRuntimes[key] = runtime;
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
}

function factsKey(config: any, request: FactsRequest): string {
  const { getMetaSmartLockContextHash } = require('../../getCache');
  return `${request.kind}:${getMetaSmartLockContextHash(config, request.titleKey, request.kind, true, false)}:${request.titleKey}`;
}

export async function titleFacts(userUUID: string, requests: FactsRequest[]): Promise<{ facts: Map<string, TitleFacts>; stored: number; built: number; held: number; missing: number }> {
  const buildBudget = envInt('JELLYFIN_YEAR_REVIEW_BUILD_TITLES', 400, 0);
  const width = envInt('JELLYFIN_YEAR_REVIEW_META_CONCURRENCY', 4, 1);
  const maxAgeMs = envInt('JELLYFIN_YEAR_REVIEW_FACTS_HOURS', 7 * 24, 1) * 60 * 60 * 1000;
  const facts = new Map<string, TitleFacts>();
  const config = await routeConfig(userUUID);
  if (!config) return { facts, stored: 0, built: 0, held: 0, missing: requests.length };
  const keys = new Map(requests.map((request) => [request.titleKey, factsKey(config, request)]));
  const kept: Map<string, any> = await database.getTitleFacts([...keys.values()], Date.now() - maxAgeMs).catch(() => new Map());
  for (const request of requests) {
    const found = kept.get(keys.get(request.titleKey)!);
    if (found) facts.set(request.titleKey, { ...found, source: 'stored' });
  }
  const stored = facts.size;
  const ranked = requests.filter((request) => !facts.has(request.titleKey)).sort((a, b) => b.weight - a.weight);
  const fresh: Array<{ key: string; data: TitleFacts }> = [];
  let built = 0;
  let held = 0;
  await mapWithConcurrency(ranked, width, async (request, rank) => {
    const cached = await heldMeta(userUUID, config, request.kind, request.titleKey);
    const meta = cached ?? (rank < buildBudget ? await fetchMetaBeforeArt(userUUID, request.kind, request.titleKey).catch(() => null) : null);
    if (!meta) return;
    if (cached) held += 1;
    else built += 1;
    const found = factsFromMeta(meta, request.kind, cached ? 'cache' : 'built');
    facts.set(request.titleKey, found);
    fresh.push({ key: keys.get(request.titleKey)!, data: found });
  });
  if (fresh.length) await database.putTitleFacts(fresh).catch(() => undefined);
  return { facts, stored, built, held, missing: requests.length - facts.size };
}

export function factsRequests(plays: YearPlay[]): FactsRequest[] {
  const byTitle = new Map<string, FactsRequest>();
  for (const play of plays) {
    const request = byTitle.get(play.titleKey) ?? { titleKey: play.titleKey, kind: play.kind === 'movie' ? 'movie' as const : 'series' as const, weight: 0 };
    request.weight += 1;
    byTitle.set(play.titleKey, request);
  }
  return [...byTitle.values()];
}

export function spelledAsAnime(plays: YearPlay[]): Set<string> {
  const out = new Set<string>();
  for (const play of plays) if (play.spellings.some((id) => ANIME_SPELLING.test(id))) out.add(play.titleKey);
  return out;
}
