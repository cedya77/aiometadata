const { request, setGlobalDispatcher, ProxyAgent, Agent, interceptors } = require("undici");
const buildInfo = require('../lib/buildInfo');

// Create a fresh DNS interceptor per direct dispatcher.
function createDnsInterceptor() {
  return interceptors.dns({ maxTTL: 60_000 });
}

/**
 * Creates an undici Dispatcher with DNS caching and optional proxy support.
 *
 * Priority when resolving the proxy:
 *   1. SOCKS proxy (socksProxyEnvVar)
 *   2. HTTP/HTTPS proxy (proxyEnvVars, checked left-to-right)
 *   3. Direct connection
 *
 * @param {object} [options={}]
 * @param {string[]} [options.proxyEnvVars=['HTTPS_PROXY','HTTP_PROXY']]
 *   Env-var names to check for an HTTP/HTTPS proxy URL, in priority order.
 *   Pass [] to skip proxy lookup and always use a direct connection.
 * @param {string}  [options.socksProxyEnvVar]
 *   Env-var name for a SOCKS4/5 proxy URL (requires the `fetch-socks` package).
 *   Checked before proxyEnvVars.
 * @param {object}  [options.agentOptions={}]
 *   Extra options forwarded to `new Agent()` for direct connections
 *   (e.g. { connections: 2, keepAliveTimeout: 10_000 }).
 * @param {object}  [options.proxyOptions={}]
 *   Extra options forwarded to `new ProxyAgent()` when a proxy is used
 *   (e.g. { requestTls: { timeout: 30_000 } }).
 * @param {string}  [options.label]
 *   Service name used in log output (e.g. 'TVmaze').
 * @returns {import('undici').Dispatcher}
 *   Dispatcher with DNS caching applied.
 */
function createDispatcher({
  proxyEnvVars = ['HTTPS_PROXY', 'HTTP_PROXY'],
  socksProxyEnvVar,
  agentOptions = {},
  proxyOptions = {},
  label,
} = {}) {
  const tag = label ? `[${label}]` : '[HTTP]';

  // 1. SOCKS proxy
  if (socksProxyEnvVar) {
    const socksUrl = process.env[socksProxyEnvVar];
    if (socksUrl) {
      try {
        const proxyUrlObj = new URL(socksUrl);
        if (proxyUrlObj.protocol === 'socks5:' || proxyUrlObj.protocol === 'socks4:') {
          const { socksDispatcher } = require('fetch-socks');
          const d = socksDispatcher({
            type: proxyUrlObj.protocol === 'socks5:' ? 5 : 4,
            host: proxyUrlObj.hostname,
            port: Number(proxyUrlObj.port),
            userId: proxyUrlObj.username,
            password: proxyUrlObj.password,
          });
          console.log(`${tag} SOCKS proxy enabled (${socksProxyEnvVar}).`);
          return d.compose(createDnsInterceptor());
        } else {
          console.warn(`${tag} Unsupported SOCKS protocol: ${proxyUrlObj.protocol}. Falling back.`);
        }
      } catch (error) {
        console.warn(`${tag} Invalid ${socksProxyEnvVar}. Falling back. Error: ${error.message}`);
      }
    }
  }

  // 2. HTTP/HTTPS proxy, try each env var in order
  for (const envVar of proxyEnvVars) {
    const proxyUrl = process.env[envVar];
    if (!proxyUrl) continue;
    try {
      const d = new ProxyAgent({ uri: new URL(proxyUrl).toString(), allowH2: false, ...proxyOptions });
      console.log(`${tag} Using proxy from ${envVar}.`);
      return d.compose(createDnsInterceptor());
    } catch (error) {
      console.warn(`${tag} Invalid proxy URL in ${envVar}. Falling back. Error: ${error.message}`);
    }
  }

  // 3. Direct connection
  const d = new Agent({ ...agentOptions });
  if (label) console.log(`${tag} Direct connection.`);
  return d.compose(createDnsInterceptor());
}

// Global dispatcher, all httpGet/httpPost/httpRequest calls use this unless
// a per-call dispatcher is passed explicitly.
const globalDispatcher = createDispatcher({ label: 'Global' });
setGlobalDispatcher(globalDispatcher);

/**
 * HTTP client wrapper optimized for MAXIMUM SPEED.
 * It uses a "fail-fast" strategy with a short timeout and NO retries.
 * This is designed to prioritize user-perceived latency above all.
 *
 * @param {string} url - The URL to request
 * @param {Object} options - Request options
 * @returns {Promise<Object>} Response object with data, status, headers
 */
async function httpRequest(url, options = {}) {
  const {
    method = 'GET',
    data,
    headers = {},
    timeout = 8000,
    dispatcher
  } = options;

  const requestOptions = {
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
    // HEAD usually has no body; don't try to parse
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
    const error = new Error(`Not Modified`);
    error.response = {
      status: 304,
      headers: responseHeaders
    };
    throw error;
  } else {
    const errorText = await body.text();
    const error = new Error(`Request failed with status code ${statusCode}`);
    error.response = {
      status: statusCode,
      data: errorText,
      headers: responseHeaders
    };
    throw error;
  }
}


/**
 * Convenience method for GET requests
 */
async function httpGet(url, options = {}) {
  // Follow up to 3 redirects for GET requests (handles 301/302/303/307/308)
  let currentUrl = url;
  for (let i = 0; i < 3; i++) {
    try {
      return await httpRequest(currentUrl, { ...options, method: 'GET' });
    } catch (error) {
      const status = error?.response?.status;
      const locationHeader = error?.response?.headers?.location || error?.response?.headers?.Location;
      const isRedirect = status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
      if (isRedirect && locationHeader) {
        // Resolve relative Location headers against the current URL
        currentUrl = new URL(locationHeader, currentUrl).toString();
        continue;
      }
      throw error;
    }
  }
  // Final attempt without further redirect handling
  return httpRequest(currentUrl, { ...options, method: 'GET' });
}

/**
 * Convenience method for POST requests
 */
async function httpPost(url, data, options = {}) {
  let currentUrl = url;
  for (let i = 0; i < 3; i++) {
    try {
      return await httpRequest(currentUrl, { ...options, method: 'POST', data });
    } catch (error) {
      const status = error?.response?.status;
      const locationHeader = error?.response?.headers?.location || error?.response?.headers?.Location;
      const isRedirect = status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
      if (isRedirect && locationHeader) {
        // Resolve relative Location headers against the current URL
        currentUrl = new URL(locationHeader, currentUrl).toString();
        continue;
      }
      throw error;
    }
  }
  return httpRequest(currentUrl, { ...options, method: 'POST', data });
}

/**
 * Convenience method for HEAD requests
 */
async function httpHead(url, options = {}) {
  let currentUrl = url;
  for (let i = 0; i < 3; i++) {
    try {
      return await httpRequest(currentUrl, { ...options, method: 'HEAD' });
    } catch (error) {
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

module.exports = {
  httpRequest,
  httpGet,
  httpPost,
  httpHead,
  createDispatcher,
};
