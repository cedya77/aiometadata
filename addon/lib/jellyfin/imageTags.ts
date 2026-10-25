import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';

// A tag names the picture, so a changed picture is fetched again. The address
// itself is looked up when the image is asked for.

const WIDE = 'w';

const tags = new LRUCache<string, string>({ max: envInt('JELLYFIN_IMAGE_CACHE_MAX', 20000, 1) * 2 });

export function imageTag(url: string): string {
  const held = tags.get(url);
  if (held) return held;
  const tag = createHash('sha1').update(url).digest('hex').slice(0, 20);
  tags.set(url, tag);
  return tag;
}

/** Landscape art standing in for a poster, named after the tag of that art. */
export function wideTag(artTag: string): string {
  return `${WIDE}${artTag}`;
}

export function artTag(tag: string): string {
  return tag.startsWith(WIDE) ? tag.slice(WIDE.length) : tag;
}

export function isWideTag(tag: unknown): boolean {
  return typeof tag === 'string' && tag.startsWith(WIDE);
}
