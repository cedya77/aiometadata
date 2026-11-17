// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { createHash } from 'crypto';
import consola from 'consola';
import { getSetting } from '../lib/settingsService';

const logger = consola.withTag('WebSearch');

/** fastCRW's hosted API; an instance may point at its own server instead. */
export const FASTCRW_HOSTED = 'https://api.fastcrw.com';

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
  published: string | null;
}

export interface WebSearchSource {
  base: string;
  key: string;
}

const setting = (key: string): string => String(getSetting(key) || '').trim();
const instanceBase = (): string => setting('FASTCRW_BASE_URL').replace(/\/+$/, '');

/** The configuration's own key comes first, then one the instance supplies; a server of the instance's own may take none. */
export function webSearchSource(config: any): WebSearchSource | null {
  const base = instanceBase();
  const key = String(config?.apiKeys?.fastcrw || '').trim() || setting('FASTCRW_API_KEY');
  if (!key && !base) return null;
  return { base: base || FASTCRW_HOSTED, key };
}

/** Whether every configuration here can search without a key of its own. */
export function instanceWebSearch(): boolean {
  return Boolean(instanceBase() || setting('FASTCRW_API_KEY'));
}

/**
 * The engine chosen for one feature. Having chosen fastCRW, a configuration that can no longer reach it searches
 * nothing rather than falling back to its provider's search, which may be billed where fastCRW was not.
 */
export function chosenWebSearch(config: any, via: unknown): { fastcrw: WebSearchSource | null; provider: boolean } {
  if (via !== 'fastcrw') return { fastcrw: null, provider: true };
  const fastcrw = webSearchSource(config);
  if (!fastcrw) logger.debug('fastCRW was chosen for web search but is not available to this configuration, so it searches without the web');
  return { fastcrw, provider: false };
}

function searchError(status: number, data: any, text: string): Error {
  const said = String(data?.error || data?.message || (data ? '' : text) || '').slice(0, 120);
  const what = status === 402 ? 'fastCRW has no credits left'
    : status === 401 || status === 403 ? 'fastCRW refused the key'
      : status === 429 ? 'fastCRW is limiting requests, try again shortly'
        : status === 503 ? 'search is off or unreachable on that fastCRW server'
          : `fastCRW answered ${status}`;
  return Object.assign(new Error(said ? `${what}: ${said}` : what), { statusCode: status });
}

async function ask(source: WebSearchSource, query: string, limit: number): Promise<WebResult[]> {
  const { request } = require('undici');
  const started = Date.now();
  const tracker = require('../lib/requestTracker');
  try {
    const { statusCode, body } = await request(`${source.base}/v1/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(source.key ? { authorization: `Bearer ${source.key}` } : {}) },
      // No time filter: a server whose engines cannot filter by date refuses the whole search, so the query names the year instead.
      body: JSON.stringify({ query, limit }),
      signal: AbortSignal.timeout(20000),
    });
    const text = await body.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (statusCode !== 200 || !data || data.success === false) throw searchError(statusCode, data, text);
    tracker.trackProviderCall('fastcrw', Date.now() - started, true);
    // The hosted API puts the results in data, a server of one's own in data.results, and a search by source in data.web.
    const rows: any[] = Array.isArray(data.data) ? data.data
      : Array.isArray(data.data?.results) ? data.data.results
        : Array.isArray(data.data?.web) ? data.data.web
          : [];
    return rows
      .map((row) => ({
        title: String(row?.title ?? '').trim(),
        url: String(row?.url ?? '').trim(),
        snippet: String(row?.snippet ?? row?.description ?? '').replace(/\s+/g, ' ').trim(),
        published: row?.publishedDate ? String(row.publishedDate) : null,
      }))
      .filter((row) => row.title || row.snippet);
  } catch (error: any) {
    tracker.trackProviderCall('fastcrw', Date.now() - started, false);
    throw error;
  }
}

/**
 * The web's results for a query. Results are public pages, so one search serves every configuration
 * asking the same thing for as long as FASTCRW_CACHE_HOURS. Only results are kept: a refused or failed
 * search is asked again next time, which is the caller's to report.
 */
export async function searchWeb(source: WebSearchSource, query: string, options: { limit?: number } = {}): Promise<WebResult[]> {
  const limit = Math.min(20, Math.max(1, Math.round(options.limit ?? 10)));
  const { readGlobalCache, writeGlobalCache } = require('../lib/getCache');
  const key = `websearch:fastcrw:${createHash('sha256').update(JSON.stringify([source.base, query, limit])).digest('hex').slice(0, 24)}`;
  const held = await readGlobalCache(key).catch(() => null);
  if (Array.isArray(held?.results)) return held.results;
  const results = await ask(source, query, limit);
  const hours = Number(setting('FASTCRW_CACHE_HOURS')) || 12;
  if (results.length) await writeGlobalCache(key, { results }, hours * 3600).catch(() => undefined);
  return results;
}

/** Results as a numbered list for a prompt, cut to a size a model reads in full. */
export function formatWebResults(results: WebResult[], maxChars = 6000): string {
  const lines: string[] = [];
  let used = 0;
  results.forEach((result, i) => {
    const date = result.published ? ` (${result.published.slice(0, 10)})` : '';
    const line = `${i + 1}. ${result.title}${date}: ${result.snippet.slice(0, 300)} <${result.url}>`;
    if (used + line.length > maxChars) return;
    used += line.length + 1;
    lines.push(line);
  });
  return lines.join('\n');
}

/** The search as prompt text, or empty when it fails, so a search without the web still answers. */
export async function webContext(source: WebSearchSource, query: string, options: Parameters<typeof searchWeb>[2] = {}): Promise<string> {
  try {
    const results = await searchWeb(source, query, options);
    logger.debug(`fastCRW found ${results.length} result(s) for "${query.slice(0, 80)}"`);
    return formatWebResults(results);
  } catch (error: any) {
    logger.warn(`Web search through fastCRW failed, continuing without it: ${error?.message || error}`);
    return '';
  }
}

/** A key checked against the capabilities route, which costs no credits. */
export async function checkWebSearchKey(key: string): Promise<boolean> {
  const { request } = require('undici');
  const { statusCode, body } = await request(`${instanceBase() || FASTCRW_HOSTED}/v1/capabilities`, {
    method: 'GET',
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10000),
  });
  await body.dump().catch(() => undefined);
  if (statusCode === 200) return true;
  if (statusCode === 401 || statusCode === 403) return false;
  throw Object.assign(new Error(`fastCRW answered ${statusCode}`), { statusCode });
}
