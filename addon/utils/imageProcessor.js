const sharp = require('sharp');
const axios = require('axios');
const url = require('url');

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
  'top-streaming.stream'
];

// Allowed file extensions
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];

// Maximum file size (50MB)
const MAX_FILE_SIZE = 50 * 1024 * 1024;

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

async function blurImage(imageUrl) {
  if (!validateImageUrl(imageUrl)) {
    throw new Error('Invalid or unauthorized image URL');
  }
  
  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 10000, // 10 second timeout
      maxContentLength: MAX_FILE_SIZE,
      maxBodyLength: MAX_FILE_SIZE
    });

    const contentType = response.headers['content-type'];
    if (!contentType || !contentType.startsWith('image/')) {
      throw new Error('Invalid content type');
    }

    if (response.data.length > MAX_FILE_SIZE) {
      throw new Error('File too large');
    }

    const processedImageBuffer = await sharp(response.data)
      .blur(80)
      .toBuffer();

    return processedImageBuffer;
  } catch (error) {
    console.error('[ImageProcessor] Error processing image:', error.message);
    throw error;
  }
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
 * @returns {Promise<Buffer|null>} Processed image buffer
 */
async function convertBannerToBackground(bannerUrl, options = {}) {
  // Validate URL before processing
  if (!validateImageUrl(bannerUrl)) {
    throw new Error('Invalid or unauthorized image URL');
  }
  
  try {
      const {
    width = 1920,
    height = 1080,
    blur = 0,
    brightness = 1,
    contrast = 1,
    position = 'center'
  } = options;

    const response = await axios.get(bannerUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      maxContentLength: MAX_FILE_SIZE,
      maxBodyLength: MAX_FILE_SIZE
    });

    const contentType = response.headers['content-type'];
    if (!contentType || !contentType.startsWith('image/')) {
      throw new Error('Invalid content type');
    }

    if (response.data.length > MAX_FILE_SIZE) {
      throw new Error('File too large');
    }

    let sharpInstance = sharp(response.data);

    // Resize to target dimensions with cover mode (maintains aspect ratio)
    // For banner images, use 'top' position to avoid cutting off important content
    sharpInstance = sharpInstance.resize(width, height, {
      fit: 'cover',
      position: position
    });

    // Apply blur if specified
    if (blur > 0) {
      sharpInstance = sharpInstance.blur(blur);
    }

    // Apply brightness and contrast adjustments
    if (brightness !== 1 || contrast !== 1) {
      sharpInstance = sharpInstance.modulate({
        brightness,
        contrast
      });
    }

    const processedImageBuffer = await sharpInstance.toBuffer();
    return processedImageBuffer;

  } catch (error) {
    console.error('[ImageProcessor] Error converting banner to background:', error);
    return null;
  }
}

/**
 * Create a gradient overlay on top of an image
 * @param {string} imageUrl - Base image URL
 * @param {Object} options - Gradient options
 * @param {string} options.gradient - Gradient type ('dark', 'light', 'custom')
 * @param {number} options.opacity - Gradient opacity (0-1)
 * @returns {Promise<Buffer|null>} Processed image buffer
 */
async function addGradientOverlay(imageUrl, options = {}) {
  // Validate URL before processing
  if (!validateImageUrl(imageUrl)) {
    throw new Error('Invalid or unauthorized image URL');
  }
  
  try {
    const { gradient = 'dark', opacity = 0.7 } = options;

    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      maxContentLength: MAX_FILE_SIZE,
      maxBodyLength: MAX_FILE_SIZE
    });

    const contentType = response.headers['content-type'];
    if (!contentType || !contentType.startsWith('image/')) {
      throw new Error('Invalid content type');
    }

    if (response.data.length > MAX_FILE_SIZE) {
      throw new Error('File too large');
    }

    let gradientOverlay;
    switch (gradient) {
      case 'dark':
        gradientOverlay = {
          width: 1920,
          height: 1080,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: opacity }
        };
        break;
      case 'light':
        gradientOverlay = {
          width: 1920,
          height: 1080,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: opacity }
        };
        break;
      default:
        gradientOverlay = {
          width: 1920,
          height: 1080,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: opacity }
        };
    }

    const overlay = sharp({
      create: gradientOverlay
    });

    const processedImageBuffer = await sharp(response.data)
      .resize(1920, 1080, { fit: 'cover', position: 'center' })
      .composite([{ input: await overlay.toBuffer(), blend: 'multiply' }])
      .toBuffer();

    return processedImageBuffer;

  } catch (error) {
    console.error('[ImageProcessor] Error adding gradient overlay:', error);
    return null;
  }
}

module.exports = { blurImage, convertBannerToBackground, addGradientOverlay, validateImageUrl }; 