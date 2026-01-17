const { request, setGlobalDispatcher, ProxyAgent } = require("undici");

// Global proxy configuration - applies to all undici requests
// Prefers HTTPS_PROXY since most API calls are HTTPS, falls back to HTTP_PROXY
const getProxyUrl = () => {
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
    connectTimeout: timeout,
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

    const contentType =
      headers['content-type'] ||
      headers['Content-Type'] ||
      '';

    if (statusCode >= 200 && statusCode < 300) {
      // HEAD usually has no body; don't try to parse
      if (method === 'HEAD') {
        return {
          data: null,
          status: statusCode,
          headers
        };
      }

      const text = await body.text();

      let responseData = null;

      // Only parse as JSON if the server says it is JSON
      if (contentType.includes('application/json')) {
        responseData = text ? JSON.parse(text) : null;
      } else {
        // For HTML / plain text / whatever else, just return raw text
        responseData = text;
      }

      return {
        data: responseData,
        status: statusCode,
        headers
      };
    } else if (statusCode === 304) {
      const error = new Error(`Not Modified`);
      error.response = {
        status: 304,
        headers
      };
      throw error;
    } else {
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
  return httpRequest(url, { ...options, method: 'HEAD' });
}

module.exports = {
  httpRequest,
  httpGet,
  httpPost,
  httpHead
};