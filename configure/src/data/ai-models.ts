export interface AIModel {
  id: string;
  name: string;
  grounding: boolean;
}

/**
 * The `-latest` entries are aliases Google repoints at its newest release in that
 * tier. They are listed because they are the way to stop having to revisit this
 * file, but they move without warning, and a tier's price can move with them,
 * so a pinned id remains the predictable choice.
 */
/**
 * `gemini-flash-latest` is an alias Google repoints at its newest flash release.
 * It is here so a retirement does not silently break every config again, at the
 * cost of the model moving under you without warning.
 */
export const GEMINI_MODELS: AIModel[] = [
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', grounding: true },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', grounding: true },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', grounding: true },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', grounding: true },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', grounding: true },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', grounding: true },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (Preview)', grounding: true },
  { id: 'gemini-flash-latest', name: 'Gemini Flash (latest)', grounding: true },
];

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.5-flash';

/**
 * Retired by Google, or never a real id.
 *
 * `gemini-2.5-flash` and `-pro` still answer for keys created before they were
 * withdrawn, which is why the failure only shows up for new users: Google
 * returns "no longer available to new users" and names a replacement.
 * `gemini-3-flash` and `gemini-3.1-pro` never existed under those names at all
 * (the API serves them as `-preview`), so they failed for everyone.
 *
 * The replacement is priced like what it replaces: `gemini-3.5-flash-lite` costs
 * the same $0.30/$2.50 per 1M tokens the old default did, where `gemini-3.6-flash`
 * is $0.75/$3.75. Users bring their own key, so the default should not quietly
 * cost them more than the one it stands in for.
 */
export const RETIRED_GEMINI_MODELS: Record<string, string> = {
  'gemini-2.5-flash': DEFAULT_GEMINI_MODEL,
  'gemini-2.5-pro': 'gemini-3.1-pro-preview',
  'gemini-2.5-flash-lite': DEFAULT_GEMINI_MODEL,
  'gemini-2.5-flash-lite-preview-09-2025': DEFAULT_GEMINI_MODEL,
  'gemini-3-flash': DEFAULT_GEMINI_MODEL,
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
};

export function resolveGeminiModel(model?: string | null): string {
  if (!model) return DEFAULT_GEMINI_MODEL;
  return RETIRED_GEMINI_MODELS[model] || model;
}

export type AIProvider = 'gemini' | 'openrouter';

// An OpenRouter ID is always vendor/model, which keeps the two namespaces apart.
export function isModelIdForProvider(provider: AIProvider, model?: string | null): boolean {
  if (!model) return false;
  return provider === 'openrouter' ? model.includes('/') : !model.includes('/');
}

export function defaultModelFor(provider: AIProvider): string {
  return provider === 'openrouter' ? DEFAULT_OPENROUTER_MODEL : DEFAULT_GEMINI_MODEL;
}

// Mirrors resolveCatalogModel in addon/utils/ai-model-resolver.ts.
export function resolveCatalogModel(config: any, provider: AIProvider): string {
  const configured = provider === 'openrouter'
    ? config?.ai_catalog?.openrouter_model
    : config?.ai_catalog?.gemini_model;
  const inherited = config?.search?.ai_provider === provider ? config?.search?.ai_model : undefined;

  for (const candidate of [configured, inherited]) {
    if (!isModelIdForProvider(provider, candidate)) continue;
    return provider === 'openrouter' ? candidate : resolveGeminiModel(candidate);
  }

  return defaultModelFor(provider);
}
