require('dotenv').config();
const { generateContent } = require('./gemini-client');
const consola = require('consola');


const logger = consola.withTag('GeminiService');

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite-preview-09-2025";

/**
 * Main orchestration function for AI-powered search.
 * 
 * @param {string} apiKey - The Gemini API key.
 * @param {string} query - The user's natural language search query.
 * @param {'movie' | 'series'} type - The type of media to search for.
 * @param {string} language
 * @returns {Promise<Array<{type: string, title: string, year: number}>>} Array of suggestions.
 */
async function performGeminiSearch(apiKey, query, type, language) {
  const startTime = Date.now();

  if (!apiKey) {
    logger.warn("Search failed: no API key provided.");
    return [];
  }

  try {
    // Phase 1: AI Generation
    const generationStart = Date.now();
    
    const prompt = buildPrompt(query, type, 20);
    
    const response = await generateContent({
      apiKey,
      model: DEFAULT_GEMINI_MODEL,
      prompt,
      useGrounding: true,
      timeout: 30000,
    });

    const rawText = response.text;
    
    // Debug: Log response details when text is missing
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
    
    // Check if grounding (Google Search) was utilized by looking for webSearchQueries
    const searchQueries = response.groundingMetadata?.webSearchQueries;
    if (searchQueries && searchQueries.length > 0) {
      logger.debug(`Gemini utilized Google Search grounding with ${searchQueries.length} queries: ${searchQueries.join(', ')}`);
    }
    
    const generationTime = Date.now() - generationStart;
    logger.debug(`AI generation completed in ${generationTime}ms`);
    logger.debug(`Gemini raw response: ${rawText}`);

    // Phase 2: Parsing
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

  } catch (error) {
    const keyHint = apiKey ? `...${apiKey.slice(-4)}` : 'none';
    logger.error(`Error during AI search (key: ${keyHint}):`, error.message);
    if (error.statusCode) {
      logger.error(`HTTP status: ${error.statusCode}`);
    }
    logger.debug("Stack trace:", error.stack);
    return [];
  }
}

/**
 * Constructs the prompt for the AI based on query, type, and number of results.
 * @param {string} query - The user's search query.
 * @param {'movie' | 'series'} type - The media type.
 * @param {number} numResults - The number of results to request (default 10).
 * @returns {string} The formatted prompt.
 */
function buildPrompt(query, type, numResults = 10) {
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
MANDATORY: You MUST call googleSearch before responding. Convert the user query into targeted search queries. Do not guess or assume data.

=== DATA RULES ===
1. "type" field: MUST be exactly "movie" or "series" 
2. "title" field: Official title only (no "Season X", no "(US)", no year ranges)
3. "year" field: Integer only, represents FIRST release/air date
4. For series: year = FIRST air date, not latest season
5. "recent" means ${currentYear} or ${currentYear - 1}

JSON:`;
}


/**
 * Parses and validates the AI response.
 * @param {string} rawText - The raw text response from Gemini.
 * @param {string} type - The expected media type.
 * @returns {Array<{type: string, title: string, year: number}>} Array of validated Suggestion objects.
 */
function parseAIResponse(rawText, type) {
  // Handle undefined or null responses
  if (!rawText || typeof rawText !== 'string') {
    logger.warn("Gemini returned no text response (undefined or null)");
    return [];
  }
  
  // Remove markdown code blocks if present
  let cleanText = rawText.trim();
  cleanText = cleanText.replace(/^```json\n?/i, '').replace(/^```\n?/, '').replace(/\n?```$/g, '').trim();
  
  try {
    const parsed = JSON.parse(cleanText);
    
    if (!Array.isArray(parsed)) {
      logger.error("Response is not an array");
      return [];
    }
    
    return validateAndFilterEntries(parsed);
    
  } catch (error) {
    logger.warn("Direct JSON parse failed, attempting to extract JSON array from text...");
    
    // Try to extract JSON array from the text (any content between [ and ])
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
        
      } catch (extractError) {
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

/**
 * Validates and filters suggestion entries.
 * @param {Array} parsed - The parsed array to validate.
 * @returns {Array<{type: string, title: string, year: number}>} Array of validated Suggestion objects.
 */
function validateAndFilterEntries(parsed) {
  // Filter and validate entries
  const validSuggestions = parsed.filter(entry => {
    // Check required fields exist
    if (!entry.type || !entry.title || !entry.year) {
      logger.warn("Filtering out invalid entry (missing required fields):", entry);
      return false;
    }
    
    // Validate types (with type coercion for year)
    if (typeof entry.title !== 'string') {
      logger.warn("Filtering out invalid entry (title is not a string):", entry);
      return false;
    }
    
    // Coerce year to number if it's a string
    const year = typeof entry.year === 'number' ? entry.year : Number(entry.year);
    
    if (isNaN(year)) {
      logger.warn("Filtering out invalid entry (year is not a valid number):", entry);
      return false;
    }
    
    // Validate year is reasonable
    if (year < 1850 || year > new Date().getFullYear() + 1) {
      logger.warn("Filtering out invalid entry (unreasonable year):", entry);
      return false;
    }
    
    // Normalize the year to a number for consistency
    entry.year = year;
    
    return true;
  });
  
  logger.info(`Parsed ${validSuggestions.length} valid suggestions from ${parsed.length} total entries`);
  return validSuggestions;
}

module.exports = {
  performGeminiSearch
};
