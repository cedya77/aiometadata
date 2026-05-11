import 'dotenv/config';
import consola from 'consola';
import { generateContent } from './openrouter-client';
import { buildPrompt, parseAIResponse } from './gemini-service';

const logger = consola.withTag('OpenRouterService');

const DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.5-flash';

interface Suggestion {
  type: string;
  title: string;
  year: number;
}

async function performOpenRouterSearch(apiKey: string, query: string, type: 'movie' | 'series' | 'mixed', language: string, model?: string): Promise<Suggestion[]> {
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
    const suggestions = parseAIResponse(rawText || '', type);
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
    logger.error(`Error during AI search (model: ${selectedModel}, key: ${keyHint}):`, error.message);
    if (error.statusCode) {
      logger.error(`HTTP status: ${error.statusCode}`);
    }
    logger.debug("Stack trace:", error.stack);
    return [];
  }
}

export { performOpenRouterSearch };
module.exports = { performOpenRouterSearch };
