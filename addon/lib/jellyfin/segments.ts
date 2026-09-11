import consola from 'consola';
import { createHash } from 'crypto';
import { envInt } from '../../utils/envNumber';

const logger = consola.withTag('Jellyfin');

const { cacheWrapGlobal } = require('../getCache');

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
  const response = await fetch(`https://api.introdb.app/segments?${params.toString()}`, {
    headers: { accept: 'application/json', 'user-agent': 'AIOMetadata' },
    signal: AbortSignal.timeout(envInt('INTRODB_TIMEOUT_MS', 5000, 500)),
  });
  if (!response.ok) return [];
  const body: any = await response.json();
  const out: Segment[] = [];
  for (const [key, type] of [['intro', 'Intro'], ['recap', 'Recap'], ['outro', 'Outro']] as Array<[string, SegmentType]>) {
    const segment = range(type, body?.[key]?.start_ms, body?.[key]?.end_ms);
    if (segment) out.push(segment);
  }
  return out;
}

// Timestamps are per title, not per file, so a release cut differently is off by that much.
export async function segmentsFor(config: any, lookup: Lookup): Promise<Segment[]> {
  const pmdbKey: string = config?.apiKeys?.publicmetadb || '';
  const key = `jf_segments:v1:${lookup.kind}:${lookup.tmdbId || ''}:${lookup.imdbId || ''}:${lookup.season ?? ''}:${lookup.episode ?? ''}:${pmdbKey ? 'p' : ''}`;
  const ttl = envInt('JELLYFIN_SEGMENTS_TTL', 7 * 24 * 60 * 60, 60);

  const data = await cacheWrapGlobal(key, async () => {
    const found = new Map<SegmentType, Segment>();
    const take = (segments: Segment[]) => {
      for (const segment of segments) if (!found.has(segment.type)) found.set(segment.type, segment);
    };
    if (pmdbKey) {
      try {
        take(await fromPublicMetaDb(pmdbKey, lookup));
      } catch (error: any) {
        logger.debug(`PublicMetaDB skips unavailable: ${error?.message || error}`);
      }
    }
    if (found.size < 3) {
      try {
        take(await fromIntroDb(lookup));
      } catch (error: any) {
        logger.debug(`IntroDB unavailable: ${error?.message || error}`);
      }
    }
    return { segments: [...found.values()] };
  }, ttl);

  return Array.isArray(data?.segments) ? data.segments : [];
}

export function segmentId(itemId: string, type: SegmentType): string {
  return createHash('md5').update(`${itemId}|${type}`).digest('hex');
}
