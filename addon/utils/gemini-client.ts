const { request, Agent, ProxyAgent }: any = require('undici');

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

interface GenerateContentOptions {
  apiKey: string;
  model: string;
  prompt: string;
  systemPrompt?: string;
  useGrounding?: boolean;
  timeout?: number;
}

interface GenerateContentResult {
  text: string | null;
  candidates: any[];
  groundingMetadata: any | null;
  promptFeedback: any | null;
  finishReason: string | null;
  safetyRatings: any | null;
}

const getGeminiProxyUrl = (): string | null => {
  const geminiProxy = process.env.GEMINI_HTTPS_PROXY ?? process.env.GEMINI_HTTP_PROXY;
  if (geminiProxy) {
    try {
      return new URL(geminiProxy).toString();
    } catch (error: any) {
      console.warn('Invalid Gemini proxy URL:', geminiProxy);
    }
  }
  const globalProxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (globalProxy) {
    try {
      return new URL(globalProxy).toString();
    } catch (error: any) {
      console.warn('Invalid global proxy URL:', globalProxy);
    }
  }
  return null;
};

const createGeminiDispatcher = (): any => {
  const proxyUrl = getGeminiProxyUrl();
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

const geminiDispatcher: any = createGeminiDispatcher();

async function generateContent({ apiKey, model, prompt, systemPrompt, useGrounding = false, timeout = 30000 }: GenerateContentOptions): Promise<GenerateContentResult> {
  const url = `${GEMINI_BASE_URL}/models/${model}:generateContent`;
  const startTime = Date.now();

  const body: any = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ]
  };

  if (systemPrompt) {
    body.system_instruction = { parts: [{ text: systemPrompt }] };
  }

  if (useGrounding) {
    body.tools = [{ google_search: {} }];
  }

  const headersTimeout = timeout;
  const bodyTimeout = Math.min(timeout, 30000);

  try {
    const { statusCode, body: responseBody } = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      dispatcher: geminiDispatcher,
      headersTimeout,
      bodyTimeout,
    });

    const data = await responseBody.json();
    const responseTime = Date.now() - startTime;

    if (statusCode !== 200) {
      const requestTracker: any = require('../lib/requestTracker');
      requestTracker.trackProviderCall('gemini', responseTime, false);

      const errorMessage = data?.error?.message || `HTTP ${statusCode}`;
      const error: any = new Error(`Gemini API error: ${errorMessage}`);
      error.statusCode = statusCode;
      error.response = data;
      throw error;
    }

    const requestTracker: any = require('../lib/requestTracker');
    requestTracker.trackProviderCall('gemini', responseTime, true);

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
  } catch (error: any) {
    const responseTime = Date.now() - startTime;

    if (!error.statusCode) {
      const requestTracker: any = require('../lib/requestTracker');
      requestTracker.trackProviderCall('gemini', responseTime, false);
    }

    throw error;
  }
}

function getAgentStats(): any {
  return geminiDispatcher.stats;
}

async function closeAgent(): Promise<void> {
  await geminiDispatcher.close();
}

export { generateContent, getAgentStats, closeAgent };
module.exports = { generateContent, getAgentStats, closeAgent };
