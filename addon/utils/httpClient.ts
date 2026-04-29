const { request, Agent, setGlobalDispatcher, ProxyAgent } = require("undici");
const buildInfo = require('../lib/buildInfo');

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

const proxyUrl = getProxyUrl();
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent({ uri: proxyUrl, allowH2: false }));
} else {
  setGlobalDispatcher(new Agent({ allowH2: false }));
}

interface HttpRequestOptions {
  method?: string;
  data?: any;
  headers?: Record<string, string>;
  timeout?: number;
  dispatcher?: any;
  params?: Record<string, string>;
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
    params
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
    connectTimeout: timeout,
    dispatcher: dispatcher || undefined,
  };

  if (data) {
    requestOptions.body = JSON.stringify(data);
    if (!requestOptions.headers['Content-Type']) {
      requestOptions.headers['Content-Type'] = 'application/json';
    }
  }

  const { statusCode, headers: responseHeaders, body } = await request(url, requestOptions);

  const contentType =
    responseHeaders['content-type'] ||
    responseHeaders['Content-Type'] ||
    '';

  if (statusCode >= 200 && statusCode < 300) {
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
    const error: HttpError = new Error(`Not Modified`);
    error.response = {
      status: 304,
      headers: responseHeaders
    };
    throw error;
  } else {
    const errorText = await body.text();
    const error: HttpError = new Error(`Request failed with status code ${statusCode}`);
    error.response = {
      status: statusCode,
      data: errorText,
      headers: responseHeaders
    };
    throw error;
  }
}

export async function httpGet(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  let currentUrl = url;
  for (let i = 0; i < 3; i++) {
    try {
      return await httpRequest(currentUrl, { ...options, method: 'GET' });
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
  return httpRequest(currentUrl, { ...options, method: 'GET' });
}

export async function httpPost(url: string, data: any, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  let currentUrl = url;
  for (let i = 0; i < 3; i++) {
    try {
      return await httpRequest(currentUrl, { ...options, method: 'POST', data });
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
  return httpRequest(currentUrl, { ...options, method: 'POST', data });
}

export async function httpHead(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  let currentUrl = url;
  for (let i = 0; i < 3; i++) {
    try {
      return await httpRequest(currentUrl, { ...options, method: 'HEAD' });
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
  return httpRequest(currentUrl, { ...options, method: 'HEAD' });
}
