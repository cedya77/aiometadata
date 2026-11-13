// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
const tvdbApi: any = require('../lib/tvdb');

/** The shape the configure UI renders a TVDB list picker from. */
export interface TvdbListRecord {
  id: number;
  name: string;
  overview: string;
  slug: string;
  image: string;
  isOfficial: boolean;
  url: string;
}

const TVDB_ARTWORK_BASE = 'https://artworks.thetvdb.com';

export function tvdbListImageUrl(image: unknown): string {
  if (!image || typeof image !== 'string') return '';
  return image.startsWith('http') ? image : `${TVDB_ARTWORK_BASE}${image.startsWith('/') ? '' : '/'}${image}`;
}

export function normalizeTvdbListRecord(record: any): TvdbListRecord | null {
  const id = Number(String(record?.tvdb_id ?? record?.id ?? '').replace(/[^0-9]/g, ''));
  if (!Number.isFinite(id) || id <= 0) return null;
  const slug = record?.url || record?.slug || '';
  return {
    id,
    name: record?.name || `List ${id}`,
    overview: record?.overview || record?.overviews?.eng || '',
    slug,
    image: tvdbListImageUrl(record?.image || record?.image_url),
    isOfficial: !!record?.isOfficial,
    url: `https://thetvdb.com/lists/${slug || id}`
  };
}

// Base list records carry no image, and search results carry no slug.
export async function enrichTvdbListRecords(records: any[], config: any): Promise<any[]> {
  const enriched = new Array(records.length);
  const queue = records.map((record, index) => ({ record, index }));
  const concurrency = Math.min(
    parseInt(process.env.TVDB_LIST_ENRICH_CONCURRENCY || '10', 10),
    queue.length
  );

  const worker = async () => {
    while (queue.length) {
      const { record, index } = queue.shift();
      let details = null;
      try {
        details = await tvdbApi.getCollectionDetails(String(record.id), config);
      } catch (error) {
        consola.debug(`[TVDB Lists] Could not enrich list ${record.id}: ${error.message}`);
      }
      const entities = Array.isArray(details?.entities) ? details.entities : [];
      const movieCount = entities.filter(e => e?.movieId).length;
      const seriesCount = entities.filter(e => e?.seriesId).length;
      enriched[index] = {
        ...record,
        ...(details?.image ? { image: tvdbListImageUrl(details.image) } : {}),
        ...(details?.url ? { slug: details.url, url: `https://thetvdb.com/lists/${details.url}` } : {}),
        ...(details?.overview && !record.overview ? { overview: details.overview } : {}),
        // Search results omit isOfficial entirely, so it only ever arrives here.
        isOfficial: typeof details?.isOfficial === 'boolean' ? details.isOfficial : !!record.isOfficial,
        movieCount,
        seriesCount,
        itemCount: movieCount + seriesCount,
      };
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return enriched.filter(Boolean);
}
