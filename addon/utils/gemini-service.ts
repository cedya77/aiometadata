require('dotenv').config();
const { generateContent }: any = require('./gemini-client');
const consola: any = require('consola');

const logger: any = consola.withTag('AISearch');

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-lite';

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

const GEMINI_MODELS: GeminiModel[] = [
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', grounding: true },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', grounding: true },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', grounding: false },
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', grounding: false },
  { id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite', grounding: false },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', grounding: false },
];

function supportsGrounding(model: string): boolean {
  const entry = GEMINI_MODELS.find(m => m.id === model);
  return entry?.grounding ?? false;
}

async function performGeminiSearch(apiKey: string, query: string, type: string, language: string, model: string, forceGrounding: boolean = false): Promise<Suggestion[]> {
  const startTime = Date.now();

  if (!apiKey) {
    logger.warn("Search failed: no API key provided.");
    return [];
  }

  const selectedModel = model || DEFAULT_GEMINI_MODEL;
  const useGrounding = forceGrounding || supportsGrounding(selectedModel);
  const timeout = useGrounding ? 45000 : 30000;

  logger.debug(`Using model: ${selectedModel}, grounding: ${useGrounding}, timeout: ${timeout}ms`);

  try {
    const generationStart = Date.now();

    const prompt = buildPrompt(query, type, 20, useGrounding ? 'gemini' : false);

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

  } catch (error: any) {
    const keyHint = apiKey ? `...${apiKey.slice(-4)}` : 'none';
    logger.error(`Error during AI search (model: ${selectedModel}, grounding: ${useGrounding}, key: ${keyHint}):`, error.message);
    if (error.statusCode) {
      logger.error(`HTTP status: ${error.statusCode}`);
    }
    logger.debug("Stack trace:", error.stack);
    return [];
  }
}

function buildPrompt(query: string, type: string, numResults: number = 10, searchMode: string | false = false): string {
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

    logger.error("Failed to parse JSON response from AI. Error:", error.message);
    logger.error("Raw text:", cleanText.substring(0, 500));
    return [];
  }
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

export { performGeminiSearch, buildPrompt, parseAIResponse, GEMINI_MODELS, supportsGrounding, DEFAULT_GEMINI_MODEL };
module.exports = { performGeminiSearch, buildPrompt, parseAIResponse, GEMINI_MODELS, supportsGrounding, DEFAULT_GEMINI_MODEL };
