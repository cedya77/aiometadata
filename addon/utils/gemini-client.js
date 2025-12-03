const { request, Agent, ProxyAgent } = require('undici');

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// Gemini-specific proxy configuration
// GEMINI_HTTP_PROXY or GEMINI_HTTPS_PROXY takes precedence over global proxy
const getGeminiProxyUrl = () => {
  const proxy = process.env.GEMINI_HTTP_PROXY ?? process.env.GEMINI_HTTPS_PROXY;
  if (proxy) {
    return new URL(proxy).toString();
  }
  return null;
};

// Create appropriate dispatcher based on proxy configuration
const createGeminiDispatcher = () => {
  const proxyUrl = getGeminiProxyUrl();
  if (proxyUrl) {
    return new ProxyAgent({ uri: proxyUrl });
  }
  // No Gemini-specific proxy, use regular Agent (bypasses global proxy)
  return new Agent({
    keepAliveTimeout: 30000,      // Keep connections alive for 30s
    keepAliveMaxTimeout: 60000,   // Max keep-alive time 60s
    connections: 50,              // Max concurrent connections
    pipelining: 1,                // HTTP/1.1 pipelining
  });
};

// Shared dispatcher for all requests to Gemini API
const geminiDispatcher = createGeminiDispatcher();

/**
 * Generate content using Gemini API with optional Google Search grounding.
 * 
 * @param {Object} options
 * @param {string} options.apiKey - Gemini API key
 * @param {string} options.model - Model name (e.g., 'gemini-2.5-flash-lite')
 * @param {string} options.prompt - Text prompt to send
 * @param {boolean} [options.useGrounding=false] - Enable Google Search grounding
 * @param {number} [options.timeout=30000] - Request timeout in ms
 * @returns {Promise<{text: string|null, candidates: Array, groundingMetadata: Object|null, promptFeedback: Object|null}>}
 */
async function generateContent({ apiKey, model, prompt, useGrounding = false, timeout = 30000 }) {
  const url = `${GEMINI_BASE_URL}/models/${model}:generateContent`;
  
  const body = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ]
  };

  if (useGrounding) {
    body.tools = [{ google_search: {} }];
  }

  const { statusCode, body: responseBody } = await request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
    dispatcher: geminiDispatcher,
    headersTimeout: timeout,
    bodyTimeout: timeout,
  });

  const data = await responseBody.json();

  if (statusCode !== 200) {
    const errorMessage = data?.error?.message || `HTTP ${statusCode}`;
    const error = new Error(`Gemini API error: ${errorMessage}`);
    error.statusCode = statusCode;
    error.response = data;
    throw error;
  }

  // Extract response data
  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text || null;
  const groundingMetadata = candidate?.groundingMetadata || null;

  return {
    text,
    candidates: data?.candidates || [],
    groundingMetadata,
    promptFeedback: data?.promptFeedback || null,
    finishReason: candidate?.finishReason || null,
    safetyRatings: candidate?.safetyRatings || null,
  };
}

/**
 * Get agent stats for monitoring/debugging.
 */
function getAgentStats() {
  return geminiDispatcher.stats;
}

/**
 * Close the agent and all connections (for graceful shutdown).
 */
async function closeAgent() {
  await geminiDispatcher.close();
}

module.exports = {
  generateContent,
  getAgentStats,
  closeAgent,
};
