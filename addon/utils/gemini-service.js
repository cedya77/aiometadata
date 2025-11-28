require('dotenv').config();
const { GoogleGenAI } = require("@google/genai");
const consola = require('consola');

const logger = consola.create({ 
  level: process.env.LOG_LEVEL ? 
    (consola.LogLevels[process.env.LOG_LEVEL.toLowerCase()] ?? 4) : 
    (process.env.NODE_ENV === 'production' ? 3 : 4),
  fancy: true,
  colors: true,
  formatOptions: {
    colors: true,
    compact: false,
    date: false
  },
  tag: 'GeminiService'
});

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

const clientCache = new Map();

function getGeminiClient(apiKey) {
  if (!apiKey) return null;
  if (clientCache.has(apiKey)) return clientCache.get(apiKey);

  try {
    const ai = new GoogleGenAI({ apiKey });
    logger.info(`Caching new client for API key ending in ...${apiKey.slice(-4)}`);
    clientCache.set(apiKey, ai);
    return ai;
  } catch (error) {
    logger.error(`Failed to initialize client for key ...${apiKey.slice(-4)}`);
    clientCache.set(apiKey, null);
    return null;
  }
}

/**
 * Main orchestration function for AI-powered search.
 * Implements three-phase architecture: AI Generation, Parsing, and returns structured suggestions.
 * 
 * @param {string} apiKey - The Gemini API key.
 * @param {string} query - The user's natural language search query.
 * @param {'movie' | 'series'} type - The type of media to search for.
 * @param {string} language - The language code (not used in current implementation).
 * @returns {Promise<Array<{type: string, title: string, year: number}>>} Array of suggestions.
 */
async function performGeminiSearch(apiKey, query, type, language) {
  const startTime = Date.now();

  try {
    // Phase 1: Get Gemini client (with caching)
    const ai = getGeminiClient(apiKey);
    
    if (!ai) {
      logger.warn("Search failed: client not available for the provided key.");
      return [];
    }

    // Phase 2: AI Generation
    logger.info(`Starting AI generation phase for query: "${query}"`);
    const generationStart = Date.now();
    
    const prompt = buildPrompt(query, type, 20);
    const response = await ai.models.generateContent({
      model: DEFAULT_GEMINI_MODEL,
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }]
      }
    });
    const rawText = response.text;
    
    // Check if grounding (Google Search) was utilized
    const groundingMetadata = response?.candidates?.[0]?.groundingMetadata;
    if (groundingMetadata && Object.keys(groundingMetadata).length > 0) {
      logger.debug('Gemini utilized Google Search grounding for live data');
      //logger.debug(`Grounding metadata: ${JSON.stringify(groundingMetadata)}`);
    }
    
    const generationTime = Date.now() - generationStart;
    logger.info(`AI generation completed in ${generationTime}ms`);
    logger.debug(`Gemini raw response: ${rawText}`);

    // Phase 3: Parsing
    logger.info(`Starting parsing phase`);
    const parsingStart = Date.now();
    
    const suggestions = parseAIResponse(rawText, type);
    
    const parsingTime = Date.now() - parsingStart;
    logger.info(`Parsing completed in ${parsingTime}ms`);
    
    const totalTime = Date.now() - startTime;
    logger.info(`Total search time: ${totalTime}ms, returned ${suggestions.length} suggestions`);
    
    if (totalTime > 10000) {
      logger.warn(`WARNING: AI search took longer than 10 seconds (${totalTime}ms)`);
    }
    
    return suggestions;

  } catch (error) {
    logger.error("Error during AI search:", error.message);
    logger.error("Stack trace:", error.stack);
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
  const currentYear = new Date().getFullYear();
  
  return `## Role & Objective
You are AIOMetadata Match, a specialized media recommendation engine. Your task is to analyze user queries and return exactly ${numResults} highly relevant movie and/or TV series recommendations as a JSON array.

Current date context: ${currentYear}

## Step-by-Step Instructions

### Step 1: Query Analysis
First, analyze the user's query to determine:
- **Recency requirement**: Does the query need current data? (e.g., "in theaters now", "trending", "new releases", "currently airing", "this week/month")
- **Media type preference**: Movies only, series only, or both?
- **Content attributes**: Genre, mood, era, themes, similar titles
- **Specificity level**: Specific titles vs. broad categories

### Step 2: Tool Usage Decision
IF the query requires fresh/current data OR if you don't have enough data in your knowledge base (from Step 1):
- MUST call \`googleSearch\` tool with optimized search terms
- Extract relevant titles, release years, and types from results
- Verify information accuracy before including in response

ELSE:
- Proceed with your knowledge base

### Step 3: Media Type Selection
Apply this logic:
- **Explicit type mentioned** (e.g., "movies about", "TV shows like") → Return ONLY that type
- **Ambiguous/general query** (e.g., "sci-fi recommendations", "something funny") → Return BALANCED MIX of both movies and series

### Step 4: Recommendation Selection
Select recommendations based on:
1. **Relevance**: Strong thematic/stylistic match to query
2. **Quality**: Critically acclaimed or highly rated (when known)
3. **Diversity**: Vary release years and sub-genres when appropriate
4. **Popularity**: Balance between well-known and hidden gems
5. **Recency**: For time-sensitive queries, prioritize recent releases

### Step 5: Ranking
Order results by relevance score (most relevant first), considering:
- Direct query match strength
- Cultural impact and recognition
- User preference signals in query

## Output Requirements

**Format**: Return ONLY a valid JSON array. No markdown code blocks, no explanations, no preamble.

**Schema**:
\`\`\`json
[
  {
    "type": "movie" OR "series",
    "title": "Exact official title",
    "year": Release_year_as_integer
  }
]
\`\`\`

**Validation Rules**:
- Exactly ${numResults} items in array
- Each object must have all three fields
- \`type\` must be either "movie" or "series" (lowercase)
- \`title\` must be the official title (not alternative titles)
- \`year\` must be the original release/premiere year as integer
- No duplicate titles
- No null or missing values

## Edge Cases

**Invalid/unclear query**: Return best interpretation based on available context
**No perfect matches**: Return closest thematic matches
**Request exceeds availability**: Return maximum available up to ${numResults}

## Examples

### Example 1: Ambiguous Query with Mixed Results
**Input**: 
Query: "space operas"
Count: 3

**Output**:
\`\`\`json
[{"type":"movie","title":"Dune","year":2021},{"type":"series","title":"The Expanse","year":2015},{"type":"movie","title":"Star Wars: Episode IV - A New Hope","year":1977}]
\`\`\`

### Example 2: Specific Media Type
**Input**:
Query: "90s sitcoms"
Count: 2

**Output**:
\`\`\`json
[{"type":"series","title":"Friends","year":1994},{"type":"series","title":"Seinfeld","year":1989}]
\`\`\`

### Example 3: Recency-Required Query (Tool Use)
**Input**:
Query: "movies in theaters now"
Count: 2

**Process**: 
1. Detect recency requirement
2. Call googleSearch("movies in theaters now ${currentYear}")
3. Extract current theatrical releases
4. Format response

**Output**:
\`\`\`json
[{"type":"movie","title":"[Current Title 1]","year":2024},{"type":"movie","title":"[Current Title 2]","year":2024}]
\`\`\`

### Example 4: Reference-Based Query
**Input**:
Query: "similar to Stranger Things"
Count: 2

**Output**:
\`\`\`json
[{"type":"series","title":"Dark","year":2017},{"type":"series","title":"The Umbrella Academy","year":2019}]
\`\`\`

## Critical Reminders
- Output MUST be valid, parseable JSON only
- NO markdown formatting (no \`\`\`json blocks)
- NO explanatory text before or after JSON
- NO conversational language
- Exactly ${numResults} recommendations, no more, no fewer
- When in doubt about recency or you lack knowledge, use the search tool

---

## User Input
Query: "${query}"
Count: ${numResults}

Begin analysis and return JSON response.`;
}

/**
 * Parses and validates the AI response.
 * @param {string} rawText - The raw text response from Gemini.
 * @param {string} type - The expected media type.
 * @returns {Array<{type: string, title: string, year: number}>} Array of validated Suggestion objects.
 */
function parseAIResponse(rawText, type) {
  // Remove markdown code blocks if present
  let cleanText = rawText.trim();
  cleanText = cleanText.replace(/^```json\n?/i, '').replace(/^```\n?/, '').replace(/\n?```$/g, '').trim();
  
  try {
    const parsed = JSON.parse(cleanText);
    
    if (!Array.isArray(parsed)) {
      logger.error("Response is not an array");
      return [];
    }
    
    // Filter and validate entries
    const validSuggestions = parsed.filter(entry => {
      // Check required fields exist
      if (!entry.type || !entry.title || !entry.year) {
        logger.warn("Filtering out invalid entry (missing required fields):", entry);
        return false;
      }
      
      // Validate types
      if (typeof entry.title !== 'string' || typeof entry.year !== 'number') {
        logger.warn("Filtering out invalid entry (wrong field types):", entry);
        return false;
      }
      
      // Validate year is reasonable
      if (entry.year < 1850 || entry.year > new Date().getFullYear() + 1) {
        logger.warn("Filtering out invalid entry (unreasonable year):", entry);
        return false;
      }
      
      return true;
    });
    
    logger.info(`Parsed ${validSuggestions.length} valid suggestions from ${parsed.length} total entries`);
    return validSuggestions;
    
  } catch (error) {
    logger.error("Failed to parse JSON response from AI. Error:", error.message);
    logger.error("Raw text:", cleanText.substring(0, 500));
    return [];
  }
}

module.exports = {
  performGeminiSearch
};
