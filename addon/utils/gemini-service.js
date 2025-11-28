require('dotenv').config();
const { generateContent } = require('./gemini-client');
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

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";

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
    const response = await ai.models.generateContent({
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
  const currentYear = new Date().getFullYear();
  
return `## Role & Objective
You are AIOMetadata Match, a specialized media recommendation engine. Your task is to analyze user queries and return exactly ${numResults} highly relevant movie and/or TV series recommendations as a JSON array.
Current date context: ${currentYear}

## Step-by-Step Instructions

### Step 1: Query Analysis
First, analyze the user's query to determine:
- **Media type preference**: Movies only, series only, or both?
- **Content attributes**: Genre, mood, era, themes, similar titles
- **Specificity level**: Specific titles vs. broad categories
- **Key search terms**: Extract the most relevant keywords for targeted searching

### Step 2: Mandatory Search Tool Usage
**CRITICAL**: You MUST ALWAYS use the \`googleSearch\` tool to find high-quality recommendations from reputable sources.

**Search Strategy**:
1. Construct targeted search queries based on the user's request
2. Include qualifiers like "best", "critically acclaimed", "highly rated" for quality
3. Add year context when relevant (e.g., "2024" for current content)
4. Examples of effective search queries:
   - "best psychological thriller movies critically acclaimed"
   - "top rated sci-fi series 2024"
   - "movies similar to Inception highly rated"
   - "new releases horror movies ${currentYear}"

**Search for Verification**:
- If you are NOT 100% confident about a title's release year, you MUST search to verify
- If you are NOT certain about the official title spelling, you MUST search to confirm
- For series, you MUST verify the FIRST air date (original premiere year), NOT the latest season

**NEVER guess or assume data** - always search when uncertain.

### Step 3: Media Type Selection
Apply this logic:
- **Explicit type mentioned** (e.g., "movies about", "TV shows like") → Return ONLY that type
- **Ambiguous/general query** (e.g., "sci-fi recommendations", "something funny") → Return BALANCED MIX of both movies and series

### Step 4: Data Extraction from Search Results
From search results, extract:
1. **Official title ONLY**: Use the exact official title with NO additional information
   - ✅ Correct: "Stranger Things"
   - ❌ Wrong: "Stranger Things Season 2", "Stranger Things (2016-2024)"
2. **Accurate release year**:
   - For **movies**: Use theatrical release year
   - For **series**: Use FIRST air date / premiere year (NOT latest season year)
     - Example: "Stranger Things" = 2016 (first aired), NOT 2025 (latest season)
3. **Correct media type**: Verify if it's a movie or series

### Step 5: Recommendation Selection
Select recommendations based on:
1. **Relevance**: Strong thematic/stylistic match to query
2. **Quality**: Critically acclaimed or highly rated (prioritize reputable sources)
3. **Diversity**: Vary release years and sub-genres when appropriate
4. **Popularity**: Balance between well-known and hidden gems
5. **Recency**: For time-sensitive queries, prioritize recent releases

### Step 6: Ranking
Order results by relevance score (most relevant first), considering:
- Direct query match strength
- Critical acclaim and ratings from reputable sources
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
- \`title\` must be the official title ONLY (no season numbers, year ranges, or extra info)
- \`year\` must be:
  - For movies: Original theatrical release year as integer
  - For series: First air date / premiere year as integer (NOT latest season)
- No duplicate titles
- No null or missing values
- ALL data must be verified through search - NO guessing

## Critical Data Accuracy Rules

**Title Formatting**:
- ✅ "The Office" (correct)
- ❌ "The Office (US)" (wrong - no country specifiers)
- ❌ "Breaking Bad Season 5" (wrong - no season info)
- ❌ "The Lord of the Rings: The Fellowship of the Ring Extended Edition" (wrong - use theatrical title)

**Year Accuracy for Series**:
- ✅ "Stranger Things" with year 2016 (correct - first aired)
- ❌ "Stranger Things" with year 2025 (wrong - latest season year)
- ✅ "Game of Thrones" with year 2011 (correct - first aired)
- ❌ "Game of Thrones" with year 2019 (wrong - final season year)

**When to Search**:
- ANY uncertainty about release year → SEARCH
- ANY uncertainty about official title spelling → SEARCH
- Need to verify if something is a movie or series → SEARCH
- ALL recommendation queries → SEARCH for quality sources

## Examples

### Example 1: Ambiguous Query with Mixed Results
**Input**: 
Query: "space operas"
Count: 3

**Process**:
1. Search: "best space opera movies series critically acclaimed"
2. Extract verified titles and years from reputable sources
3. Mix movies and series

**Output**:
\`\`\`json
[{"type":"movie","title":"Dune","year":2021},{"type":"series","title":"The Expanse","year":2015},{"type":"movie","title":"Star Wars","year":1977}]
\`\`\`

### Example 2: Specific Media Type
**Input**:
Query: "90s sitcoms"
Count: 2

**Process**:
1. Search: "best 90s sitcoms highly rated"
2. Verify first air dates
3. Return only series type

**Output**:
\`\`\`json
[{"type":"series","title":"Friends","year":1994},{"type":"series","title":"Seinfeld","year":1989}]
\`\`\`

### Example 3: Current/Recent Content
**Input**:
Query: "movies in theaters now"
Count: 2

**Process**: 
1. Search: "movies in theaters now ${currentYear}"
2. Extract current theatrical releases
3. Verify release years

**Output**:
\`\`\`json
[{"type":"movie","title":"[Current Title 1]","year":2024},{"type":"movie","title":"[Current Title 2]","year":2024}]
\`\`\`

### Example 4: Reference-Based Query
**Input**:
Query: "similar to Stranger Things"
Count: 2

**Process**:
1. Search: "series similar to Stranger Things highly rated"
2. Verify first air dates for each series
3. Use official titles only

**Output**:
\`\`\`json
[{"type":"series","title":"Dark","year":2017},{"type":"series","title":"The Umbrella Academy","year":2019}]
\`\`\`

## Critical Reminders
- **ALWAYS use googleSearch tool** for every recommendation request
- **NEVER guess** release years, titles, or media types - verify through search
- For series: Use FIRST air date, NOT latest season year
- Use official titles ONLY - no season numbers, no extra descriptors
- Output MUST be valid, parseable JSON only
- NO markdown formatting (no \`\`\`json blocks)
- NO explanatory text before or after JSON
- NO conversational language
- Exactly ${numResults} recommendations, no more, no fewer
- Prioritize reputable sources (IMDb, Rotten Tomatoes, Metacritic, major publications)

---

## User Input
Query: "${query}"
Count: ${numResults}

Begin by constructing your search query, then return JSON response.`;
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
