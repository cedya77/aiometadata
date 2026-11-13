// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import { createHash } from 'crypto';
import { envInt } from '../../utils/envNumber';
import { httpGet } from '../../utils/httpClient';

const logger = consola.withTag('Jellyfin');

const { cacheWrapGlobal, classifyResultAllowEmpty } = require('../getCache');

export type SegmentType = 'Intro' | 'Recap' | 'Outro';

export interface Segment {
  type: SegmentType;
  startMs: number;
  endMs: number;
}

interface Lookup {
  imdbId?: string | null;
  tmdbId?: string | number | null;
  kind: 'movie' | 'episode';
  season?: number | null;
  episode?: number | null;
  malId?: number | null;
  malEpisode?: number | null;
  runtimeMs?: number | null;
}

function baseUrl(name: string, fallback: string): string {
  return (process.env[name]?.trim() || fallback).replace(/\/+$/, '');
}

function range(type: SegmentType, start: unknown, end: unknown): Segment | null {
  const startMs = Number(start);
  const endMs = Number(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return { type, startMs: Math.max(0, startMs), endMs };
}

async function fromPublicMetaDb(apiKey: string, lookup: Lookup): Promise<Segment[]> {
  if (!lookup.tmdbId) return [];
  const { fetchSkips } = require('../../utils/publicmetadbUtils');
  const items = await fetchSkips(apiKey, {
    tmdbId: lookup.tmdbId,
    mediaType: lookup.kind === 'movie' ? 'movie' : 'tv',
    season: lookup.season,
    episode: lookup.episode,
  });
  // Streaming releases first: that is what a stream addon plays.
  const ordered = [...items].sort((a: any, b: any) => (a.source === 'streaming' ? 0 : 1) - (b.source === 'streaming' ? 0 : 1));
  const out: Segment[] = [];
  for (const item of ordered) {
    const intro = range('Intro', item.intro_start_ms, item.intro_end_ms);
    const outro = range('Outro', item.credits_start_ms, item.credits_end_ms);
    if (intro && !out.some((s) => s.type === 'Intro')) out.push(intro);
    if (outro && !out.some((s) => s.type === 'Outro')) out.push(outro);
  }
  return out;
}

// Reads need no key; the id is IMDb's and the numbering the show's own.
async function fromIntroDb(lookup: Lookup): Promise<Segment[]> {
  if (lookup.kind !== 'episode' || !lookup.imdbId || lookup.season === null || lookup.season === undefined || !lookup.episode) return [];
  const params = new URLSearchParams({ imdb_id: String(lookup.imdbId), season: String(lookup.season), episode: String(lookup.episode) });
  const response = await httpGet(`${baseUrl('INTRODB_BASE_URL', 'https://api.introdb.app')}/segments?${params.toString()}`, {
    headers: { accept: 'application/json' },
    timeout: envInt('INTRODB_TIMEOUT_MS', 5000, 500),
  });
  if (response.status !== 200) return [];
  const body: any = response.data;
  const out: Segment[] = [];
  for (const [key, type] of [['intro', 'Intro'], ['recap', 'Recap'], ['outro', 'Outro']] as Array<[string, SegmentType]>) {
    const segment = range(type, body?.[key]?.start_ms, body?.[key]?.end_ms);
    if (segment) out.push(segment);
  }
  return out;
}

const aniSkipBase = () => `${baseUrl('ANISKIP_BASE_URL', 'https://api.aniskip.com')}/v2`;

// An entry can file some of its episodes under another MAL id; the rules say which.
async function aniSkipTarget(malId: number, episode: number): Promise<{ malId: number; episode: number }> {
  const rules = await cacheWrapGlobal(`aniskip_rules:${malId}`, async () => {
    try {
      const response = await httpGet(`${aniSkipBase()}/relation-rules/${malId}`, {
        headers: { accept: 'application/json' },
        timeout: envInt('ANISKIP_TIMEOUT_MS', 5000, 500),
      });
      return { rules: Array.isArray(response.data?.rules) ? response.data.rules : [] };
    } catch (error: any) {
      if (error?.response?.status === 404) return { rules: [] };
      throw error;
    }
  }, envInt('JELLYFIN_SEGMENTS_TTL', 7 * 24 * 60 * 60, 60), { resultClassifier: classifyResultAllowEmpty });
  for (const rule of rules?.rules ?? []) {
    const start = Number(rule?.from?.start);
    const end = rule?.from?.end === undefined || rule?.from?.end === null ? start : Number(rule.from.end);
    if (!Number.isFinite(start) || episode < start || episode > end || !rule?.to?.malId) continue;
    return { malId: Number(rule.to.malId), episode: Number(rule.to.start) + (episode - start) };
  }
  return { malId, episode };
}

async function aniSkipQuery(malId: number, episode: number, episodeLength: number): Promise<any[]> {
  const params = new URLSearchParams({ episodeLength: String(episodeLength) });
  for (const type of ['op', 'ed', 'mixed-op', 'mixed-ed', 'recap']) params.append('types', type);
  try {
    const response = await httpGet(`${aniSkipBase()}/skip-times/${malId}/${episode}?${params.toString()}`, {
      headers: { accept: 'application/json' },
      timeout: envInt('ANISKIP_TIMEOUT_MS', 5000, 500),
    });
    return Array.isArray(response.data?.results) ? response.data.results : [];
  } catch (error: any) {
    // AniSkip answers 404 for an episode it has no markers for.
    if (error?.response?.status !== 404) throw error;
    return [];
  }
}

// A length asks about one release through a window too narrow for a runtime rounded to whole minutes,
// and 0 asks across every release; so the lengths are discovered with 0 and the nearest is asked for.
async function fromAniSkip(lookup: Lookup): Promise<Segment[]> {
  if (lookup.kind !== 'episode' || !lookup.malId || !lookup.malEpisode) return [];
  const target = await aniSkipTarget(lookup.malId, lookup.malEpisode);
  const discovered = await aniSkipQuery(target.malId, target.episode, 0);
  if (!discovered.length) return [];

  let results = discovered;
  const runtimeMs = lookup.runtimeMs ?? 0;
  if (runtimeMs > 0) {
    const lengths = discovered.map((r: any) => Number(r?.episodeLength)).filter((n: number) => n > 0);
    const nearest = lengths.sort((a: number, b: number) => Math.abs(a * 1000 - runtimeMs) - Math.abs(b * 1000 - runtimeMs))[0];
    if (nearest && Math.abs(nearest * 1000 - runtimeMs) > runtimeMs * 0.1) return [];
    if (nearest) {
      const exact = await aniSkipQuery(target.malId, target.episode, nearest);
      results = exact.length ? exact : discovered.filter((r: any) => Math.abs(Number(r?.episodeLength) - nearest) < 2);
    }
  }

  const out: Segment[] = [];
  const order = ['op', 'ed', 'recap', 'mixed-op', 'mixed-ed'];
  const typeOf: Record<string, SegmentType> = { op: 'Intro', 'mixed-op': 'Intro', ed: 'Outro', 'mixed-ed': 'Outro', recap: 'Recap' };
  for (const skipType of order) {
    const type = typeOf[skipType];
    if (out.some((s) => s.type === type)) continue;
    const match = results.find((r: any) => r?.skipType === skipType);
    const segment = match && range(type, Number(match.interval?.startTime) * 1000, Number(match.interval?.endTime) * 1000);
    if (segment) out.push(segment);
  }
  return out;
}

/** The MAL entry and episode number an episode id is known under, if any. */
export async function malEpisodeFor(videoId: string | null): Promise<{ malId: number; malEpisode: number } | null> {
  if (!videoId) return null;
  const { parseStremioId } = require('./ids');
  const { videoIdAliases } = require('./aliases');
  const spellings = [videoId, ...(await videoIdAliases(videoId))];
  for (const spelling of spellings) {
    const parsed = parseStremioId(spelling);
    if (parsed?.idType !== 'mal' || !parsed.episode) continue;
    const malId = parseInt(parsed.base.split(':')[1], 10);
    if (malId > 0) return { malId, malEpisode: Number(parsed.episode) };
  }
  return null;
}

// Timestamps are per title, not per file, so a release cut differently is off by that much.
type Provider = 'publicmetadb' | 'aniskip' | 'introdb';
export type SkipSource = 'auto' | 'off' | Provider | Provider[];

const PROVIDERS: Provider[] = ['publicmetadb', 'aniskip', 'introdb'];

export function skipSources(config: any): Provider[] {
  const choice: SkipSource = config?.jellyfinSkipSource ?? 'auto';
  const picked: Provider[] = Array.isArray(choice) ? choice
    : choice === 'off' ? []
    : PROVIDERS.includes(choice as Provider) ? [choice as Provider]
    : PROVIDERS;
  const pmdb = Boolean(config?.apiKeys?.publicmetadb);
  return [...new Set(picked)].filter((p) => PROVIDERS.includes(p) && (p !== 'publicmetadb' || pmdb));
}

const PROVIDER_NAMES: Record<Provider, string> = { publicmetadb: 'PublicMetaDB', aniskip: 'AniSkip', introdb: 'IntroDB' };

export async function segmentsFor(config: any, lookup: Lookup): Promise<Segment[]> {
  const sources = skipSources(config);
  if (!sources.length) return [];
  const pmdbKey: string = config?.apiKeys?.publicmetadb || '';
  const key = `jf_segments:v4:${sources.join('+')}:${lookup.kind}:${lookup.tmdbId || ''}:${lookup.imdbId || ''}:${lookup.season ?? ''}:${lookup.episode ?? ''}:${lookup.malId ?? ''}:${lookup.malEpisode ?? ''}:${Math.round((lookup.runtimeMs ?? 0) / 1000)}`;
  const ttl = envInt('JELLYFIN_SEGMENTS_TTL', 7 * 24 * 60 * 60, 60);

  const data = await cacheWrapGlobal(key, async () => {
    const found = new Map<SegmentType, Segment>();
    const take = (segments: Segment[]) => {
      for (const segment of segments) if (!found.has(segment.type)) found.set(segment.type, segment);
    };
    for (const source of sources) {
      if (found.size >= 3) break;
      try {
        take(
          source === 'publicmetadb' ? await fromPublicMetaDb(pmdbKey, lookup)
          : source === 'aniskip' ? await fromAniSkip(lookup)
          : await fromIntroDb(lookup)
        );
      } catch (error: any) {
        logger.debug(`${PROVIDER_NAMES[source]} skips unavailable: ${error?.message || error}`);
      }
    }
    return { segments: [...found.values()] };
  }, ttl, { resultClassifier: classifyResultAllowEmpty });

  return Array.isArray(data?.segments) ? data.segments : [];
}

export function segmentId(itemId: string, type: SegmentType): string {
  return createHash('md5').update(`${itemId}|${type}`).digest('hex');
}
