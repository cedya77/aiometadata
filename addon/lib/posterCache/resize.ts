import { getSetting } from '../settingsService';

/** Widths an image is made at, so each one has a handful of sizes however clients ask. */
const WIDTH_STEPS = [185, 342, 500, 780, 1280];
const DEFAULT_QUEUE = 256;
const DEFAULT_QUEUE_MB = 64;
const DEFAULT_WAIT_MS = 3000;

/** Set on an internal request to the poster cache to ask for a copy at that width step. */
export const SIZED_WIDTH = Symbol.for('aiometadata.posterCache.sizedWidth');

export interface ResizedImage {
  body: Buffer;
  contentType: string;
}

/** The cache key of an image's copy at one width step. */
export function sizedKey(key: string, width: number): string {
  return `${key}#w${width}`;
}

/** Every copy an image can have, so clearing the original clears them too. */
export function sizedKeys(key: string): string[] {
  return WIDTH_STEPS.map((width) => sizedKey(key, width));
}

/** The smallest step at least as wide as asked, or null when the client wants it larger. */
export function widthStep(requested: number): number | null {
  if (!(requested > 0)) return null;
  return WIDTH_STEPS.find((width) => width >= requested) ?? null;
}

let running = 0;
let waitingBytes = 0;

interface Waiter {
  start: () => void;
  timer?: NodeJS.Timeout;
}

const waiting: Waiter[] = [];

export class ImageQueueFull extends Error {
  constructor() {
    super('Image queue is full');
  }
}

function settingInt(key: string, fallback: number, min: number): number {
  const value = Number(getSetting(key));
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

function concurrency(): number {
  return settingInt('JELLYFIN_IMAGE_RESIZE_CONCURRENCY', 2, 1);
}

function queueLimit(): number {
  return settingInt('JELLYFIN_IMAGE_RESIZE_QUEUE', DEFAULT_QUEUE, 0);
}

function queueBytes(): number {
  return settingInt('JELLYFIN_IMAGE_RESIZE_QUEUE_MB', DEFAULT_QUEUE_MB, 1) * 1024 * 1024;
}

function waitMs(): number {
  return settingInt('JELLYFIN_IMAGE_RESIZE_WAIT_MS', DEFAULT_WAIT_MS, 0);
}

export function imageQueueFull(bytes = 0): boolean {
  if (running < concurrency() && !waiting.length) return false;
  return waiting.length >= queueLimit() || waitingBytes + bytes > queueBytes();
}

export async function inImageSlot<T>(work: () => Promise<T>, bytes = 0): Promise<T> {
  if (running < concurrency() && !waiting.length) {
    running++;
  } else {
    if (imageQueueFull(bytes)) throw new ImageQueueFull();
    waitingBytes += bytes;
    try {
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          start: () => {
            clearTimeout(waiter.timer);
            resolve();
          },
        };
        waiter.timer = setTimeout(() => {
          const at = waiting.indexOf(waiter);
          if (at >= 0) waiting.splice(at, 1);
          reject(new ImageQueueFull());
        }, waitMs());
        waiting.push(waiter);
      });
    } finally {
      waitingBytes -= bytes;
    }
  }
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next.start();
    else running--;
  }
}

/**
 * The image at most `width` wide. Art with transparency stays transparent as WebP;
 * the rest becomes JPEG. An image already that narrow, or one the smaller copy
 * would not beat, comes back as it was.
 */
export async function shrinkToWidth(body: Buffer, contentType: string, width: number): Promise<ResizedImage> {
  try {
    const sharp = require('sharp');
    const source = sharp(body, { failOn: 'none' });
    const meta = await source.metadata();
    if (!meta.width || meta.width <= width) return { body, contentType };
    const resized = source.resize({ width });
    const out: ResizedImage = meta.hasAlpha
      ? { body: await resized.webp({ quality: 85 }).toBuffer(), contentType: 'image/webp' }
      : { body: await resized.jpeg({ quality: 85, mozjpeg: true }).toBuffer(), contentType: 'image/jpeg' };
    return out.body.length < body.length ? out : { body, contentType };
  } catch {
    return { body, contentType };
  }
}

export function resizeToWidth(body: Buffer, contentType: string, width: number): Promise<ResizedImage> {
  return inImageSlot(() => shrinkToWidth(body, contentType, width), body.length);
}
