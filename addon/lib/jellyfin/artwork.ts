// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';

export interface Artwork {
  body: Buffer;
  contentType: string;
  etag?: string;
}

const heldBytes = envInt('JELLYFIN_IMAGE_CACHE_MB', 64, 1) * 1024 * 1024;
const held = new LRUCache<string, Artwork>({
  maxSize: heldBytes,
  maxEntrySize: Math.max(1, Math.floor(heldBytes / 16)),
  sizeCalculation: (value) => value.body.length,
  ttl: envInt('JELLYFIN_IMAGE_CACHE_TTL', 6 * 60 * 60, 60) * 1000,
});

const loading = new Map<string, Promise<Artwork>>();

export function heldArtwork(key: string): Artwork | undefined {
  return held.get(key);
}

/**
 * The bytes for one image at one size, fetched once. A shelf shows the same
 * poster on many items and many clients open it at once, so the load is shared
 * rather than run per request.
 */
export async function cachedArtwork(key: string, load: () => Promise<Artwork>): Promise<Artwork> {
  const known = held.get(key);
  if (known) return known;

  const running = loading.get(key);
  if (running) return running;

  // load() runs a tick later, so the entry is in place before it can settle and
  // a load that throws outright is not left behind as the answer.
  const work = Promise.resolve()
    .then(load)
    .then((image) => {
      held.set(key, image);
      return image;
    })
    .finally(() => loading.delete(key));

  loading.set(key, work);
  return work;
}
