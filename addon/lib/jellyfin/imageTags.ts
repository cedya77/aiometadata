import { createHash } from 'crypto';

// A tag names the picture, so a changed picture is fetched again. The address
// itself is looked up when the image is asked for.

const WIDE = 'w';

export function imageTag(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 20);
}

/** Landscape art standing in for a poster, named after the tag of that art. */
export function wideTag(artTag: string): string {
  return `${WIDE}${artTag}`;
}

export function isWideTag(tag: unknown): boolean {
  return typeof tag === 'string' && tag.startsWith(WIDE);
}
