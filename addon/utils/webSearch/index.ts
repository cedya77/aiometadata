// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { createHash } from 'crypto';
import consola from 'consola';
import { getSetting } from '../../lib/settingsService';
import { ENGINES, engineOf } from './engines';
import type { WebResult, WebSearchSource } from './types';

export type { WebResult, WebSearchEngine, WebSearchSource } from './types';

const logger = consola.withTag('WebSearch');
const setting = (key: string): string => String(getSetting(key) || '').trim();

/** The engine this instance offers every configuration: at a server of its own, or through a hosted API with a key it pays for. */
export function instanceSource(): WebSearchSource | null {
  const engine = engineOf(setting('WEB_SEARCH_ENGINE'));
  if (!engine) return null;
  const url = setting('WEB_SEARCH_URL').replace(/\/+$/, '');
  const key = setting('WEB_SEARCH_API_KEY');
  // A hosted API reached with no key of the instance's offers nothing; an engine with no hosted API needs the URL.
  if (!url && !(engine.hostedUrl && key)) return null;
  return { engine, base: url || engine.hostedUrl!, key, own: false };
}

/** Where one configuration's search through an engine goes; its own key comes before one the instance supplies. */
export function webSearchSource(config: any, id: unknown): WebSearchSource | null {
  const engine = engineOf(id);
  if (!engine) return null;
  const own = engine.hostedUrl ? String(config?.apiKeys?.[engine.id] || '').trim() : '';
  const instance = instanceSource();
  if (instance?.engine === engine) return { ...instance, key: own || instance.key, own: Boolean(own) };
  return own ? { engine, base: engine.hostedUrl!, key: own, own: true } : null;
}

/**
 * The search one feature chose: its AI provider's own, or an engine here. A configuration that chose an engine it can
 * no longer reach searches nothing rather than falling back to its provider's search, which may be billed where the
 * engine was not. An id no engine has any more reads as the provider's, as the settings page shows it.
 */
export function chosenWebSearch(config: any, via: unknown): { source: WebSearchSource | null; provider: boolean } {
  if (!engineOf(via)) return { source: null, provider: true };
  const source = webSearchSource(config, via);
  if (!source) logger.debug(`${String(via)} was chosen for web search but this configuration cannot reach it, so it searches without the web`);
  return { source, provider: false };
}

/** The engines and the one this instance offers, for the settings page. */
export function webSearchInfo(): { engines: Array<{ id: string; name: string; about: string; keyLink: string | null; userKeys: boolean }>; instance: string | null } {
  return {
    engines: ENGINES.map((engine) => ({ id: engine.id, name: engine.name, about: engine.about, keyLink: engine.keyLink ?? null, userKeys: Boolean(engine.hostedUrl) })),
    instance: instanceSource()?.engine.id ?? null,
  };
}

/**
 * The web's results for a query. Results are public pages, so one search serves every configuration asking the same
 * thing of the same server for WEB_SEARCH_CACHE_HOURS. Only results are kept: a refused or failed search is asked again
 * next time, which is the caller's to report.
 */
export async function searchWeb(source: WebSearchSource, query: string, options: { limit?: number } = {}): Promise<WebResult[]> {
  const limit = Math.min(20, Math.max(1, Math.round(options.limit ?? 10)));
  const { readGlobalCache, writeGlobalCache } = require('../../lib/getCache');
  const key = `websearch:${source.engine.id}:${createHash('sha256').update(JSON.stringify([source.base, query, limit])).digest('hex').slice(0, 24)}`;
  const held = await readGlobalCache(key).catch(() => null);
  if (Array.isArray(held?.results)) return held.results;
  const tracker = require('../../lib/requestTracker');
  const started = Date.now();
  let results: WebResult[];
  try {
    results = (await source.engine.search(source, query, limit)).filter((row) => row.title || row.snippet);
    tracker.trackProviderCall(source.engine.id, Date.now() - started, true);
  } catch (error) {
    tracker.trackProviderCall(source.engine.id, Date.now() - started, false);
    throw error;
  }
  const hours = Number(setting('WEB_SEARCH_CACHE_HOURS')) || 12;
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

export interface WebContext {
  /** The results as prompt text; empty when the search failed or found nothing. */
  text: string;
  /** Why the search failed, worded for the person using the feature; null when it ran. */
  failure: string | null;
}

/**
 * What the person using a feature is told when its web search failed. A refusal of their own key is theirs to fix, so
 * the engine's reason is given; the instance's server is its admin's, and its address and log stay with them.
 */
function failureFor(source: WebSearchSource, error: any): string {
  if (!source.own) return `${source.engine.name} on this instance is not answering.`;
  if (error?.statusCode) return `${error.reason || `${source.engine.name} answered ${error.statusCode}`}.`;
  return `${source.engine.name} could not be reached.`;
}

/** The search as prompt text, or empty with the reason when it fails, so a search without the web still answers. */
export async function webContext(source: WebSearchSource, query: string, options: { limit?: number } = {}): Promise<WebContext> {
  try {
    const results = await searchWeb(source, query, options);
    logger.debug(`${source.engine.name} found ${results.length} result(s) for "${query.slice(0, 80)}"`);
    return { text: formatWebResults(results), failure: null };
  } catch (error: any) {
    // A connection that fails on every address comes back as an AggregateError with no message of its own.
    const code = [error?.code, error?.errors?.[0]?.code].find((value) => typeof value === 'string');
    const why = error?.statusCode ? error.message
      : `could not reach ${source.base} (${code || error?.message || error?.name || 'no answer'})`;
    logger.warn(`Web search through ${source.engine.name} failed, continuing without it: ${why}`);
    return { text: '', failure: failureFor(source, error) };
  }
}

const FAILURE_KEY = (feature: string, userUUID: string) => `websearch:failure:${feature}:${userUUID}`;
const FAILURE_HOURS = 24;

/**
 * Keeps the last web search failure a user's feature met, for the settings page to show, until a search through it
 * works again or a day passes. Features whose results are shared between users search rarely, so the moment a search
 * failed may be long before anyone looks.
 */
export async function noteWebSearch(feature: string, userUUID: string, failure: string | null): Promise<void> {
  if (!userUUID) return;
  const { writeGlobalCache } = require('../../lib/getCache');
  await writeGlobalCache(FAILURE_KEY(feature, userUUID), { failure, at: Date.now() }, failure ? FAILURE_HOURS * 3600 : 60).catch(() => undefined);
}

export async function lastWebSearchFailure(feature: string, userUUID: string): Promise<{ failure: string; at: number } | null> {
  const { readGlobalCache } = require('../../lib/getCache');
  const held = await readGlobalCache(FAILURE_KEY(feature, userUUID)).catch(() => null);
  return held?.failure ? { failure: String(held.failure), at: Number(held.at) || 0 } : null;
}

/** A user's key for an engine's hosted API, checked where this instance would send it. */
export async function checkWebSearchKey(id: string, key: string): Promise<boolean> {
  const engine = engineOf(id);
  if (!engine?.checkKey || !engine.hostedUrl) throw new Error(`${id} keys are not checked`);
  const instance = instanceSource();
  return engine.checkKey(instance?.engine === engine ? instance.base : engine.hostedUrl, key);
}
