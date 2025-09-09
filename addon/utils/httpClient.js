const { request } = require("undici");

/**
 * HTTP client wrapper using undici for better performance
 * Maintains similar API to axios for easy migration
 * @param {string} url - The URL to request
 * @param {Object} options - Request options
 * @param {string} options.method - HTTP method (GET, POST, etc.)
 * @param {Object} options.data - Request body data (for POST/PUT)
 * @param {Object} options.headers - Additional headers
 * @param {number} options.timeout - Request timeout in milliseconds
 * @param {Object} options.httpsAgent - Custom HTTPS agent (for compatibility, ignored in undici)
 * @returns {Promise<Object>} Response object with data, status, headers
 */
async function httpRequest(url, options = {}) {
  const {
    method = 'GET',
    data,
    headers = {},
    timeout = 30000,
    httpsAgent // Ignored in undici, kept for compatibility
  } = options;

  const requestOptions = {
    method,
    headers: {
      'User-Agent': 'AIO-Metadata/1.0',
      ...headers
    },
    bodyTimeout: timeout,
    headersTimeout: timeout,
    connectTimeout: 10000, // 10 second connection timeout
    // Add TLS configuration for better connectivity
    tls: {
      rejectUnauthorized: false, // Allow self-signed certificates
      secureProtocol: 'TLSv1_2_method' // Use TLS 1.2
    }
  };

  if (data) {
    requestOptions.body = JSON.stringify(data);
    requestOptions.headers['Content-Type'] = 'application/json';
  }

  try {
    const { statusCode, headers, body } = await request(url, requestOptions);
    
    if (statusCode >= 200 && statusCode < 300) {
      const responseData = await body.json();
      return {
        data: responseData,
        status: statusCode,
        headers
      };
    } else {
      const errorText = await body.text();
      const error = new Error(`HTTP ${statusCode}: ${errorText}`);
      error.response = {
        status: statusCode,
        data: errorText,
        headers
      };
      throw error;
    }
  } catch (error) {
    if (error.code === 'UND_ERR_HEADERS_TIMEOUT' || error.code === 'UND_ERR_BODY_TIMEOUT') {
      const timeoutError = new Error('Request timeout');
      timeoutError.code = 'ECONNABORTED';
      throw timeoutError;
    }
    throw error;
  }
}

/**
 * Convenience method for GET requests
 * @param {string} url - The URL to request
 * @param {Object} options - Request options
 * @returns {Promise<Object>} Response object
 */
async function httpGet(url, options = {}) {
  return httpRequest(url, { ...options, method: 'GET' });
}

/**
 * Convenience method for POST requests
 * @param {string} url - The URL to request
 * @param {Object} data - Request body data
 * @param {Object} options - Request options
 * @returns {Promise<Object>} Response object
 */
async function httpPost(url, data, options = {}) {
  return httpRequest(url, { ...options, method: 'POST', data });
}

module.exports = {
  httpRequest,
  httpGet,
  httpPost
};
