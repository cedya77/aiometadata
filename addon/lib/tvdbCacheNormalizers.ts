const TRANSLATION_NAME_KEYS = ['language', 'name'];
const TRANSLATION_OVERVIEW_KEYS = ['language', 'overview'];
const ARTWORK_KEYS = ['id', 'image', 'type', 'language', 'thumbnail', 'width', 'height', 'score', 'includesText'];
const CHARACTER_KEYS = ['id', 'name', 'peopleId', 'peopleType', 'personName', 'personImgURL', 'image', 'type', 'sort', 'isFeatured'];
const USED_CHARACTER_TYPES = new Set(['Actor', 'Director', 'Writer']);
// Artwork type IDs actually consumed: 2=series poster, 3=background, 14=movie poster, 15=movie background, 23=series logo, 25=movie logo
const USED_SERIES_ARTWORK_TYPES = new Set([2, 3, 23]);
const USED_MOVIE_ARTWORK_TYPES = new Set([3, 14, 15, 25]);
const REMOTE_ID_KEYS = ['id', 'sourceName', 'sourceId', 'url'];
const GENRE_KEYS = ['id', 'name', 'slug'];
const CONTENT_RATING_KEYS = ['id', 'name', 'country', 'contentType', 'description'];
const TRAILER_KEYS = ['id', 'name', 'url', 'language', 'runtime', 'thumbnail'];
const STATUS_KEYS = ['id', 'name', 'recordType', 'keepUpdated'];
const SEASON_KEYS = ['id', 'name', 'slug', 'number', 'image', 'year'];
const SEASON_TYPE_KEYS = ['id', 'name', 'type', 'alternateName'];
const FIRST_RELEASE_KEYS = ['Date', 'date', 'country', 'releaseDate'];
const EPISODE_RESPONSE_KEYS = ['pageInfo'];
const EPISODE_KEYS = ['id', 'name', 'number', 'seasonNumber', 'absoluteNumber', 'overview', 'image', 'aired', 'runtime'];
const SERIES_EXTENDED_KEYS = [
  'id',
  'name',
  'slug',
  'image',
  'overview',
  'firstAired',
  'lastAired',
  'year',
  'runtime',
  'averageRuntime',
  'originalCountry',
  'originalLanguage',
  'defaultSeasonType',
  'airsTime',
  'airsDayOfWeek',
  'aliases',
  'nameTranslations',
  'overviewTranslations',
];
const MOVIE_EXTENDED_KEYS = [
  'id',
  'name',
  'slug',
  'image',
  'overview',
  'runtime',
  'year',
  'originalCountry',
  'originalLanguage',
  'aliases',
  'nameTranslations',
  'overviewTranslations',
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

function mapIfArray(value: any, normalizer: (item: any) => any) {
  if (!Array.isArray(value)) return value;

  const result = new Array(value.length);
  for (let index = 0; index < value.length; index++) {
    result[index] = normalizer(value[index]);
  }
  return result;
}

function normalizeTvdbTranslationsForCache(translations: any) {
  if (!translations || typeof translations !== 'object') return translations;

  return {
    nameTranslations: Array.isArray(translations.nameTranslations)
      ? mapIfArray(translations.nameTranslations, (translation: any) => pickDefined(translation, TRANSLATION_NAME_KEYS))
      : translations.nameTranslations,
    overviewTranslations: Array.isArray(translations.overviewTranslations)
      ? mapIfArray(translations.overviewTranslations, (translation: any) => pickDefined(translation, TRANSLATION_OVERVIEW_KEYS))
      : translations.overviewTranslations,
  };
}

function normalizeTvdbArtworkForCache(artwork: any) {
  return pickDefined(artwork, ARTWORK_KEYS);
}

function normalizeTvdbCharacterForCache(character: any) {
  return pickDefined(character, CHARACTER_KEYS);
}

function isUsedTvdbCharacter(character: any) {
  if (!character || typeof character !== 'object') return false;
  return USED_CHARACTER_TYPES.has(character.peopleType);
}

function normalizeTvdbRemoteIdForCache(remoteId: any) {
  return pickDefined(remoteId, REMOTE_ID_KEYS);
}

function normalizeTvdbGenreForCache(genre: any) {
  return pickDefined(genre, GENRE_KEYS);
}

function normalizeTvdbContentRatingForCache(contentRating: any) {
  return pickDefined(contentRating, CONTENT_RATING_KEYS);
}

function normalizeTvdbTrailerForCache(trailer: any) {
  return pickDefined(trailer, TRAILER_KEYS);
}

function normalizeTvdbStatusForCache(status: any) {
  if (!status || typeof status !== 'object') return status;
  return pickDefined(status, STATUS_KEYS);
}

function normalizeTvdbSeasonForCache(season: any) {
  if (!season || typeof season !== 'object') return season;

  const result = pickDefined(season, SEASON_KEYS);
  if (season.type !== undefined) result.type = pickDefined(season.type, SEASON_TYPE_KEYS);
  return result;
}

function normalizeTvdbFirstReleaseForCache(firstRelease: any) {
  if (!firstRelease || typeof firstRelease !== 'object') return firstRelease;
  return pickDefined(firstRelease, FIRST_RELEASE_KEYS);
}

export function normalizeTvdbSeriesEpisodesForCache(response: any) {
  if (!response || !Array.isArray(response.episodes)) return response;

  return {
    ...pickDefined(response, EPISODE_RESPONSE_KEYS),
    episodes: mapIfArray(response.episodes, (episode: any) => pickDefined(episode, EPISODE_KEYS)),
  };
}

export function normalizeTvdbSeriesExtendedForCache(series: any) {
  if (!series || typeof series !== 'object') return series;

  return {
    ...pickDefined(series, SERIES_EXTENDED_KEYS),
    ...(series.status !== undefined ? { status: normalizeTvdbStatusForCache(series.status) } : {}),
    ...(Array.isArray(series.genres) ? { genres: mapIfArray(series.genres, normalizeTvdbGenreForCache) } : {}),
    ...(Array.isArray(series.contentRatings) ? { contentRatings: mapIfArray(series.contentRatings, normalizeTvdbContentRatingForCache) } : {}),
    ...(Array.isArray(series.characters) ? { characters: mapIfArray(series.characters.filter(isUsedTvdbCharacter), normalizeTvdbCharacterForCache) } : {}),
    ...(Array.isArray(series.remoteIds) ? { remoteIds: mapIfArray(series.remoteIds, normalizeTvdbRemoteIdForCache) } : {}),
    ...(Array.isArray(series.seasons) ? { seasons: mapIfArray(series.seasons, normalizeTvdbSeasonForCache) } : {}),
    ...(Array.isArray(series.artworks) ? { artworks: mapIfArray(series.artworks.filter(a => USED_SERIES_ARTWORK_TYPES.has(a?.type)), normalizeTvdbArtworkForCache) } : {}),
    ...(Array.isArray(series.trailers) ? { trailers: mapIfArray(series.trailers, normalizeTvdbTrailerForCache) } : {}),
    ...(series.translations !== undefined ? { translations: normalizeTvdbTranslationsForCache(series.translations) } : {}),
  };
}

export function normalizeTvdbMovieExtendedForCache(movie: any) {
  if (!movie || typeof movie !== 'object') return movie;

  return {
    ...pickDefined(movie, MOVIE_EXTENDED_KEYS),
    ...(movie.first_release !== undefined ? { first_release: normalizeTvdbFirstReleaseForCache(movie.first_release) } : {}),
    ...(Array.isArray(movie.genres) ? { genres: mapIfArray(movie.genres, normalizeTvdbGenreForCache) } : {}),
    ...(Array.isArray(movie.contentRatings) ? { contentRatings: mapIfArray(movie.contentRatings, normalizeTvdbContentRatingForCache) } : {}),
    ...(Array.isArray(movie.characters) ? { characters: mapIfArray(movie.characters.filter(isUsedTvdbCharacter), normalizeTvdbCharacterForCache) } : {}),
    ...(Array.isArray(movie.remoteIds) ? { remoteIds: mapIfArray(movie.remoteIds, normalizeTvdbRemoteIdForCache) } : {}),
    ...(Array.isArray(movie.artworks) ? { artworks: mapIfArray(movie.artworks.filter(a => USED_MOVIE_ARTWORK_TYPES.has(a?.type)), normalizeTvdbArtworkForCache) } : {}),
    ...(Array.isArray(movie.trailers) ? { trailers: mapIfArray(movie.trailers, normalizeTvdbTrailerForCache) } : {}),
    ...(movie.translations !== undefined ? { translations: normalizeTvdbTranslationsForCache(movie.translations) } : {}),
  };
}

export const tvdbCacheNormalizers = {
  normalizeTvdbSeriesEpisodesForCache,
  normalizeTvdbSeriesExtendedForCache,
  normalizeTvdbMovieExtendedForCache,
};
