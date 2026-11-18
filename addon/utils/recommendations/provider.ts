// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { envInt } from '../envNumber';

export type AiProvider = 'gemini' | 'openrouter';

export interface ResolvedProvider {
  provider: AiProvider;
  apiKey: string;
  model: string;
  /** Gemini grounding, the :online suffix already applied to the model, or a web search engine here. */
  webSearch: boolean;
  /** Set when the web is searched by an engine here rather than by the provider. */
  webSource: import('../webSearch').WebSearchSource | null;
  preset: boolean;
  /** Import path for the client, so callers do not repeat the branch. */
  clientPath: string;
}

/** An explicit choice wins where its key exists, so holding both keys still
 *  reaches either provider. */
/** Bumped when a change alters what a row holds. Keys both the picks and the
 *  pages built from them, which expire on separate clocks. */
export const RECOMMENDATION_EPOCH = 3;

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;

/** How often a row is written again. Each rewrite is a billed model call, so
 *  nothing shorter than six hours is offered. */
export const REFRESH_HOURS = [6, 12, 24] as const;

/** How a built row is arranged. The model's own order is unfiltered by quality,
 *  so rating weighted by audience is the default. */
export const PICK_ORDERS = ['suggested', 'popular', 'acclaimed', 'balanced'] as const;
export type PickOrder = typeof PICK_ORDERS[number];

/** The row's own setting where it has one, otherwise whatever was set for all. */
function forCatalog(config: any, catalogId: string | undefined, field: string): any {
  if (!catalogId) return undefined;
  const entry = (config?.catalogs || []).find((catalog: any) => catalog?.id === catalogId);
  return entry?.metadata?.[field];
}

export function pickOrder(config: any, catalogId?: string): PickOrder {
  const chosen = forCatalog(config, catalogId, 'pickOrder') ?? config?.recommendations?.order;
  return (PICK_ORDERS as readonly string[]).includes(chosen) ? chosen : 'balanced';
}

/** Near-zero votes usually means the search matched the wrong title, not an
 *  obscure gem. Only applied where a count is known. */
export function voteFloor(config: any, catalogId?: string): number {
  const chosen = Number(forCatalog(config, catalogId, 'pickMinVotes') ?? config?.recommendations?.min_votes);
  if (Number.isFinite(chosen) && chosen >= 0) return chosen;
  return parseInt(process.env.RECOMMENDATION_MIN_VOTES || '100', 10);
}

export function refreshTtl(config: any): number {
  const chosen = Number(config?.recommendations?.refresh_hours);
  if (Number.isFinite(chosen) && chosen > 0) return Math.round(chosen) * 60 * 60;

  const fallback = parseInt(process.env.RECOMMENDATION_TTL || '', 10);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 24 * 60 * 60;
}

/** The language a pick's reason is written in, as the configured tag. Empty for
 *  English, which is what the model writes unasked, so English keys and rows
 *  stay as they were before reasons followed the configuration. */
export function reasonLanguage(config: any): string {
  const tag = String(config?.language || 'en-US').trim() || 'en-US';
  return tag.toLowerCase().startsWith('en') ? '' : tag;
}

const REASONING_SHARE: Record<string, number> = { high: 0.8, medium: 0.5, low: 0.2, minimal: 0.1, none: 0 };

/** OpenRouter holds the cost of this many tokens against the balance while a call runs. */
const maxReplyTokens = (): number => envInt('RECOMMENDATION_MAX_TOKENS', 16384, 2048);

export function budgetFor(replyTokens: number, effort: string, floor = 2048): number {
  const share = REASONING_SHARE[effort] ?? 0.2;
  return Math.min(maxReplyTokens(), Math.max(floor, Math.ceil(replyTokens / (1 - share))));
}

/** Thinking is billed and drawn from the reply budget, and some models refuse to
 *  disable it, so it is capped by default and turned off only when chosen. */
export function reasoningEffort(config: any): string {
  const chosen = config?.recommendations?.reasoning_effort;
  if ((REASONING_EFFORTS as readonly string[]).includes(chosen)) return chosen;
  return resolveProvider(config)?.preset ? '' : 'low';
}

/** A Gemini key the instance supplies, used when a configuration has none of its own. */
export function instanceGeminiKey(): string {
  return process.env.GEMINI_API_KEY || process.env.BUILT_IN_GEMINI_API_KEY || '';
}

export function resolveProvider(config: any): ResolvedProvider | null {
  const ownGemini = config?.apiKeys?.gemini || '';
  const ownOpenrouter = config?.apiKeys?.openrouter || '';
  const geminiKey = ownGemini || instanceGeminiKey();
  const openrouterKey = ownOpenrouter || process.env.OPENROUTER_API_KEY || '';

  // A key of the configuration's own comes before one the instance supplies.
  const preferred = config?.recommendations?.provider;
  let provider: AiProvider;
  if (preferred === 'openrouter' && openrouterKey) provider = 'openrouter';
  else if (preferred === 'gemini' && geminiKey) provider = 'gemini';
  else if (ownGemini) provider = 'gemini';
  else if (ownOpenrouter) provider = 'openrouter';
  else if (geminiKey) provider = 'gemini';
  else if (openrouterKey) provider = 'openrouter';
  else return null;

  const { resolveRecommendationModel, isPresetModel, withWebSearch }: any = require('../ai-model-resolver');
  const { isCustomAiEndpoint }: any = require('../ai-endpoint');
  const wantsWebSearch = config?.recommendations?.web_search === true;
  // An engine here works with any model; another OpenAI-compatible endpoint has no search of its own.
  const chosenSearch = require('../webSearch').chosenWebSearch(config, config?.recommendations?.web_search_via);
  const webSource = wantsWebSearch ? chosenSearch.source : null;
  const webSearch = chosenSearch.provider && wantsWebSearch && !(provider === 'openrouter' && isCustomAiEndpoint());

  // Gemini takes grounding as a request flag, OpenRouter as a model suffix, so
  // the suffix is settled here rather than at the call site.
  let model = resolveRecommendationModel({ config, provider });
  const preset = provider === 'openrouter' && isPresetModel(model);
  if (provider === 'openrouter') model = withWebSearch(model, webSearch);

  return {
    provider,
    apiKey: provider === 'openrouter' ? openrouterKey : geminiKey,
    model,
    webSearch: (webSearch && !preset) || Boolean(webSource),
    webSource,
    preset,
    clientPath: provider === 'openrouter' ? '../openrouter-client' : '../gemini-client',
  };
}

module.exports = {
  resolveProvider, instanceGeminiKey, reasoningEffort, budgetFor, REASONING_EFFORTS, RECOMMENDATION_EPOCH,
  refreshTtl, REFRESH_HOURS, pickOrder, PICK_ORDERS, voteFloor, reasonLanguage,
};
