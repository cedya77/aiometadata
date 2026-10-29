import consola from 'consola';
import { LRUCache } from 'lru-cache';
import redis from './redisClient.js';
import { envInt } from '../utils/envNumber';

const logger = consola.withTag('CatalogPagination');

export interface CatalogCursor {
  served: number;
  upstreamPage: number;
  pageOffset: number;
}

const END_OF_LIST = Symbol('endOfList');

export function endOfList(): any[] {
  const metas: any = [];
  metas[END_OF_LIST] = true;
  return metas;
}

export function isEndOfList(metas: unknown): boolean {
  return Array.isArray(metas) && metas.length === 0 && (metas as any)[END_OF_LIST] === true;
}

export function endPageTtlSeconds(): number {
  return envInt('CATALOG_END_PAGE_TTL', 24 * 60 * 60, 60);
}

export function fillMaxPages(): number {
  return envInt('CATALOG_FILTER_FILL_MAX_PAGES', 5, 1);
}

export function cursorTtlSeconds(): number {
  return envInt('CATALOG_CURSOR_TTL', 6 * 60 * 60, 60);
}

// Every position a page was served from keeps its own cursor, so a reader that
// is not the latest one, or asks out of order, still lands where a sequential
// reader would. One cursor per catalog was cleared by the first page and
// overwritten by every other reader, and a miss filled from a guess.
const memoryCursors = new LRUCache<string, Map<number, CatalogCursor>>({
  max: envInt('CATALOG_CURSOR_MEMORY_MAX', 5000, 1),
  ttl: cursorTtlSeconds() * 1000,
});

/** `filteredFor` is the user, cap and tags the pages are filtered for; '' for the installation as it is. */
export function cursorKey(
  userUUID: string,
  cleanId: string,
  type: string,
  genre: string | undefined | null,
  filteredFor: string = ''
): string {
  const scope = filteredFor ? `${userUUID}@${filteredFor}` : userUUID;
  return `catalog-cursor:v3:${scope}:${cleanId}:${type}:${genre || 'all'}`;
}

async function readCursors(key: string): Promise<Map<number, CatalogCursor>> {
  if (redis) {
    try {
      const fields: Record<string, string> = await redis.hgetall(key);
      const out = new Map<number, CatalogCursor>();
      for (const [served, raw] of Object.entries(fields || {})) out.set(Number(served), JSON.parse(raw));
      return out;
    } catch (error: any) {
      logger.debug(`Cursor read failed for ${key}: ${error.message}`);
      return new Map();
    }
  }
  return memoryCursors.get(key) || new Map();
}

export async function readCursor(key: string, served: number): Promise<CatalogCursor | null> {
  if (redis) {
    try {
      const raw = await redis.hget(key, String(served));
      return raw ? JSON.parse(raw) : null;
    } catch (error: any) {
      logger.debug(`Cursor read failed for ${key}: ${error.message}`);
      return null;
    }
  }
  return memoryCursors.get(key)?.get(served) || null;
}

export async function writeCursor(key: string, cursor: CatalogCursor): Promise<void> {
  if (redis) {
    try {
      await redis.multi()
        .hset(key, String(cursor.served), JSON.stringify(cursor))
        .expire(key, cursorTtlSeconds())
        .exec();
    } catch (error: any) {
      logger.debug(`Cursor write failed for ${key}: ${error.message}`);
    }
    return;
  }
  const held = memoryCursors.get(key) || new Map<number, CatalogCursor>();
  held.set(cursor.served, cursor);
  memoryCursors.set(key, held);
}

export async function clearCursor(key: string): Promise<void> {
  if (redis) {
    try {
      await redis.del(key);
    } catch (error: any) {
      logger.debug(`Cursor clear failed for ${key}: ${error.message}`);
    }
    return;
  }
  memoryCursors.delete(key);
}

export interface FilledChunk {
  metas: any[];
  nextPage: number;
  nextOffset: number;
  pagesRead: number;
  exhausted: boolean;
}

// Concurrent asks for the same position share one fill, and a walk towards a
// later position waits on it rather than filling from a guess.
const inFlight = new Map<string, Promise<FilledChunk>>();

/** Fills the page served from `served`, starting at `start`, once for everyone asking, and records where the next one starts. */
export function fillOnce(
  key: string,
  served: number,
  start: { startPage: number; startOffset: number },
  fill: (start: { startPage: number; startOffset: number }) => Promise<FilledChunk>
): Promise<FilledChunk> {
  const flight = `${key}@${served}`;
  const running = inFlight.get(flight);
  if (running) return running;
  const work = fill(start)
    .then(async (chunk) => {
      if (chunk.metas.length > 0) {
        await writeCursor(key, { served: served + chunk.metas.length, upstreamPage: chunk.nextPage, pageOffset: chunk.nextOffset });
      }
      return chunk;
    })
    .finally(() => inFlight.delete(flight));
  inFlight.set(flight, work);
  return work;
}

function walkMaxPages(): number {
  return envInt('CATALOG_CURSOR_WALK_MAX_PAGES', 25, 1);
}

/**
 * Where the page served from `skip` starts upstream. An unknown position is
 * reached by filling forward, one served page at a time, from the nearest one
 * known, so the answer is the one a reader paging from the top would get. Past
 * the walk's budget, or when `skip` falls inside a page, it falls back to the
 * page number, as before.
 */
export async function resolveStartPage(
  key: string,
  skip: number,
  legacyPage: number,
  fill?: (start: { startPage: number; startOffset: number }) => Promise<FilledChunk>
): Promise<{ startPage: number; startOffset: number; matched: boolean }> {
  if (skip === 0) return { startPage: 1, startOffset: 0, matched: true };

  const exact = await readCursor(key, skip);
  if (exact) return { startPage: exact.upstreamPage, startOffset: exact.pageOffset || 0, matched: true };
  if (!fill) return { startPage: legacyPage, startOffset: 0, matched: false };

  const known = await readCursors(key);
  let served = 0;
  let start = { startPage: 1, startOffset: 0 };
  for (const [at, cursor] of known) {
    if (at < skip && at > served) {
      served = at;
      start = { startPage: cursor.upstreamPage, startOffset: cursor.pageOffset || 0 };
    }
  }

  for (let step = 0; served < skip && step < walkMaxPages(); step++) {
    const chunk = await fillOnce(key, served, start, fill);
    if (chunk.metas.length === 0) break;
    served += chunk.metas.length;
    start = { startPage: chunk.nextPage, startOffset: chunk.nextOffset };
    if (chunk.exhausted) break;
  }

  if (served === skip) return { ...start, matched: true };
  return { startPage: legacyPage, startOffset: 0, matched: false };
}

export interface FillResult {
  metas: any[];
  nextPage: number;
  nextOffset: number;
  pagesRead: number;
  exhausted: boolean;
}

export async function fillFilteredPage(options: {
  startPage: number;
  startOffset?: number;
  pageSize: number;
  maxPages?: number;
  fetchPage: (page: number) => Promise<any[]>;
  filter: (metas: any[]) => Promise<any[]>;
}): Promise<FillResult> {
  const { startPage, pageSize, fetchPage, filter } = options;
  const maxPages = options.maxPages ?? fillMaxPages();

  const metas: any[] = [];
  let page = startPage;
  let offset = options.startOffset || 0;
  let pagesRead = 0;
  let exhausted = false;
  // A page narrower than the widest one seen is the upstream's last. Measuring
  // against `pageSize` instead ended pagination on upstreams that page narrowly.
  let upstreamPageSize = 0;

  while (metas.length < pageSize && pagesRead < maxPages) {
    const raw = await fetchPage(page);
    pagesRead += 1;

    if (!raw || raw.length === 0) {
      exhausted = true;
      offset = 0;
      page += 1;
      break;
    }

    // Read before the estimate widens, so the first page is never short.
    const lastUpstreamPage = upstreamPageSize > 0 && raw.length < upstreamPageSize;
    if (raw.length > upstreamPageSize) upstreamPageSize = raw.length;

    const available = (await filter(raw)).slice(offset);
    const taken = available.slice(0, pageSize - metas.length);
    metas.push(...taken);

    if (taken.length < available.length) {
      offset += taken.length;
      break;
    }

    offset = 0;
    page += 1;

    if (lastUpstreamPage) {
      exhausted = true;
      break;
    }
  }

  return { metas, nextPage: page, nextOffset: offset, pagesRead, exhausted };
}
