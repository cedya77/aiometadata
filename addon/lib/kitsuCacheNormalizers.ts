// Only keep the attribute keys that downstream consumers actually read.
const ANIME_ATTRIBUTE_KEYS = [
  'canonicalTitle',
  'titles',
  'synopsis',
  'description',
  'slug',
  'subtype',
  'status',
  'startDate',
  'endDate',
  'episodeCount',
  'episodeLength',
  'ageRating',
  'youtubeVideoId',
  'nsfw',
];


const EPISODE_ATTRIBUTE_KEYS = [
  'canonicalTitle',
  'title',
  'number',
  'seasonNumber',
  'synopsis',
  'airdate',
  'length',
];

function pickDefined(source: any, keys: string[]) {
  if (!source || typeof source !== 'object') return source;

  const result: any = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

//flatten to .original since we only consume it
function flattenImageToOriginal(image: any): { original: string } | null {
  if (!image || typeof image !== 'object') return image;
  if (!image.original) return null;
  return { original: image.original };
}


export function normalizeKitsuAnimeForCache(item: any): any {
  if (!item || typeof item !== 'object') return item;

  const result: any = { id: item.id };

  // Pick only the used attribute keys
  if (item.attributes) {
    const attrs = pickDefined(item.attributes, ANIME_ATTRIBUTE_KEYS);

    // Flatten images to just .original
    if (item.attributes.posterImage) {
      attrs.posterImage = flattenImageToOriginal(item.attributes.posterImage);
    }
    if (item.attributes.coverImage) {
      attrs.coverImage = flattenImageToOriginal(item.attributes.coverImage);
    }

    result.attributes = attrs;
  }

  // Keep only relationships.categories.data (used by getKitsuGenresForItem)
  if (item.relationships?.categories?.data) {
    result.relationships = {
      categories: {
        data: item.relationships.categories.data,
      },
    };
  }

  return result;
}

export function normalizeKitsuCategoryForCache(category: any): any {
  if (!category || typeof category !== 'object') return category;

  return {
    id: category.id,
    type: category.type,
    attributes: {
      title: category.attributes?.title,
    },
  };
}


export function normalizeKitsuEpisodeForCache(episode: any): any {
  if (!episode || typeof episode !== 'object') return episode;

  const result: any = {
    id: episode.id,
    type: episode.type,
  };

  if (episode.attributes) {
    const attrs = pickDefined(episode.attributes, EPISODE_ATTRIBUTE_KEYS);

    // Flatten thumbnail to just .original
    if (episode.attributes.thumbnail) {
      attrs.thumbnail = flattenImageToOriginal(episode.attributes.thumbnail);
    }

    result.attributes = attrs;
  }

  return result;
}

function normalizeKitsuMediaRelationshipForCache(item: any): any {
  if (!item || typeof item !== 'object') return item;

  const result: any = {
    id: item.id,
    type: item.type,
  };

  if (item.attributes) {
    result.attributes = pickDefined(item.attributes, ['role']);
  }

  if (item.relationships?.destination?.data) {
    result.relationships = {
      destination: { data: item.relationships.destination.data },
    };
  }

  return result;
}

function normalizeKitsuIncludedItem(item: any): any {
  if (!item || typeof item !== 'object') return item;

  switch (item.type) {
    case 'categories':
      return normalizeKitsuCategoryForCache(item);
    case 'episodes':
      return normalizeKitsuEpisodeForCache(item);
    case 'mediaRelationships':
      return normalizeKitsuMediaRelationshipForCache(item);
    default:
      // For anime destinations or other included types, keep id/type/attributes
      // but strip heavy fields
      if (item.type === 'anime') {
        return normalizeKitsuAnimeForCache(item);
      }
      return item;
  }
}


export function normalizeKitsuBatchResponseForCache(response: any): any {
  if (!response || typeof response !== 'object') return response;

  const result: any = {};

  if (Array.isArray(response.data)) {
    result.data = response.data.map(normalizeKitsuAnimeForCache);
  } else if (response.data && typeof response.data === 'object') {
    // Single resource (getAnimeDetails returns data as a single object)
    result.data = normalizeKitsuAnimeForCache(response.data);
  }

  if (Array.isArray(response.included)) {
    result.included = response.included.map(normalizeKitsuIncludedItem);
  }

  if (response.meta !== undefined) {
    result.meta = response.meta;
  }

  return result;
}

export function normalizeKitsuDetailResponseForCache(response: any): any {
  if (!response || typeof response !== 'object') return response;

  const result: any = {};

  if (response.data) {
    result.data = normalizeKitsuAnimeForCache(response.data);
  }

  if (Array.isArray(response.included)) {
    result.included = response.included.map(normalizeKitsuIncludedItem);
  }

  // genres and characters are already string arrays
  if (response.genres !== undefined) result.genres = response.genres;
  if (response.characters !== undefined) result.characters = response.characters;

  return result;
}

export const kitsuCacheNormalizers = {
  normalizeKitsuAnimeForCache,
  normalizeKitsuCategoryForCache,
  normalizeKitsuEpisodeForCache,
  normalizeKitsuBatchResponseForCache,
  normalizeKitsuDetailResponseForCache,
};
