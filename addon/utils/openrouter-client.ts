// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { request, Agent, ProxyAgent } from 'undici';
import { aiEndpointBase, isCustomAiEndpoint } from './ai-endpoint';

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
  /**
   * Without this OpenRouter reserves the model's full output window and refuses
   * the request unless the balance covers that worst case, which on a big model
   * is tens of thousands of tokens for a reply of a few hundred.
   */
  maxTokens?: number;
  /**
   * Thinking is billed and counted against maxTokens, and several models refuse
   * to turn it off, so it is capped rather than disabled.
   */
  reasoningEffort?: string;
}

interface GenerateContentResult {
  text: string | null;
  /** Normalised where OpenRouter provides it, otherwise the provider's own. */
  finishReason: string | null;
  /**
   * Token counts and cost as OpenRouter billed them. The prompt count is the
   * only way to see whether an `:online` model pasted search results in, since
   * nothing else in the reply says that it searched.
   */
  usage: { promptTokens?: number; completionTokens?: number; cost?: number } | null;
}

async function generateContent({ apiKey, model, prompt, systemPrompt, timeout = 30000, maxTokens = 8192, reasoningEffort }: GenerateContentOptions): Promise<GenerateContentResult> {
  const custom = isCustomAiEndpoint();
  const url = `${aiEndpointBase()}/chat/completions`;
  const startTime = Date.now();

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const body: any = {
    model,
    messages,
    max_tokens: maxTokens,
  };

  // `reasoning` is OpenRouter's own field; other servers name it differently or refuse it.
  if (reasoningEffort && !custom) {
    body.reasoning = { effort: reasoningEffort };
  }

  const send = async (payload: any): Promise<{ statusCode: number; data: any }> => {
    const { statusCode, body: responseBody } = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      dispatcher: openrouterDispatcher,
      headersTimeout: timeout,
      bodyTimeout: timeout,
    });
    if (!custom) return { statusCode, data: await responseBody.json() };
    // A model server can answer an error in plain text.
    const text = await responseBody.text();
    try {
      return { statusCode, data: JSON.parse(text) };
    } catch {
      return { statusCode, data: { error: { message: `HTTP ${statusCode}: ${text.slice(0, 200)}` } } };
    }
  };

  try {
    let { statusCode, data } = await send(body);
    // OpenAI's reasoning models refuse max_tokens and take max_completion_tokens instead.
    if (custom && statusCode === 400 && /max_tokens/.test(String(data?.error?.message ?? ''))) {
      const { max_tokens: limit, ...rest } = body;
      ({ statusCode, data } = await send({ ...rest, max_completion_tokens: limit }));
    }
    const responseTime = Date.now() - startTime;

    if (statusCode !== 200) {
      const requestTracker = require('../lib/requestTracker');
      requestTracker.trackProviderCall('openrouter', responseTime, false);

      const errorMessage = data?.error?.message || `HTTP ${statusCode}`;
      const error: any = new Error(`${custom ? 'AI endpoint' : 'OpenRouter API'} error: ${errorMessage}`);
      error.statusCode = statusCode;
      error.response = data;
      throw error;
    }

    const requestTracker = require('../lib/requestTracker');
    requestTracker.trackProviderCall('openrouter', responseTime, true);

    const choice = data?.choices?.[0];
    const text = choice?.message?.content || null;

    return {
      text,
      finishReason: choice?.finish_reason || choice?.native_finish_reason || null,
      usage: data?.usage
        ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          cost: data.usage.cost,
        }
        : null,
    };
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
