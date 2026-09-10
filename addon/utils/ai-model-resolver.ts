const { resolveGeminiModel, DEFAULT_GEMINI_MODEL }: any = require('./gemini-service');

const DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.5-flash';

type AiProvider = 'gemini' | 'openrouter';

// Model IDs are interpolated into the Gemini request path, so anything that
// reaches a client must be charset-checked first.
const GEMINI_MODEL_PATTERN = /^[a-z0-9][a-z0-9.-]*$/i;
const OPENROUTER_MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9._-]+(:[a-z0-9._-]+)?$/i;

function isValidModelId(provider: AiProvider, model: unknown): model is string {
  if (typeof model !== 'string') return false;
  const trimmed = model.trim();
  if (!trimmed || trimmed.length > 150) return false;
  return provider === 'openrouter'
    ? OPENROUTER_MODEL_PATTERN.test(trimmed)
    : GEMINI_MODEL_PATTERN.test(trimmed);
}

function defaultModelFor(provider: AiProvider): string {
  return provider === 'openrouter' ? DEFAULT_OPENROUTER_MODEL : DEFAULT_GEMINI_MODEL;
}

interface ResolveOptions {
  config?: any;
  provider: AiProvider;
  requestedModel?: unknown;
}

function resolveCatalogModel({ config, provider, requestedModel }: ResolveOptions): string {
  const configured = provider === 'openrouter'
    ? config?.ai_catalog?.openrouter_model
    : config?.ai_catalog?.gemini_model;
  const inherited = config?.search?.ai_provider === provider ? config?.search?.ai_model : undefined;

  for (const candidate of [requestedModel, configured, inherited]) {
    if (!isValidModelId(provider, candidate)) continue;
    const trimmed = candidate.trim();
    return provider === 'openrouter' ? trimmed : resolveGeminiModel(trimmed);
  }

  return defaultModelFor(provider);
}

/**
 * Recommendations reuse whichever provider the AI catalog builder is already
 * configured with, so there is no second credential to supply. A user who has
 * set a model for catalogs is assumed to want it here too unless they say
 * otherwise, since both are the same kind of judgement call.
 */
function resolveRecommendationModel({ config, provider, requestedModel }: ResolveOptions): string {
  const configured = provider === 'openrouter'
    ? config?.recommendations?.openrouter_model
    : config?.recommendations?.gemini_model;

  for (const candidate of [requestedModel, configured]) {
    if (!isValidModelId(provider, candidate)) continue;
    const trimmed = candidate.trim();
    return provider === 'openrouter' ? trimmed : resolveGeminiModel(trimmed);
  }

  return resolveCatalogModel({ config, provider });
}

export {
  resolveCatalogModel,
  resolveRecommendationModel,
  isValidModelId,
  defaultModelFor,
  DEFAULT_OPENROUTER_MODEL,
};
module.exports = {
  resolveCatalogModel,
  resolveRecommendationModel,
  isValidModelId,
  defaultModelFor,
  DEFAULT_OPENROUTER_MODEL,
};
