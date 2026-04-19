const sharp = require('sharp');
const axios = require('axios');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

// Whitelisted domains for image processing
const ALLOWED_DOMAINS = [
  'image.tmdb.org',
  'artworks.thetvdb.com',
  'images.metahub.space',
  'cdn.myanimelist.net',
  'media.kitsu.io',
  'media.kitsu.app',
  'gogocdn.net',
  'artworks.thetvdb.com',
  'fanart.tv',
  'themoviedb.org',
  'thetvdb.com',
  'myanimelist.net',
  'kitsu.io',
  'anilist.co',
  'anidb.net',
  'top-posters.com'
];

// Allowed file extensions
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];

// Maximum file size (15MB)
const MAX_FILE_SIZE = 15 * 1024 * 1024;
const MAX_INPUT_PIXELS = 10000 * 10000;
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Validate image URL for security
 * @param {string} imageUrl - URL to validate
 * @returns {boolean} - Whether URL is safe to process
 */
function validateImageUrl(imageUrl) {
  try {
    const parsedUrl = new URL(imageUrl);
    
    const domain = parsedUrl.hostname.toLowerCase();
    const isAllowedDomain = ALLOWED_DOMAINS.some(allowed => 
      domain === allowed || domain.endsWith('.' + allowed)
    );
    
    if (!isAllowedDomain) {
      console.warn(`[Security] Blocked request to unauthorized domain: ${domain}`);
      return false;
    }
    
    if (parsedUrl.protocol !== 'https:' && !(parsedUrl.protocol === 'http:' && domain === 'localhost')) {
      console.warn(`[Security] Blocked request with unauthorized protocol: ${parsedUrl.protocol}`);
      return false;
    }
    
    const pathname = parsedUrl.pathname.toLowerCase();
    const hasValidExtension = ALLOWED_EXTENSIONS.some(ext => pathname.endsWith(ext));
    // MetaHub serves images via extensionless endpoints like `/img`.
    const isExtensionless =
      domain === 'images.metahub.space' && pathname.endsWith('/img');
    
    if (!hasValidExtension && !isExtensionless) {
      console.warn(`[Security] Blocked request with unauthorized file extension: ${pathname}`);
      return false;
    }
    
    return true;
  } catch (error) {
    console.warn(`[Security] Invalid URL format: ${imageUrl}`);
    return false;
  }
}

async function blurImage(imageUrl, outputStream) {
  return streamProcessedImage(imageUrl, outputStream, (transformer) => transformer.blur(80));
}

/**
 * Convert banner image to full-size background image
 * @param {string} bannerUrl - Original banner image URL
 * @param {Object} options - Processing options
 * @param {number} options.width - Target width (default: 1920)
 * @param {number} options.height - Target height (default: 1080)
 * @param {number} options.blur - Blur amount (default: 0)
 * @param {number} options.brightness - Brightness adjustment (default: 1)
 * @param {number} options.contrast - Contrast adjustment (default: 1)
 * @param {import('stream').Writable} outputStream - Destination stream
 * @returns {Promise<{bytesWritten:number, info:Object|null}>} Stream result
 */
async function convertBannerToBackground(bannerUrl, options = {}, outputStream) {
  const {
    width = 1920,
    height = 1080,
    blur = 0,
    brightness = 1,
    contrast = 1,
    position = 'center'
  } = options;

  return streamProcessedImage(bannerUrl, outputStream, (transformer) => {
    let sharpInstance = transformer.resize(width, height, {
      fit: 'cover',
      position
    });

    if (blur > 0) {
      sharpInstance = sharpInstance.blur(blur);
    }

    if (brightness !== 1 || contrast !== 1) {
      sharpInstance = sharpInstance.modulate({
        brightness,
        contrast
      });
    }

    return sharpInstance;
  });
}

function ensureOutputStream(outputStream) {
  if (!outputStream || typeof outputStream.write !== 'function') {
    throw new Error('Output stream is required for image processing');
  }
}

function createInputSizeLimiter(maxBytes) {
  let totalBytes = 0;

  return new Transform({
    transform(chunk, _encoding, callback) {
      totalBytes += chunk.length;

      if (totalBytes > maxBytes) {
        callback(new Error('File too large'));
        return;
      }

      callback(null, chunk);
    }
  });
}

function createOutputCounter() {
  let bytesWritten = 0;

  return {
    bytes() {
      return bytesWritten;
    },
    stream: new Transform({
      transform(chunk, _encoding, callback) {
        bytesWritten += chunk.length;
        callback(null, chunk);
      }
    })
  };
}

async function fetchImageStream(imageUrl) {
  if (!validateImageUrl(imageUrl)) {
    throw new Error('Invalid or unauthorized image URL');
  }

  const response = await axios.get(imageUrl, {
    responseType: 'stream',
    timeout: REQUEST_TIMEOUT_MS,
    maxContentLength: MAX_FILE_SIZE,
    maxBodyLength: MAX_FILE_SIZE
  });

  const contentType = response.headers['content-type'];
  if (!contentType || !contentType.startsWith('image/')) {
    response.data.destroy();
    throw new Error('Invalid content type');
  }

  const contentLength = Number.parseInt(response.headers['content-length'] || '', 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_FILE_SIZE) {
    response.data.destroy();
    throw new Error('File too large');
  }

  return response;
}

function createSharpStream() {
  return sharp({
    sequentialRead: true,
    limitInputPixels: MAX_INPUT_PIXELS
  });
}

async function streamProcessedImage(imageUrl, outputStream, configureTransformer) {
  ensureOutputStream(outputStream);

  const response = await fetchImageStream(imageUrl);
  const inputLimiter = createInputSizeLimiter(MAX_FILE_SIZE);
  const outputCounter = createOutputCounter();
  const transformer = configureTransformer(createSharpStream()).jpeg();
  let outputInfo = null;

  transformer.once('info', (info) => {
    outputInfo = info;
  });

  try {
    await pipeline(
      response.data,
      inputLimiter,
      transformer,
      outputCounter.stream,
      outputStream
    );

    return {
      bytesWritten: outputCounter.bytes(),
      info: outputInfo
    };
  } catch (error) {
    response.data.destroy(error);
    throw error;
  }
}

module.exports = { blurImage, convertBannerToBackground, validateImageUrl };
