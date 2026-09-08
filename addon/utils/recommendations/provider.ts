export type AiProvider = 'gemini' | 'openrouter';

export interface ResolvedProvider {
  provider: AiProvider;
  apiKey: string;
  model: string;
  /** Gemini grounding, or the :online suffix already applied to the model. */
  webSearch: boolean;
  /** Import path for the client, so callers do not repeat the branch. */
  clientPath: string;
}

/** An explicit choice wins where its key exists, so holding both keys still
 *  reaches either provider. */
/** Bumped when a change alters what a row holds. Keys both the picks and the
 *  pages built from them, which expire on separate clocks. */
export const RECOMMENDATION_EPOCH = 3;

export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

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
  if ((REFRESH_HOURS as readonly number[]).includes(chosen)) return chosen * 60 * 60;

  const fallback = parseInt(process.env.RECOMMENDATION_TTL || '', 10);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 24 * 60 * 60;
}

/** Thinking is billed and drawn from the reply budget, and some models refuse to
 *  disable it, so it is capped rather than turned off. */
export function reasoningEffort(config: any): string {
  const chosen = config?.recommendations?.reasoning_effort;
  return (REASONING_EFFORTS as readonly string[]).includes(chosen) ? chosen : 'low';
}

export function resolveProvider(config: any): ResolvedProvider | null {
  const geminiKey = config?.apiKeys?.gemini
    || process.env.GEMINI_API_KEY
    || process.env.BUILT_IN_GEMINI_API_KEY
    || '';
  const openrouterKey = config?.apiKeys?.openrouter || process.env.OPENROUTER_API_KEY || '';

  const preferred = config?.recommendations?.provider;
  let provider: AiProvider;
  if (preferred === 'openrouter' && openrouterKey) provider = 'openrouter';
  else if (preferred === 'gemini' && geminiKey) provider = 'gemini';
  else if (geminiKey) provider = 'gemini';
  else if (openrouterKey) provider = 'openrouter';
  else return null;

  const { resolveRecommendationModel }: any = require('../ai-model-resolver');
  const webSearch = config?.recommendations?.web_search === true;

  // Gemini takes grounding as a request flag, OpenRouter as a model suffix, so
  // the suffix is settled here rather than at the call site.
  let model = resolveRecommendationModel({ config, provider });
  if (provider === 'openrouter') {
    model = webSearch
      ? (model.endsWith(':online') ? model : `${model}:online`)
      : model.replace(/:online$/, '');
  }

  return {
    provider,
    apiKey: provider === 'openrouter' ? openrouterKey : geminiKey,
    model,
    webSearch,
    clientPath: provider === 'openrouter' ? '../openrouter-client' : '../gemini-client',
  };
}

module.exports = {
  resolveProvider, reasoningEffort, REASONING_EFFORTS, RECOMMENDATION_EPOCH,
  refreshTtl, REFRESH_HOURS, pickOrder, PICK_ORDERS, voteFloor,
};
