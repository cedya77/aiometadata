const { request, setGlobalDispatcher, ProxyAgent } = require("undici");

// Global proxy configuration - applies to all undici requests
const getProxyUrl = () => {
  const proxy = process.env.HTTP_PROXY ?? process.env.HTTPS_PROXY;
  if (proxy) {
    return new URL(proxy).toString();
  }
  return null;
};

const proxyUrl = getProxyUrl();
if (proxyUrl) {
  const dispatcher = new ProxyAgent({ uri: proxyUrl });
  setGlobalDispatcher(dispatcher);
}

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
    // AGGRESSIVE TIMEOUT: If an API can't respond in 8 seconds, we give up.
    // This is a tunable value, but 8000ms is a good starting point for "fast".
    timeout = 8000, 
    dispatcher  
  } = options;
  

  const requestOptions = {
    method,
    headers: {
      'User-Agent': 'AIO-Metadata/1.0',
      ...headers
    },
    bodyTimeout: timeout,
    headersTimeout: timeout,
    connectTimeout: timeout, // A single, consistent timeout for all phases.
    dispatcher: dispatcher || undefined,
  };

  if (data) {
    requestOptions.body = JSON.stringify(data);
    if (!requestOptions.headers['Content-Type']) {
      requestOptions.headers['Content-Type'] = 'application/json';
    }
  }

  try {
    const { statusCode, headers, body } = await request(url, requestOptions);
    
    if (statusCode >= 200 && statusCode < 300) {
      const text = await body.text();
      const responseData = text ? JSON.parse(text) : null;
      return {
        data: responseData,
        status: statusCode,
        headers
      };
    } else if (statusCode === 304) {
      // 304 Not Modified - throw with special status for cache handling
      const error = new Error(`Not Modified`);
      error.response = {
        status: 304,
        headers
      };
      throw error;
    } else {
      // It's still a successful HTTP transaction, just not a 2xx one. Fail fast.
      const errorText = await body.text();
      const error = new Error(`Request failed with status code ${statusCode}`);
      error.response = {
        status: statusCode,
        data: errorText,
        headers
      };
      throw error;
    }
  } catch (error) {
    // Any error (timeout, connection refused, etc.) is thrown immediately.
    // The calling function is now responsible for handling it.
    // We do not retry here.
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
  return httpRequest(url, { ...options, method: 'POST', data });
}

/**
 * Convenience method for HEAD requests
 */
async function httpHead(url, options = {}) {
  return httpRequest(url, { ...options, method: 'HEAD' });
}

module.exports = {
  httpRequest,
  httpGet,
  httpPost,
  httpHead
};