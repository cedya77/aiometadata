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

/**
 * Which model answers, and with whose key.
 *
 * An explicit choice is honoured whenever the matching key exists; otherwise
 * whichever key is present wins. Without this, a user holding both keys could
 * never reach OpenRouter, because "gemini unless gemini is missing" is not a
 * preference, it is an accident of ordering.
 */
/**
 * Bumped whenever a change alters what a row comes out holding.
 *
 * Picks and the catalog pages built from them are cached separately and expire
 * on their own clocks, so a fix that only invalidates the picks leaves the old
 * pages being served for the rest of the catalog TTL: the series row went on
 * showing an anime film for hours after the filter that excludes it shipped.
 */
export const RECOMMENDATION_EPOCH = 3;

export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

/**
 * How often a row is written again, in hours.
 *
 * Nothing shorter than six is offered: a fresh list is a large model writing for
 * a minute and is charged for, and the taste it is drawn from does not move that
 * fast. The default is a day.
 */
export const REFRESH_HOURS = [6, 12, 24] as const;

/**
 * How a built row is arranged.
 *
 * Rating weighted by audience is the default. The model's own order is the
 * honest one, but it is unfiltered by quality, so a row can open on titles
 * rated in the fives while far better picks sit further down; weighting asks a
 * title to be both well liked and actually watched before it leads, which
 * reads better without turning the row into a list of the merely famous.
 */
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

/**
 * Titles below this are dropped whatever the ordering, because a vote count
 * near zero is usually not an obscure gem: it is the search having matched the
 * wrong title. Only applied where a count is actually known.
 */
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

/**
 * Thinking is billed at the completion rate and counted against the same reply
 * budget as the answer, and OpenRouter refuses to disable it on some models
 * ("Reasoning is mandatory for this endpoint"), so it is capped instead. The
 * bill lands on the key in the user's own configuration, so the choice is
 * theirs; low measured cheaper than the default with no loss of answer.
 */
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
