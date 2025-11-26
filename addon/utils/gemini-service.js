require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash-lite";

const clientCache = new Map();

function getGeminiClient(apiKey) {
  if (!apiKey) return null;
  if (clientCache.has(apiKey)) return clientCache.get(apiKey);

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: DEFAULT_GEMINI_MODEL });
    console.log(`[GeminiService] Caching new client for API key ending in ...${apiKey.slice(-4)}`);
    clientCache.set(apiKey, model);
    return model;
  } catch (error) {
    console.error(`[GeminiService] Failed to initialize client for key ...${apiKey.slice(-4)}`);
    clientCache.set(apiKey, null);
    return null;
  }
}

/**
 * Translates a given query to English if it's not already.
 * @param {string} query - The user's search query.
 * @returns {Promise<string>} - The English translation of the query.
 */
async function _translateToEnglish(model, query) {
  // NOTE: This will fail in its current form because `this.model` is not defined.
  // This fix addresses alignment only, as requested.
  if (!model) return query;
  try {
    const prompt = `Translate the following search query to English. Return ONLY the translated text and nothing else:\n\n"${query}"`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text().trim();
  } catch (error) {
    console.error("[GeminiService] Error translating query:", error);
    return query; // Fallback to the original query on error
  }
}

/**
 * @param {string} query - The user's natural language search query.
 * @param {'movie' | 'series' | 'anime'} type - The type of media to search for.
 * @returns {Promise<Array<object>>} A promise that resolves to an array of objects, e.g., [{ title: "The Matrix" }] or [{ english_title: "Attack on Titan", romaji_title: "Shingeki no Kyojin" }]
 */
async function performGeminiSearch(apiKey, query, type, language) {
  const model = getGeminiClient(apiKey);

  // 2. If no client is available, fail gracefully.
  if (!model) {
    console.warn("[GeminiService] Search failed: client not available for the provided key.");
    return [];
  }

  const timerLabel = `[GeminiService] AI search for "${query}" (type: ${type})`;
  console.time(timerLabel);

  try {
    const englishQuery = await _translateToEnglish(model, query);
    const prompt = _buildPrompt(englishQuery, type, language);

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const responseText = response.text();
    return _parseJsonResponse(responseText);

  } catch (error) {
    console.error("[GeminiService] A critical error occurred during AI search:", error);
    return [];
  } finally {
    console.timeEnd(timerLabel);
  }
}

/**
 * A helper function to construct the detailed prompt for the AI.
 * @param {string} query - The translated English query.
 * @param {'movie' | 'series' | 'anime'} type - The media type.
 * @returns {string} The formatted prompt.
 */
function _buildPrompt(query, type, language) {
  if (type === 'anime') {
    return `You are an expert anime database assistant. Your task is to return a structured list of anime based on a user's query.

User's search: "${query}"

Instructions:
1.  Analyze the query for context, intent, genre, theme, mood, and plot elements.
2.  For each relevant anime, provide its most common **English title**, its **release year**, its unique integer **MyAnimeList ID** and its original **title**.
3.  Return the results as a valid JSON array of objects. Each object MUST have "english_title" (string), "year" (integer), "mal_id" (integer) and "title" (string) keys.
4.  Do not include any text, explanations, or markdown formatting outside of the JSON array.
5.  Return a maximum of 20 highly relevant results.

Example response if the target language was Spanish:
[
  {
    "english_title": "One Punch Man",
    "year": 2015,
    "mal_id": 30276
  }
]
`;
  }

  return `You are a movie and TV show expert recommender. Your task is to analyze the user's search query and return a structured list of the most relevant titles.

User's search: "${query}"
Media Type: ${type}

Instructions:
1.  Analyze the context, intent, genre, theme, mood, style, time period, and specific plot elements mentioned in the query.
2.  For each relevant ${type} you find, provide its exact and original **English title** and its imdb_id.
3.  Return the results as a valid JSON array of objects, where each object has a "title" key.
4.  Do not include any explanations, markdown formatting, or any text outside of the final JSON array.
5.  Prioritize popular and critically acclaimed results that are highly relevant to the search intent.
6.  Return a maximum of 20 results.

Example response for a search like "murder mystery in a small village":
[
  {
    "title": "Broadchurch",
    "imdb_id": "tt2249364"
  },
  {
    "title": "Hot Fuzz",
    "imdb_id": "tt0425112"
  },
  {
    "title": "Mare of Easttown",
    "imdb_id": "tt10155688"
  }
]
`;
}

/**
 * Safely parses the JSON response from the AI.
 * @param {string} text - The raw text response from Gemini.
 * @returns {Array<object>} The parsed array of title objects, or an empty array on failure.
 */
function _parseJsonResponse(text) {
  const cleanText = text.replace(/^```json\n?/, '').replace(/```$/, '').trim();
  try {
    const parsed = JSON.parse(cleanText);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error)
  {
    console.error("[GeminiService] Failed to parse JSON response from AI. Raw text:", cleanText);
    return [];
  }
}

module.exports = {
  performGeminiSearch
};
