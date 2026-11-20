// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
require('dotenv').config();
const { generateContent }: any = require('./gemini-client');
const consola: any = require('consola');

const logger: any = consola.withTag('AISearch');


interface GeminiModel {
  id: string;
  name: string;
  grounding: boolean;
}

interface Suggestion {
  type: string;
  title: string;
  year: number;
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
const GEMINI_MODELS: GeminiModel[] = [
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', grounding: true },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', grounding: true },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', grounding: true },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', grounding: true },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', grounding: true },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', grounding: true },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (Preview)', grounding: true },
  { id: 'gemini-flash-latest', name: 'Gemini Flash (latest)', grounding: true },
];

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
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
const RETIRED_GEMINI_MODELS: Record<string, string> = {
  'gemini-2.5-flash': DEFAULT_GEMINI_MODEL,
  'gemini-2.5-pro': 'gemini-3.1-pro-preview',
  'gemini-2.5-flash-lite': DEFAULT_GEMINI_MODEL,
  'gemini-2.5-flash-lite-preview-09-2025': DEFAULT_GEMINI_MODEL,
  'gemini-3-flash': DEFAULT_GEMINI_MODEL,
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
};

function resolveGeminiModel(model?: string | null): string {
  if (!model) return DEFAULT_GEMINI_MODEL;
  return RETIRED_GEMINI_MODELS[model] || model;
}

function supportsGrounding(model: string): boolean {
  const entry = GEMINI_MODELS.find(m => m.id === model);
  return entry?.grounding ?? false;
}

function groundingRefused(error: any): boolean {
  const status = Number(error?.statusCode);
  const message = String(error?.message || '').toLowerCase();
  if (status === 429 || status === 403) return true;
  return /quota|billing|not available|not supported|permission|grounding/.test(message);
}

async function performGeminiSearch(apiKey: string, query: string, type: string, language: string, model: string, forceGrounding: boolean = false, webResults = ''): Promise<Suggestion[]> {
  if (!apiKey) {
    logger.warn("Search failed: no API key provided.");
    return [];
  }

  const selectedModel = resolveGeminiModel(model);
  const wantsGrounding = !webResults && forceGrounding && supportsGrounding(selectedModel);

  try {
    return await geminiSearch(apiKey, query, type, selectedModel, wantsGrounding, webResults);
  } catch (error: any) {
    if (wantsGrounding && groundingRefused(error)) {
      logger.warn(`Gemini refused web search on ${selectedModel} (${error?.message || error}); retrying without it`);
      return geminiSearch(apiKey, query, type, selectedModel, false);
    }
    throw error;
  }
}

async function geminiSearch(apiKey: string, query: string, type: string, selectedModel: string, useGrounding: boolean, webResults = ''): Promise<Suggestion[]> {
  const startTime = Date.now();
  const timeout = useGrounding ? 45000 : 30000;

  logger.debug(`Using model: ${selectedModel}, grounding: ${useGrounding}, timeout: ${timeout}ms`);

  const generationStart = Date.now();

  const prompt = buildPrompt(query, type, 20, useGrounding ? 'gemini' : webResults ? 'context' : false, webResults);

  const response = await generateContent({
    apiKey,
    model: selectedModel,
    prompt,
    useGrounding,
    timeout,
  });

  const rawText = response.text;

  if (!rawText) {
    logger.debug(`Gemini returned no text. Response details:`);
    if (response.finishReason) {
      logger.debug(`Finish reason: ${response.finishReason}`);
    }
    if (response.safetyRatings) {
      logger.debug(`Safety ratings: ${JSON.stringify(response.safetyRatings)}`);
    }
    if (response.finishReason === 'SAFETY') {
      logger.warn('Response blocked due to safety filters');
    }
    if (response.promptFeedback) {
      logger.debug(`Prompt feedback: ${JSON.stringify(response.promptFeedback)}`);
    }
  }

  const searchQueries = response.groundingMetadata?.webSearchQueries;
  if (searchQueries && searchQueries.length > 0) {
    logger.debug(`Gemini utilized Google Search grounding with ${searchQueries.length} queries: ${searchQueries.join(', ')}`);
  }

  const generationTime = Date.now() - generationStart;
  logger.debug(`AI generation completed in ${generationTime}ms`);
  logger.debug(`Gemini raw response: ${rawText}`);

  const parsingStart = Date.now();

  const suggestions = parseAIResponse(rawText, type);

  const parsingTime = Date.now() - parsingStart;
  logger.debug(`Parsing completed in ${parsingTime}ms`);

  const totalTime = Date.now() - startTime;
  logger.debug(`Total search time: ${totalTime}ms, returned ${suggestions.length} suggestions`);

  if (totalTime > 10000) {
    logger.warn(`WARNING: AI search took longer than 10 seconds (${totalTime}ms)`);
  }

  return suggestions;
}

function buildPrompt(query: string, type: string, numResults: number = 10, searchMode: string | false = false, webResults = ''): string {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.toLocaleString('en-US', { month: 'long' });
  const currentDate = `${currentMonth} ${now.getDate()}, ${currentYear}`;

return `You are a movie/series recommendation engine. You return JSON arrays only.

=== STRICT JSON SCHEMA ===
You MUST return a valid JSON array matching this exact schema:
[
  {
    "type": "movie" | "series",  // REQUIRED: string, exactly "movie" or "series"
    "title": string,              // REQUIRED: official title only, no suffixes
    "year": number                // REQUIRED: integer
  }
]

=== OUTPUT RULES ===
- Return ONLY the JSON array. Nothing else.
- NO text before the opening bracket [
- NO text after the closing bracket ]
- NO markdown code blocks (\`\`\`)
- NO explanations, introductions, or commentary
- NO trailing commas in JSON

VALID OUTPUT EXAMPLE:
[{"type":"movie","title":"Inception","year":2010},{"type":"series","title":"Breaking Bad","year":2008}]

INVALID OUTPUTS (DO NOT DO THIS):
- "Here are my recommendations: [...]"
- "Based on my search: [...]"
- "\`\`\`json\\n[...]\\n\`\`\`"
- "[{...},]" (trailing comma)

=== CONTEXT ===
TODAY: ${currentDate}
${webResults ? `
=== WEB RESULTS ===
${webResults}
` : ''}
=== RESULT COUNT ===
- you must return exactly ${numResults} results without any padding and when possible.
- Never pad with unrelated results

=== USER QUERY ===
<query>${query}</query>

=== SEARCH REQUIREMENT ===
${searchMode === 'gemini'
? 'MANDATORY: You MUST call googleSearch before responding. Convert the user query into targeted search queries. Do not guess or assume data.'
: searchMode === 'context'
? 'Web search results have been provided in your context. Use them to provide accurate, up-to-date results. Do not fabricate titles that do not exist. Do NOT attempt to call any tools or functions.'
: 'Use your training knowledge to provide accurate results. Do not fabricate titles that do not exist.'}

=== DATA RULES ===
1. "type" field: MUST be exactly "movie" or "series"
2. "title" field: Official title only (no "Season X", no "(US)", no year ranges)
3. "year" field: Integer only, represents FIRST release/air date
4. For series: year = FIRST air date, not latest season
5. "recent" means ${currentYear} or ${currentYear - 1}

JSON:`;
}

function parseAIResponse(rawText: string, type: string): Suggestion[] {
  if (!rawText || typeof rawText !== 'string') {
    logger.warn("AI returned no text response (undefined or null)");
    return [];
  }

  let cleanText = rawText.trim();
  cleanText = cleanText.replace(/^```json\n?/i, '').replace(/^```\n?/, '').replace(/\n?```$/g, '').trim();

  try {
    const parsed = JSON.parse(cleanText);

    if (!Array.isArray(parsed)) {
      logger.error("Response is not an array");
      return [];
    }

    return validateAndFilterEntries(parsed);

  } catch (error: any) {
    logger.warn("Direct JSON parse failed, attempting to extract JSON array from text...");

    const jsonArrayMatch = cleanText.match(/\[[\s\S]*\]/);

    if (jsonArrayMatch) {
      try {
        const extractedJson = jsonArrayMatch[0];
        logger.info("Found JSON array in text, attempting to parse...");
        const parsed = JSON.parse(extractedJson);

        if (!Array.isArray(parsed)) {
          logger.error("Extracted content is not an array");
          return [];
        }

        logger.info("Successfully extracted and parsed JSON array from text");
        return validateAndFilterEntries(parsed);

      } catch (extractError: any) {
        logger.error("Failed to parse extracted JSON array. Error:", extractError.message);
      }
    } else {
      logger.error("No JSON array found in response text");
    }

    // One malformed entry (a missing colon, a stray token) makes the whole
    // array unparseable, so keep every entry that parses on its own.
    const { entries: salvaged, skipped } = salvageArrayEntries(cleanText);
    if (salvaged.length > 0) {
      logger.warn(`Recovered ${salvaged.length} entries from a malformed AI response (${skipped} skipped)`);
      return validateAndFilterEntries(salvaged);
    }

    logger.error("Failed to parse JSON response from AI. Error:", error.message);
    logger.error("Raw text:", cleanText.substring(0, 500));
    return [];
  }
}

/**
 * Parses each top-level object inside the first JSON array of objects in
 * `text` on its own and returns those that parse, plus how many were skipped.
 * Tracks strings and escaped quotes so braces inside titles don't end an entry
 * early. A raw newline ends a string (it is never legal inside one), so an
 * unbalanced quote in a multi-line reply only costs its own entry.
 */
function salvageArrayEntries(text: string): { entries: any[]; skipped: number } {
  const match = /\[\s*\{/.exec(text);
  if (!match) return { entries: [], skipped: 0 };
  const start = match.index;

  const entries: any[] = [];
  let skipped = 0;
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\n' || ch === '\r') {
        inString = false;
        escaped = false;
      } else if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && objectStart !== -1) {
        try {
          const entry = JSON.parse(text.slice(objectStart, i + 1));
          if (entry && typeof entry === 'object' && !Array.isArray(entry)) entries.push(entry);
        } catch {
          skipped++;
        }
        objectStart = -1;
      }
    } else if (ch === ']' && depth === 0) {
      break;
    }
  }
  return { entries, skipped };
}

function validateAndFilterEntries(parsed: any[]): Suggestion[] {
  const validSuggestions = parsed.filter(entry => {
    if (!entry.type || !entry.title || !entry.year) {
      logger.warn("Filtering out invalid entry (missing required fields):", entry);
      return false;
    }

    if (typeof entry.title !== 'string') {
      logger.warn("Filtering out invalid entry (title is not a string):", entry);
      return false;
    }

    const year = typeof entry.year === 'number' ? entry.year : Number(entry.year);

    if (isNaN(year)) {
      logger.warn("Filtering out invalid entry (year is not a valid number):", entry);
      return false;
    }

    if (year < 1850 || year > new Date().getFullYear() + 1) {
      logger.warn("Filtering out invalid entry (unreasonable year):", entry);
      return false;
    }

    entry.year = year;

    return true;
  });

  logger.info(`Parsed ${validSuggestions.length} valid suggestions from ${parsed.length} total entries`);
  return validSuggestions;
}

export { performGeminiSearch, buildPrompt, parseAIResponse, GEMINI_MODELS, supportsGrounding, resolveGeminiModel, DEFAULT_GEMINI_MODEL };
module.exports = { performGeminiSearch, buildPrompt, parseAIResponse, GEMINI_MODELS, supportsGrounding, resolveGeminiModel, DEFAULT_GEMINI_MODEL };
