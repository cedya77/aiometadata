// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import { isExplicitlyDisabled } from './config.js';

const logger = consola.withTag('Poster-Cache');

const POSTER_RATIO = 2 / 3;
/** Ratios this close to 2:3 pass untouched; a client's box hides the difference. */
const KEEP_BELOW = 0.74;
const KEEP_ABOVE = 0.6;
/** Wider than this and a crop keeps a sliver, so the image is set on a blurred fill instead. */
const FILL_ABOVE = 0.85;
const MAX_PIXELS = 10000 * 10000;

export function shapesPosters(): boolean {
  return !isExplicitlyDisabled(require('../settingsService').getSetting('POSTER_CACHE_SHAPE_POSTERS'));
}

// MyAnimeList and Kitsu publish some posters in landscape; every other source
// publishes 2:3 already, and reading theirs to find that out costs a fetch and
// a decode for nothing.
// The official MAL API answers with api-cdn, Jikan with cdn, for the same image.
const OFF_RATIO_HOSTS = ['cdn.myanimelist.net', 'api-cdn.myanimelist.net', 'media.kitsu.app', 'media.kitsu.io'];

export function shapesPosterFrom(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return OFF_RATIO_HOSTS.some((source) => host === source || host.endsWith(`.${source}`));
}

export interface ShapedImage {
  body: Buffer;
  contentType: string;
}

/**
 * A poster that is not 2:3 is brought to it: near misses are cropped, a wide
 * key visual is fitted onto a blurred copy of itself. Clients draw the image at
 * its own shape inside a 2:3 cell, so a wrong one spills over its neighbours.
 */
export async function shapePoster(body: Buffer, contentType: string): Promise<ShapedImage> {
  const keep = { body, contentType };
  if (!shapesPosters() || !/^image\/(jpeg|png|webp|avif)/i.test(contentType || '')) return keep;

  try {
    const sharp = require('sharp');
    const source = sharp(body, { limitInputPixels: MAX_PIXELS });
    const meta = await source.metadata();
    const width = Number(meta.width) || 0;
    const height = Number(meta.height) || 0;
    if (!width || !height) return keep;

    const ratio = width / height;
    if (ratio >= KEEP_ABOVE && ratio <= KEEP_BELOW) return keep;

    if (ratio < FILL_ABOVE) {
      const target = ratio > POSTER_RATIO
        ? { width: Math.round(height * POSTER_RATIO), height }
        : { width, height: Math.round(width / POSTER_RATIO) };
      const out = await source.resize(target.width, target.height, { fit: 'cover', position: 'centre' }).jpeg({ quality: 88 }).toBuffer();
      return { body: out, contentType: 'image/jpeg' };
    }

    const canvas = { width, height: Math.round(width / POSTER_RATIO) };
    const backdrop = await sharp(body, { limitInputPixels: MAX_PIXELS })
      .resize(canvas.width, canvas.height, { fit: 'cover', position: 'centre' })
      .blur(24)
      .modulate({ brightness: 0.7 })
      .toBuffer();
    const out = await sharp(backdrop)
      .composite([{ input: body, gravity: 'centre' }])
      .jpeg({ quality: 88 })
      .toBuffer();
    return { body: out, contentType: 'image/jpeg' };
  } catch (error: any) {
    logger.debug(`Poster left as is: ${error?.message || error}`);
    return keep;
  }
}
