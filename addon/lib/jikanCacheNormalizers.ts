// Jikan (MAL) cache normalizers 
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

function mapIfArray(value: any, normalizer: (item: any) => any) {
  if (!Array.isArray(value)) return value;

  const result = new Array(value.length);
  for (let index = 0; index < value.length; index++) {
    result[index] = normalizer(value[index]);
  }
  return result;
}

// /anime/{id}/full
const DETAIL_KEYS = [
  'mal_id',
  'type',
  'score',
  'duration',
  'status',     
  'rating',   
  'year',
  'synopsis',
  'title',
  'title_english',
  'genres',
];

// We only need `images.jpg.large_image_url` but keep the `images` sub-tree
// so we can selectively re-build it below.

const GENRE_KEYS = ['name'];

const RELATION_ENTRY_KEYS = ['mal_id', 'name'];

const RELATION_KEYS = ['relation'];

const AIRED_KEYS = ['from', 'to'];

const TRAILER_KEYS = ['youtube_id'];

// /anime/{id}/characters
const CHARACTER_KEYS = ['name'];
const VOICE_ACTOR_PERSON_KEYS = ['name', 'mal_id'];
const VOICE_ACTOR_PERSON_IMAGE_JPG_KEYS = ['image_url'];

// /anime/{id}/episodes
const EPISODE_KEYS = ['mal_id', 'title', 'synopsis', 'airdate', 'aired', 'filler', 'recap'];

// Catalog items
const CATALOG_ITEM_KEYS = [
  'mal_id',
  'type',
  'title',
  'title_english',
  'synopsis',
  'year',
  'duration',
  'status',
  'genres',
];

// detail normalizer

function normalizeJikanImagesForCache(images: any) {
  if (!images || typeof images !== 'object') return images;

  const result: any = {};
  // Only jpg.large_image_url is consumed
  if (images.jpg && typeof images.jpg === 'object') {
    result.jpg = {};
    if (images.jpg.large_image_url !== undefined) {
      result.jpg.large_image_url = images.jpg.large_image_url;
    }
  }
  return result;
}

function normalizeJikanGenreForCache(genre: any) {
  return pickDefined(genre, GENRE_KEYS);
}

function normalizeJikanRelationEntryForCache(entry: any) {
  return pickDefined(entry, RELATION_ENTRY_KEYS);
}

function normalizeJikanRelationForCache(relation: any) {
  if (!relation || typeof relation !== 'object') return relation;

  const result = pickDefined(relation, RELATION_KEYS);
  if (Array.isArray(relation.entry)) {
    result.entry = mapIfArray(relation.entry, normalizeJikanRelationEntryForCache);
  }
  return result;
}

function normalizeJikanTrailerForCache(trailer: any) {
  if (!trailer || typeof trailer !== 'object') return trailer;
  return pickDefined(trailer, TRAILER_KEYS);
}

function normalizeJikanAiredForCache(aired: any) {
  if (!aired || typeof aired !== 'object') return aired;
  return pickDefined(aired, AIRED_KEYS);
}

export function normalizeJikanAnimeDetailsForCache(detail: any) {
  if (!detail || typeof detail !== 'object') return detail;

  const normalized: any = pickDefined(detail, DETAIL_KEYS);

  // images - only keep jpg.large_image_url
  if (detail.images !== undefined) {
    normalized.images = normalizeJikanImagesForCache(detail.images);
  }

  // trailer - only keep youtube_id
  if (detail.trailer !== undefined) {
    normalized.trailer = normalizeJikanTrailerForCache(detail.trailer);
  }

  // genres - only keep name
  if (Array.isArray(detail.genres)) {
    normalized.genres = mapIfArray(detail.genres, normalizeJikanGenreForCache);
  }

  // relations - keep relation, entry[].mal_id, entry[].name
  if (Array.isArray(detail.relations)) {
    normalized.relations = mapIfArray(detail.relations, normalizeJikanRelationForCache);
  }

  // streaming - keep as-is (small)
  if (Array.isArray(detail.streaming)) {
    normalized.streaming = detail.streaming;
  }

  // aired — keep from and to
  if (detail.aired !== undefined) {
    normalized.aired = normalizeJikanAiredForCache(detail.aired);
  }

  return normalized;
}

// characters normalizer 
function normalizeJikanVoiceActorPersonForCache(person: any) {
  if (!person || typeof person !== 'object') return person;

  const result = pickDefined(person, VOICE_ACTOR_PERSON_KEYS);
  // Only keep jpg.image_url from the person's images
  if (person.images?.jpg) {
    result.images = {
      jpg: pickDefined(person.images.jpg, VOICE_ACTOR_PERSON_IMAGE_JPG_KEYS),
    };
  }
  return result;
}

function normalizeJikanCharacterEntryForCache(charEntry: any) {
  if (!charEntry || typeof charEntry !== 'object') return charEntry;

  const result: any = {};

  // character - only keep name
  if (charEntry.character) {
    result.character = pickDefined(charEntry.character, CHARACTER_KEYS);
  }

  // voice_actors - filter to Japanese only, then prune each VA
  if (Array.isArray(charEntry.voice_actors)) {
    const japaneseVAs = charEntry.voice_actors.filter(
      (va: any) => va && va.language === 'Japanese'
    );
    result.voice_actors = japaneseVAs.map((va: any) => {
      const normalized: any = { language: 'Japanese' };
      if (va.person) {
        normalized.person = normalizeJikanVoiceActorPersonForCache(va.person);
      }
      return normalized;
    });
  } else {
    result.voice_actors = [];
  }

  return result;
}


export function normalizeJikanAnimeCharactersForCache(characters: any) {
  if (!Array.isArray(characters)) return characters;
  return characters.map(normalizeJikanCharacterEntryForCache);
}

// episodes normalizer

function normalizeJikanEpisodeForCache(episode: any) {
  return pickDefined(episode, EPISODE_KEYS);
}

export function normalizeJikanAnimeEpisodesForCache(episodes: any) {
  if (!Array.isArray(episodes)) return episodes;
  return episodes.map(normalizeJikanEpisodeForCache);
}

//  catalog item normalizer

export function normalizeJikanCatalogItemForCache(item: any) {
  if (!item || typeof item !== 'object') return item;

  const normalized: any = pickDefined(item, CATALOG_ITEM_KEYS);

  // images - only jpg.large_image_url
  if (item.images !== undefined) {
    normalized.images = normalizeJikanImagesForCache(item.images);
  }

  // trailer - only youtube_id
  if (item.trailer !== undefined) {
    normalized.trailer = normalizeJikanTrailerForCache(item.trailer);
  }

  // aired - from and to
  if (item.aired !== undefined) {
    normalized.aired = normalizeJikanAiredForCache(item.aired);
  }

  return normalized;
}


export function normalizeJikanCatalogForCache(items: any) {
  if (!Array.isArray(items)) return items;
  return items.map(normalizeJikanCatalogItemForCache);
}

export const jikanCacheNormalizers = {
  normalizeJikanAnimeDetailsForCache,
  normalizeJikanAnimeCharactersForCache,
  normalizeJikanAnimeEpisodesForCache,
  normalizeJikanCatalogItemForCache,
  normalizeJikanCatalogForCache,
};
