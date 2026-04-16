const { request } = require('undici');
const { createDispatcher } = require('./httpClient.js');

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// OpenRouter dispatcher
// priority: OPENROUTER_HTTPS_PROXY/OPENROUTER_HTTP_PROXY > HTTPS_PROXY/HTTP_PROXY > direct
const openrouterDispatcher = createDispatcher({
  label: 'OpenRouter',
  proxyEnvVars: ['OPENROUTER_HTTPS_PROXY', 'OPENROUTER_HTTP_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY'],
  agentOptions: {
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
    connections: 50,
    pipelining: 1,
  },
});

/**
 * Generate content using OpenRouter API (OpenAI-compatible).
 *
 * @param {Object} options
 * @param {string} options.apiKey - OpenRouter API key
 * @param {string} options.model - Model ID (e.g., 'google/gemini-2.5-flash')
 * @param {string} options.prompt - Text prompt to send
 * @param {number} [options.timeout=30000] - Request timeout in ms
 * @returns {Promise<{text: string|null}>}
 */
async function generateContent({ apiKey, model, prompt, timeout = 30000 }) {
  const url = `${OPENROUTER_BASE_URL}/chat/completions`;
  const startTime = Date.now();

  const body = {
    model,
    messages: [
      { role: 'user', content: prompt }
    ],
  };

  try {
    const { statusCode, body: responseBody } = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      dispatcher: openrouterDispatcher,
      headersTimeout: timeout,
      bodyTimeout: timeout,
    });

    const data = await responseBody.json();
    const responseTime = Date.now() - startTime;

    if (statusCode !== 200) {
      const requestTracker = require('../lib/requestTracker');
      requestTracker.trackProviderCall('openrouter', responseTime, false);

      const errorMessage = data?.error?.message || `HTTP ${statusCode}`;
      const error = new Error(`OpenRouter API error: ${errorMessage}`);
      error.statusCode = statusCode;
      error.response = data;
      throw error;
    }

    const requestTracker = require('../lib/requestTracker');
    requestTracker.trackProviderCall('openrouter', responseTime, true);

    const text = data?.choices?.[0]?.message?.content || null;

    return { text };
  } catch (error) {
    const responseTime = Date.now() - startTime;

    if (!error.statusCode) {
      const requestTracker = require('../lib/requestTracker');
      requestTracker.trackProviderCall('openrouter', responseTime, false);
    }

    throw error;
  }
}

function getAgentStats() {
  return openrouterDispatcher.stats;
}

async function closeAgent() {
  await openrouterDispatcher.close();
}

module.exports = {
  generateContent,
  getAgentStats,
  closeAgent,
};
