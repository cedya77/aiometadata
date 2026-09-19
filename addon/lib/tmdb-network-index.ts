import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { request } from 'undici';
import consola from 'consola';
import redis from './redisClient';

const logger = consola.withTag('TMDB-Networks');
const gunzipAsync = promisify(gunzip);

const EXPORT_BASE_URL = 'https://files.tmdb.org/p/exports';
function networkExportTtl(): number {
  return parseInt(process.env.TMDB_NETWORK_EXPORT_TTL || String(7 * 24 * 60 * 60), 10);
}

function networkExportLookbackDays(): number {
  return parseInt(process.env.TMDB_NETWORK_EXPORT_LOOKBACK_DAYS || '7', 10);
}

interface TmdbNetworkExportEntry {
  id: number;
  name: string;
}

interface NetworkIndexPayload {
  exportDate: string;
  entries: TmdbNetworkExportEntry[];
}

interface ResolvedTmdbNetwork {
  id: number;
  label: string;
}

const NETWORK_ALIASES: Record<string, ResolvedTmdbNetwork> = {
  hbo: { id: 49, label: 'HBO' },
  'home box office': { id: 49, label: 'HBO' },
  'bbc': { id: 4, label: 'BBC One' },
  'bbc one': { id: 4, label: 'BBC One' },
  abc: { id: 2, label: 'ABC' },
  nbc: { id: 6, label: 'NBC' },
  fx: { id: 88, label: 'FX' },
  amc: { id: 174, label: 'AMC' },
  netflix: { id: 213, label: 'Netflix' },
  'apple tv plus': { id: 2552, label: 'Apple TV+' },
  'apple tv': { id: 2552, label: 'Apple TV+' },
  hulu: { id: 453, label: 'Hulu' },
};

const entriesByName = new Map<string, ResolvedTmdbNetwork[]>();
let initialized = false;
let initializePromise: Promise<void> | null = null;
let lastExportDate: string | null = null;

function normalizeNetworkName(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getExportDateCandidates(): Array<{ display: string; pathDate: string }> {
  const candidates: Array<{ display: string; pathDate: string }> = [];
  const now = new Date();
  const lookbackDays = Number.isFinite(networkExportLookbackDays())
    ? Math.max(1, networkExportLookbackDays())
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

function parseNetworkExport(text: string): TmdbNetworkExportEntry[] {
  const entries: TmdbNetworkExportEntry[] = [];

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

async function downloadNetworkExport(): Promise<NetworkIndexPayload> {
  let lastError: Error | null = null;

  for (const candidate of getExportDateCandidates()) {
    const url = `${EXPORT_BASE_URL}/tv_network_ids_${candidate.pathDate}.json.gz`;
    try {
      logger.info(`Fetching TMDB TV network export ${candidate.display}`);
      const { statusCode, body } = await request(url, {
        headersTimeout: 30000,
        bodyTimeout: 30000,
      });

      if (statusCode === 404) {
        lastError = new Error(`TMDB network export not found for ${candidate.display}`);
        continue;
      }

      if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`TMDB network export request failed with HTTP ${statusCode}`);
      }

      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.from(chunk));
      }
      const compressed = Buffer.concat(chunks);
      const decompressed = await gunzipAsync(compressed);
      const entries = parseNetworkExport(decompressed.toString('utf8'));
      if (!entries.length) {
        throw new Error(`TMDB network export ${candidate.display} was empty`);
      }

      return { exportDate: candidate.display, entries };
    } catch (error: any) {
      lastError = error;
      logger.warn(`Failed to load TMDB TV network export ${candidate.display}: ${error.message}`);
    }
  }

  throw lastError || new Error('No TMDB TV network export could be loaded');
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

async function loadNetworkExport(): Promise<NetworkIndexPayload> {
  const cacheKey = 'tmdb:tv_networks:export:index';

  if (redis?.status === 'ready') {
    try {
      const cached = await withTimeout(redis.get(cacheKey), 1500, 'TMDB network cache read');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed?.entries) && parsed.entries.length) {
          logger.debug(`Using cached TMDB TV network export${parsed.exportDate ? ` from ${parsed.exportDate}` : ''}.`);
          return parsed;
        }
      }
    } catch (error: any) {
      logger.warn(`Failed to read TMDB network cache: ${error.message}`);
    }
  }

  const payload = await downloadNetworkExport();

  if (redis?.status === 'ready') {
    try {
      await withTimeout(redis.setex(cacheKey, networkExportTtl(), JSON.stringify(payload)), 1500, 'TMDB network cache write');
    } catch (error: any) {
      logger.warn(`Failed to write TMDB network cache: ${error.message}`);
    }
  }

  return payload;
}

function rebuildIndex(payload: NetworkIndexPayload): void {
  entriesByName.clear();

  for (const entry of payload.entries || []) {
    const normalized = normalizeNetworkName(entry.name);
    if (!normalized) continue;

    const existing = entriesByName.get(normalized) || [];
    existing.push({ id: Number(entry.id), label: entry.name });
    entriesByName.set(normalized, existing);
  }

  lastExportDate = payload.exportDate || null;
  initialized = true;
}

export async function initializeTmdbNetworkIndex(): Promise<void> {
  if (initialized) return;
  if (!initializePromise) {
    initializePromise = loadNetworkExport()
      .then((payload) => {
        rebuildIndex(payload);
        logger.success(`Loaded ${payload.entries.length} TMDB TV networks${payload.exportDate ? ` from ${payload.exportDate}` : ''}.`);
      })
      .finally(() => {
        initializePromise = null;
      });
  }
  await initializePromise;
}

export async function resolveTmdbNetworkByName(name: string): Promise<ResolvedTmdbNetwork | null> {
  const normalized = normalizeNetworkName(name);
  if (!normalized) return null;

  const alias = NETWORK_ALIASES[normalized];
  if (alias) return alias;

  if (!initialized) {
    await initializeTmdbNetworkIndex();
  }

  const exactMatches = entriesByName.get(normalized) || [];
  if (exactMatches.length) {
    return exactMatches.sort((a, b) => a.id - b.id)[0];
  }

  return null;
}

export async function getTmdbNetworkById(id: number): Promise<ResolvedTmdbNetwork | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!initialized) await initializeTmdbNetworkIndex();

  for (const entries of entriesByName.values()) {
    const match = entries.find(entry => entry.id === id);
    if (match) return match;
  }

  for (const alias of Object.values(NETWORK_ALIASES)) {
    if (alias.id === id) return alias;
  }

  return null;
}

export async function searchTmdbNetworks(query: string, limit: number = 25): Promise<ResolvedTmdbNetwork[]> {
  const normalized = normalizeNetworkName(query);
  if (!normalized) return [];

  if (!initialized) {
    await initializeTmdbNetworkIndex();
  }

  const seen = new Set<number>();
  const results: ResolvedTmdbNetwork[] = [];
  const push = (entry: ResolvedTmdbNetwork) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    results.push(entry);
  };

  const alias = NETWORK_ALIASES[normalized];
  if (alias) push(alias);

  for (const entry of (entriesByName.get(normalized) || []).slice().sort((a, b) => a.id - b.id)) {
    push(entry);
  }

  const prefixMatches: ResolvedTmdbNetwork[] = [];
  const substringMatches: ResolvedTmdbNetwork[] = [];
  for (const [name, entries] of entriesByName) {
    if (name === normalized) continue;
    if (name.startsWith(normalized)) {
      prefixMatches.push(...entries);
    } else if (name.includes(normalized)) {
      substringMatches.push(...entries);
    }
  }
  prefixMatches.sort((a, b) => a.label.length - b.label.length || a.id - b.id);
  substringMatches.sort((a, b) => a.label.length - b.label.length || a.id - b.id);
  for (const entry of prefixMatches) {
    if (results.length >= limit) break;
    push(entry);
  }
  for (const entry of substringMatches) {
    if (results.length >= limit) break;
    push(entry);
  }

  return results.slice(0, limit);
}

export function getTmdbNetworkIndexStats() {
  return {
    initialized,
    count: Array.from(entriesByName.values()).reduce((total, entries) => total + entries.length, 0),
    uniqueNames: entriesByName.size,
    exportDate: lastExportDate,
  };
}

export const __privateTmdbNetworkIndex = {
  normalizeNetworkName,
  parseNetworkExport,
  rebuildIndex,
};
