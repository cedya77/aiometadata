import 'dotenv/config';
import consola from 'consola';
import { generateContent } from './openrouter-client';
import { buildPrompt, parseAIResponse } from './gemini-service';

const logger = consola.withTag('OllamaService');

const DEFAULT_OLLAMA_URL = 'http://host.docker.internal:11434';
const DEFAULT_OLLAMA_MODEL = 'llama3.2';

interface Suggestion {
  type: string;
  title: string;
  year: number;
}

function normalizeOllamaUrl(ollamaUrl: string): string {
  const base = (ollamaUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

async function performOllamaSearch(ollamaUrl: string, query: string, type: 'movie' | 'series' | 'mixed', language: string, model?: string): Promise<Suggestion[]> {
  const startTime = Date.now();
  const baseUrl = normalizeOllamaUrl(ollamaUrl || DEFAULT_OLLAMA_URL);
  const selectedModel = model || DEFAULT_OLLAMA_MODEL;

  logger.debug(`Using model: ${selectedModel}, baseUrl: ${baseUrl}`);

  try {
    const prompt = buildPrompt(query, type, 20, false);

    const response = await generateContent({
      baseUrl,
      model: selectedModel,
      prompt,
      timeout: 60000,
      provider: 'ollama',
    });

    const rawText = response.text;

    if (!rawText) {
      logger.debug('Ollama returned no text response');
    }

    const generationTime = Date.now() - startTime;
    logger.debug(`AI generation completed in ${generationTime}ms`);
    logger.debug(`Ollama raw response: ${rawText}`);

    const suggestions = parseAIResponse(rawText || '', type);

    const totalTime = Date.now() - startTime;
    logger.debug(`Total search time: ${totalTime}ms, returned ${suggestions.length} suggestions`);

    if (totalTime > 15000) {
      logger.warn(`WARNING: Ollama search took longer than 15 seconds (${totalTime}ms)`);
    }

    return suggestions;

  } catch (error: any) {
    logger.error(`Error during Ollama search (model: ${selectedModel}, url: ${baseUrl}):`, error.message);
    if (error.statusCode) {
      logger.error(`HTTP status: ${error.statusCode}`);
    }
    logger.debug('Stack trace:', error.stack);
    return [];
  }
}

export { performOllamaSearch };
module.exports = { performOllamaSearch };
