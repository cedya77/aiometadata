import { request, Agent, ProxyAgent } from 'undici';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function getOpenRouterProxyUrl(): string | null {
  const orProxy = process.env.OPENROUTER_HTTPS_PROXY ?? process.env.OPENROUTER_HTTP_PROXY;
  if (orProxy) {
    try {
      return new URL(orProxy).toString();
    } catch {
      console.warn('Invalid OpenRouter proxy URL:', orProxy);
    }
  }
  const globalProxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (globalProxy) {
    try {
      return new URL(globalProxy).toString();
    } catch {
      console.warn('Invalid global proxy URL:', globalProxy);
    }
  }
  return null;
}

function createOpenRouterDispatcher() {
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
}

const openrouterDispatcher = createOpenRouterDispatcher();

interface GenerateContentOptions {
  apiKey: string;
  model: string;
  prompt: string;
  systemPrompt?: string;
  timeout?: number;
}

interface GenerateContentResult {
  text: string | null;
}

async function generateContent({ apiKey, model, prompt, systemPrompt, timeout = 30000 }: GenerateContentOptions): Promise<GenerateContentResult> {
  const url = `${OPENROUTER_BASE_URL}/chat/completions`;
  const startTime = Date.now();

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const body = {
    model,
    messages,
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

    const data: any = await responseBody.json();
    const responseTime = Date.now() - startTime;

    if (statusCode !== 200) {
      const requestTracker = require('../lib/requestTracker');
      requestTracker.trackProviderCall('openrouter', responseTime, false);

      const errorMessage = data?.error?.message || `HTTP ${statusCode}`;
      const error: any = new Error(`OpenRouter API error: ${errorMessage}`);
      error.statusCode = statusCode;
      error.response = data;
      throw error;
    }

    const requestTracker = require('../lib/requestTracker');
    requestTracker.trackProviderCall('openrouter', responseTime, true);

    const text = data?.choices?.[0]?.message?.content || null;

    return { text };
  } catch (error: any) {
    const responseTime = Date.now() - startTime;

    if (!error.statusCode) {
      const requestTracker = require('../lib/requestTracker');
      requestTracker.trackProviderCall('openrouter', responseTime, false);
    }

    throw error;
  }
}

function getAgentStats() {
  return (openrouterDispatcher as any).stats;
}

async function closeAgent() {
  await openrouterDispatcher.close();
}

export { generateContent, getAgentStats, closeAgent };
module.exports = { generateContent, getAgentStats, closeAgent };
