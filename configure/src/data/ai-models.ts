export interface AIModel {
  id: string;
  name: string;
  grounding: boolean;
}

export const GEMINI_MODELS: AIModel[] = [
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', grounding: true },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', grounding: true },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', grounding: false },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', grounding: false },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', grounding: false },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', grounding: false },
];

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-lite';
export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.5-flash';
