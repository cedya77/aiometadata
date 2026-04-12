const { request, Agent, ProxyAgent } = require('undici');

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// OpenRouter dispatcher configuration
// Priority: OPENROUTER_HTTPS_PROXY/OPENROUTER_HTTP_PROXY > HTTPS_PROXY/HTTP_PROXY > direct connection
const getOpenRouterProxyUrl = () => {
  const orProxy = process.env.OPENROUTER_HTTPS_PROXY ?? process.env.OPENROUTER_HTTP_PROXY;
  if (orProxy) {
    try {
      return new URL(orProxy).toString();
    } catch (error) {
      console.warn('Invalid OpenRouter proxy URL:', orProxy);
    }
  }
  const globalProxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (globalProxy) {
    try {
      return new URL(globalProxy).toString();
    } catch (error) {
      console.warn('Invalid global proxy URL:', globalProxy);
    }
  }
  return null;
};

const createOpenRouterDispatcher = () => {
  const proxyUrl = getOpenRouterProxyUrl();
  if (proxyUrl) {
    return new ProxyAgent({ uri: proxyUrl, allowH2: false });
  }
  return new Agent({
    allowH2: false,
    keepAliveTimeout: 30000,
    keepAliveMaxTimeout: 60000,
    connections: 50,
    pipelining: 1,
  });
};

const openrouterDispatcher = createOpenRouterDispatcher();

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
