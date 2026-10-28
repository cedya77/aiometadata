const net = require('node:net');
const { request, Agent, setGlobalDispatcher, ProxyAgent } = require("undici");
const buildInfo = require('../lib/buildInfo');
const { withRetries, isRetryableNetworkError } = require('./retry');
const { noteTrackerCall } = require('./trackerCalls');

net.setDefaultAutoSelectFamilyAttemptTimeout(1_000);

const getProxyUrl = (): string | null => {
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (proxy) {
    try {
      return new URL(proxy).toString();
    } catch (error) {
      console.warn('Invalid proxy URL in HTTP_PROXY/HTTPS_PROXY:', proxy);
      return null;
    }
  }
  return null;
};

// Idle connections outlive undici's 4 s default, so bursts reuse their TLS sessions.
export const KEEP_ALIVE = {
  keepAliveTimeout: parseInt(process.env.HTTP_KEEPALIVE_TIMEOUT_MS || '', 10) || 60_000,
  keepAliveMaxTimeout: parseInt(process.env.HTTP_KEEPALIVE_MAX_TIMEOUT_MS || '', 10) || 600_000,
};

const proxyUrl = getProxyUrl();

/** Calls the addon makes to itself, which a proxy can neither see nor reach. */
export const directDispatcher = new Agent({ allowH2: false, ...KEEP_ALIVE });

if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent({ uri: proxyUrl, allowH2: false }));
} else {
  setGlobalDispatcher(directDispatcher);
}

const DEFAULT_RETRY_ATTEMPTS = 1;
const BOOTSTRAP_CONNECT_TIMEOUT_MS = 3_000;

const bootstrapDispatcher = proxyUrl
  ? new ProxyAgent({ uri: proxyUrl, allowH2: false, connect: { timeout: BOOTSTRAP_CONNECT_TIMEOUT_MS } })
  : new Agent({ allowH2: false, connect: { timeout: BOOTSTRAP_CONNECT_TIMEOUT_MS } });

/** Spread into startup downloads that must survive a transient network blip. */
export const BOOTSTRAP_HTTP_OPTIONS = { retryAttempts: 3, dispatcher: bootstrapDispatcher };

interface HttpRequestOptions {
  method?: string;
  data?: any;
  headers?: Record<string, string>;
  timeout?: number;
  dispatcher?: any;
  params?: Record<string, string>;
  retryAttempts?: number;
  validateStatus?: (status: number) => boolean;
  /** undici closes the socket after every HEAD unless this is false. */
  reset?: boolean;
}

interface HttpResponse {
  data: any;
  status: number;
  headers: Record<string, string>;
}

interface HttpError extends Error {
  response?: {
    status: number;
    data?: string;
    headers?: Record<string, string>;
  };
}

export async function httpRequest(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  const {
    method = 'GET',
    data,
    headers = {},
    timeout = 8000,
    dispatcher,
    params,
    validateStatus,
    reset
  } = options;

  if (params) {
    const qs = new URLSearchParams(params).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }

  const requestOptions: any = {
    method,
    headers: {
      'User-Agent': `AIOMetadata/${buildInfo.version}`,
      ...headers
    },
    bodyTimeout: timeout,
    headersTimeout: timeout,
    // No connectTimeout here: undici only honours it on the dispatcher.
    dispatcher: dispatcher || undefined,
    ...(reset !== undefined ? { reset } : {}),
  };

  if (data) {
    requestOptions.body = JSON.stringify(data);
    if (!requestOptions.headers['Content-Type']) {
      requestOptions.headers['Content-Type'] = 'application/json';
    }
  }

  let response: any;
  try {
    response = await request(url, requestOptions);
  } catch (error) {
    noteTrackerCall(url, 0);
    throw error;
  }
  const { statusCode, headers: responseHeaders, body } = response;

  const contentType =
    responseHeaders['content-type'] ||
    responseHeaders['Content-Type'] ||
    '';

  if (statusCode >= 200 && statusCode < 300) {
    noteTrackerCall(url, statusCode);
    if (method === 'HEAD') {
      return {
        data: null,
        status: statusCode,
        headers: responseHeaders
      };
    }

    const text = await body.text();
    const responseData = contentType.includes('application/json')
      ? (text ? JSON.parse(text) : null)
      : text;

    return {
      data: responseData,
      status: statusCode,
      headers: responseHeaders
    };
  } else if (statusCode === 304) {
    await body.dump();
    if (validateStatus?.(304)) {
      noteTrackerCall(url, statusCode);
      return { data: null, status: statusCode, headers: responseHeaders };
    }
    const error: HttpError = new Error(`Not Modified`);
    error.response = {
      status: 304,
      headers: responseHeaders
    };
    throw error;
  } else {
    const errorText = await body.text();
    noteTrackerCall(url, statusCode, errorText, responseHeaders['retry-after']);
    const error: HttpError = new Error(`Request failed with status code ${statusCode}`);
    error.response = {
      status: statusCode,
      data: errorText,
      headers: responseHeaders
    };
    throw error;
  }
}

const MAX_REDIRECTS = 3;

async function requestFollowingRedirects(
  url: string,
  options: HttpRequestOptions,
  method: string,
  data?: any
): Promise<HttpResponse> {
  let currentUrl = url;
  // Only override options.data when a body was actually supplied.
  const overrides = data === undefined ? { method } : { method, data };

  for (let i = 0; i < MAX_REDIRECTS; i++) {
    try {
      return await httpRequest(currentUrl, { ...options, ...overrides });
    } catch (error: any) {
      const status = error?.response?.status;
      const locationHeader = error?.response?.headers?.location || error?.response?.headers?.Location;
      const isRedirect = status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
      if (isRedirect && locationHeader) {
        currentUrl = new URL(locationHeader, currentUrl).toString();
        continue;
      }
      throw error;
    }
  }

  return httpRequest(currentUrl, { ...options, ...overrides });
}

/**
 * Retries only transport faults, never HTTP statuses: a 404 is an answer, a
 * dropped connection is not. Redirect following happens inside each attempt.
 */
function withTransportRetries(
  url: string,
  attempts: number,
  work: () => Promise<HttpResponse>
): Promise<HttpResponse> {
  return withRetries(work, {
    attempts,
    shouldRetry: isRetryableNetworkError,
    onRetry: ({ attempt, delayMs, error }: any) => {
      console.warn(`[HTTP] ${url} failed (${error?.code || error?.message}); retry ${attempt} in ${delayMs}ms`);
    }
  });
}

export async function httpGet(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  return withTransportRetries(url, options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS, () =>
    requestFollowingRedirects(url, options, 'GET'));
}

// Only ever retried when a caller opts in: POST is not assumed idempotent.
export async function httpPost(url: string, data: any, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  return withTransportRetries(url, options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS, () =>
    requestFollowingRedirects(url, options, 'POST', data));
}

export async function httpHead(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  return withTransportRetries(url, options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS, () =>
    requestFollowingRedirects(url, options, 'HEAD'));
}

/** Exposed so the opt-in policy is pinned by a test rather than by convention. */
export const retryPolicy = { defaultAttempts: DEFAULT_RETRY_ATTEMPTS };
