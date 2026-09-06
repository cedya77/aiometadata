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
export const RECOMMENDATION_EPOCH = 2;

export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

/**
 * How often a row is written again, in hours.
 *
 * Nothing shorter than six is offered: a fresh list is a large model writing for
 * a minute and is charged for, and the taste it is drawn from does not move that
 * fast. The default is a day.
 */
export const REFRESH_HOURS = [6, 12, 24] as const;

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
  refreshTtl, REFRESH_HOURS,
};
