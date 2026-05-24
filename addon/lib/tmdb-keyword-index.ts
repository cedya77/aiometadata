import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { request } from 'undici';
import consola from 'consola';
import redis from './redisClient';

const logger = consola.withTag('TMDB-Keywords');
const gunzipAsync = promisify(gunzip);

const EXPORT_BASE_URL = 'https://files.tmdb.org/p/exports';
const KEYWORD_EXPORT_TTL = parseInt(process.env.TMDB_KEYWORD_EXPORT_TTL || String(7 * 24 * 60 * 60), 10);
const KEYWORD_EXPORT_LOOKBACK_DAYS = parseInt(process.env.TMDB_KEYWORD_EXPORT_LOOKBACK_DAYS || '7', 10);

export interface TmdbKeywordExportEntry {
  id: number;
  name: string;
}

interface KeywordIndexPayload {
  exportDate: string;
  entries: TmdbKeywordExportEntry[];
}

export interface ResolvedTmdbKeyword {
  id: number;
  label: string;
}

const entriesByNormalizedName = new Map<string, ResolvedTmdbKeyword>();
let initialized = false;
let initializePromise: Promise<void> | null = null;
let lastExportDate: string | null = null;
let loadedKeywordCount = 0;

export function normalizeTmdbKeywordName(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueNormalizedValues(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = String(value || '').trim();
    if (!trimmed) continue;
    const key = normalizeTmdbKeywordName(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed);
  }
  return unique;
}

export function parseTmdbKeywordNames(values: string[] = []): string[] {
  const parts: string[] = [];
  for (const value of values) {
    parts.push(...String(value || '').split(/[|,;]/).map(part => part.trim()).filter(Boolean));
  }
  return uniqueNormalizedValues(parts);
}

function getExportDateCandidates(): Array<{ display: string; pathDate: string }> {
  const candidates: Array<{ display: string; pathDate: string }> = [];
  const now = new Date();
  const lookbackDays = Number.isFinite(KEYWORD_EXPORT_LOOKBACK_DAYS)
    ? Math.max(1, KEYWORD_EXPORT_LOOKBACK_DAYS)
    : 7;

  for (let offset = 0; offset < lookbackDays; offset++) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset));
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const yyyy = String(date.getUTCFullYear());
    candidates.push({
      display: `${yyyy}-${mm}-${dd}`,
      pathDate: `${mm}_${dd}_${yyyy}`,
    });
  }

  return candidates;
}

function parseKeywordExport(text: string): TmdbKeywordExportEntry[] {
  const entries: TmdbKeywordExportEntry[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const item = JSON.parse(trimmed);
    const id = Number(item?.id);
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    if (Number.isFinite(id) && id > 0 && name) {
      entries.push({ id, name });
    }
  }

  return entries;
}

async function downloadKeywordExport(): Promise<KeywordIndexPayload> {
  let lastError: Error | null = null;

  for (const candidate of getExportDateCandidates()) {
    const url = `${EXPORT_BASE_URL}/keyword_ids_${candidate.pathDate}.json.gz`;
    try {
      logger.info(`Fetching TMDB keyword export ${candidate.display}`);
      const { statusCode, body } = await request(url, {
        headersTimeout: 30000,
        bodyTimeout: 30000,
      });

      if (statusCode === 404) {
        lastError = new Error(`TMDB keyword export not found for ${candidate.display}`);
        continue;
      }

      if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`TMDB keyword export request failed with HTTP ${statusCode}`);
      }

      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.from(chunk));
      }
      const decompressed = await gunzipAsync(Buffer.concat(chunks));
      const entries = parseKeywordExport(decompressed.toString('utf8'));
      if (!entries.length) {
        throw new Error(`TMDB keyword export ${candidate.display} was empty`);
      }

      return { exportDate: candidate.display, entries };
    } catch (error: any) {
      lastError = error;
      logger.warn(`Failed to load TMDB keyword export ${candidate.display}: ${error.message}`);
    }
  }

  throw lastError || new Error('No TMDB keyword export could be loaded');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadKeywordExport(): Promise<KeywordIndexPayload> {
  const cacheKey = 'tmdb:keywords:export:index';

  if (redis?.status === 'ready') {
    try {
      const cached = await withTimeout(redis.get(cacheKey), 1500, 'TMDB keyword cache read');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed?.entries) && parsed.entries.length) {
          logger.debug(`Using cached TMDB keyword export${parsed.exportDate ? ` from ${parsed.exportDate}` : ''}.`);
          return parsed;
        }
      }
    } catch (error: any) {
      logger.warn(`Failed to read TMDB keyword cache: ${error.message}`);
    }
  }

  const payload = await downloadKeywordExport();

  if (redis?.status === 'ready') {
    try {
      await withTimeout(redis.setex(cacheKey, KEYWORD_EXPORT_TTL, JSON.stringify(payload)), 1500, 'TMDB keyword cache write');
    } catch (error: any) {
      logger.warn(`Failed to write TMDB keyword cache: ${error.message}`);
    }
  }

  return payload;
}

function rebuildIndex(payload: KeywordIndexPayload): void {
  entriesByNormalizedName.clear();
  loadedKeywordCount = 0;

  for (const entry of payload.entries || []) {
    const normalized = normalizeTmdbKeywordName(entry.name);
    if (!normalized) continue;

    const resolved = { id: Number(entry.id), label: entry.name };
    const existing = entriesByNormalizedName.get(normalized);
    if (!existing || resolved.id < existing.id) {
      entriesByNormalizedName.set(normalized, resolved);
    }
    loadedKeywordCount++;
  }

  lastExportDate = payload.exportDate || null;
  initialized = true;
}

export async function initializeTmdbKeywordIndex(): Promise<void> {
  if (initialized) return;
  if (!initializePromise) {
    initializePromise = loadKeywordExport()
      .then((payload) => {
        rebuildIndex(payload);
        logger.success(`Loaded ${payload.entries.length} TMDB keywords${payload.exportDate ? ` from ${payload.exportDate}` : ''}.`);
      })
      .finally(() => {
        initializePromise = null;
      });
  }
  await initializePromise;
}

export async function resolveTmdbKeywordByName(
  name: string
): Promise<ResolvedTmdbKeyword | null> {
  if (!normalizeTmdbKeywordName(name)) return null;

  if (!initialized) {
    await initializeTmdbKeywordIndex();
  }

  const normalized = normalizeTmdbKeywordName(name);
  return entriesByNormalizedName.get(normalized) || null;
}

export function getTmdbKeywordIndexStats() {
  return {
    initialized,
    count: loadedKeywordCount,
    uniqueNames: entriesByNormalizedName.size,
    exportDate: lastExportDate,
  };
}

export const __privateTmdbKeywordIndex = {
  normalizeTmdbKeywordName,
  parseKeywordExport,
  rebuildIndex,
};
