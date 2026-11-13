// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import { collectionImageUrls } from './collectionBuilder/imageProxy';

const logger = consola.withTag('CollectionImages');

/**
 * Called after a configuration is saved: with the option on, its layout's
 * images are queued into the cache and pinned there; with it off, released.
 */
export async function syncCollectionImages(userUUID: string, config: any): Promise<void> {
  const posterCacheConfig = require('./posterCache/config');
  if (!posterCacheConfig.isBuiltinPosterCacheEnabled()) return;

  const store = require('./posterCache/store');
  if (!store.isInitialized?.()) return;

  const urls: string[] = config?.collectionImagesViaCache ? collectionImageUrls(config.collections) : [];
  try {
    await store.setPins(userUUID, urls.map((url) => ({ imageClass: 'collection', key: url })));
    if (urls.length) {
      const warmQueue = require('./posterCache/warmQueue');
      warmQueue.offer(urls.map((url) => ({ imageClass: 'collection', url })));
      logger.debug(`Queued ${urls.length} collection image(s) for ${userUUID.slice(0, 8)}`);
    }
  } catch (error: any) {
    logger.warn(`Collection image sync failed for ${userUUID.slice(0, 8)}: ${error?.message || error}`);
  }
}
