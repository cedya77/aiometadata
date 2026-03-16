require('dotenv').config();
const { generateContent } = require('./openrouter-client');
const { buildPrompt, parseAIResponse } = require('./gemini-service');
const consola = require('consola');

const logger = consola.withTag('OpenRouterService');

const DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.5-flash';

/**
 * Performs AI-powered search via OpenRouter.
 *
 * @param {string} apiKey - The OpenRouter API key.
 * @param {string} query - The user's natural language search query.
 * @param {'movie' | 'series' | 'mixed'} type - The type of media to search for.
 * @param {string} language
 * @param {string} [model] - The OpenRouter model ID.
 * @returns {Promise<Array<{type: string, title: string, year: number}>>} Array of suggestions.
 */
async function performOpenRouterSearch(apiKey, query, type, language, model) {
  const startTime = Date.now();

  if (!apiKey) {
    logger.warn("Search failed: no API key provided.");
    return [];
  }

  const selectedModel = model || DEFAULT_OPENROUTER_MODEL;
  // :online suffix = OpenRouter web search plugin injects search results into context
  const hasWebSearch = selectedModel.endsWith(':online');
  const timeout = hasWebSearch ? 45000 : 30000;

  logger.debug(`Using model: ${selectedModel}, webSearch: ${hasWebSearch}, timeout: ${timeout}ms`);

  try {
    const generationStart = Date.now();

    const prompt = buildPrompt(query, type, 20, hasWebSearch ? 'context' : false);

    const response = await generateContent({
      apiKey,
      model: selectedModel,
      prompt,
      timeout,
    });

    const rawText = response.text;

    if (!rawText) {
      logger.debug('OpenRouter returned no text response');
    }

    const generationTime = Date.now() - generationStart;
    logger.debug(`AI generation completed in ${generationTime}ms`);
    logger.debug(`OpenRouter raw response: ${rawText}`);

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
    logger.error(`Error during AI search (model: ${selectedModel}, key: ${keyHint}):`, error.message);
    if (error.statusCode) {
      logger.error(`HTTP status: ${error.statusCode}`);
    }
    logger.debug("Stack trace:", error.stack);
    return [];
  }
}

module.exports = {
  performOpenRouterSearch,
};
