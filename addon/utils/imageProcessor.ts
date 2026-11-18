// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
const sharp: any = require('sharp');
const axios: any = require('axios');
const { Transform }: any = require('stream');
const { pipeline }: any = require('stream/promises');

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

const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];

const MAX_FILE_SIZE = 15 * 1024 * 1024;
const MAX_INPUT_PIXELS = 10000 * 10000;
const REQUEST_TIMEOUT_MS = 10000;

interface BannerOptions {
  width?: number;
  height?: number;
  blur?: number;
  brightness?: number;
  contrast?: number;
  position?: string;
}

interface StreamResult {
  bytesWritten: number;
  info: any | null;
}

function validateImageUrl(imageUrl: string): boolean {
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
    const isExtensionless =
      domain === 'images.metahub.space' && pathname.endsWith('/img');

    if (!hasValidExtension && !isExtensionless) {
      console.warn(`[Security] Blocked request with unauthorized file extension: ${pathname}`);
      return false;
    }

    return true;
  } catch (error: any) {
    console.warn(`[Security] Invalid URL format: ${imageUrl}`);
    return false;
  }
}

async function blurImage(imageUrl: string, outputStream: any): Promise<StreamResult> {
  return streamProcessedImage(imageUrl, outputStream, (transformer: any) => transformer.blur(80));
}

const BANNER_POSITIONS = new Set([
  'center', 'centre', 'top', 'right top', 'right', 'right bottom', 'bottom', 'left bottom', 'left', 'left top',
  'north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'entropy', 'attention',
]);

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** No background needs more pixels than 4K. */
const MAX_BANNER_PIXELS = 3840 * 2160;

/** Banner options held to what a background needs, so no request can ask for an output or a blur that holds a core. */
function normaliseBannerOptions(raw: Record<string, unknown> = {}): Required<BannerOptions> {
  const blur = bounded(raw.blur, 0, 0, 50);
  const position = String(raw.position ?? 'center').toLowerCase();
  let width = bounded(raw.width || undefined, 1920, 1, 3840);
  let height = bounded(raw.height || undefined, 1080, 1, 3840);
  const shrink = Math.min(1, Math.sqrt(MAX_BANNER_PIXELS / (width * height)));
  width = Math.max(1, Math.round(width * shrink));
  height = Math.max(1, Math.round(height * shrink));
  return {
    width,
    height,
    // sharp takes a blur of 0.3 or more; anything below it but above none is the lightest it does.
    blur: blur > 0 ? Math.max(0.3, blur) : 0,
    brightness: bounded(raw.brightness || undefined, 1, 0.1, 10),
    contrast: bounded(raw.contrast || undefined, 1, 0, 10),
    position: BANNER_POSITIONS.has(position) ? position : 'center',
  };
}

async function convertBannerToBackground(bannerUrl: string, options: BannerOptions = {}, outputStream: any): Promise<StreamResult> {
  const { width, height, blur, brightness, contrast, position } = normaliseBannerOptions(options as Record<string, unknown>);

  return streamProcessedImage(bannerUrl, outputStream, (transformer: any) => {
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

function ensureOutputStream(outputStream: any): void {
  if (!outputStream || typeof outputStream.write !== 'function') {
    throw new Error('Output stream is required for image processing');
  }
}

function createInputSizeLimiter(maxBytes: number): any {
  let totalBytes = 0;

  return new Transform({
    transform(chunk: any, _encoding: string, callback: any) {
      totalBytes += chunk.length;

      if (totalBytes > maxBytes) {
        callback(new Error('File too large'));
        return;
      }

      callback(null, chunk);
    }
  });
}

function createOutputCounter(): { bytes: () => number; stream: any } {
  let bytesWritten = 0;

  return {
    bytes() {
      return bytesWritten;
    },
    stream: new Transform({
      transform(chunk: any, _encoding: string, callback: any) {
        bytesWritten += chunk.length;
        callback(null, chunk);
      }
    })
  };
}

async function fetchImageStream(imageUrl: string): Promise<any> {
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

function createSharpStream(): any {
  return sharp({
    sequentialRead: true,
    limitInputPixels: MAX_INPUT_PIXELS
  });
}

async function streamProcessedImage(imageUrl: string, outputStream: any, configureTransformer: (transformer: any) => any): Promise<StreamResult> {
  ensureOutputStream(outputStream);

  const response = await fetchImageStream(imageUrl);
  const inputLimiter = createInputSizeLimiter(MAX_FILE_SIZE);
  const outputCounter = createOutputCounter();
  const transformer = configureTransformer(createSharpStream()).jpeg();
  let outputInfo: any = null;

  transformer.once('info', (info: any) => {
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
  } catch (error: any) {
    response.data.destroy(error);
    throw error;
  }
}

export { blurImage, convertBannerToBackground, normaliseBannerOptions, validateImageUrl };
module.exports = { blurImage, convertBannerToBackground, normaliseBannerOptions, validateImageUrl };
