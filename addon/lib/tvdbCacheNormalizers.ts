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

function normalizeTvdbTranslationsForCache(translations: any) {
  if (!translations || typeof translations !== 'object') return translations;

  return {
    nameTranslations: Array.isArray(translations.nameTranslations)
      ? translations.nameTranslations.map((translation: any) => pickDefined(translation, ['language', 'name']))
      : translations.nameTranslations,
    overviewTranslations: Array.isArray(translations.overviewTranslations)
      ? translations.overviewTranslations.map((translation: any) => pickDefined(translation, ['language', 'overview']))
      : translations.overviewTranslations,
  };
}

function normalizeTvdbArtworkForCache(artwork: any) {
  return pickDefined(artwork, [
    'id',
    'image',
    'type',
    'language',
    'thumbnail',
    'width',
    'height',
    'score',
    'includesText',
  ]);
}

function normalizeTvdbCharacterForCache(character: any) {
  return pickDefined(character, [
    'id',
    'name',
    'peopleId',
    'peopleType',
    'personName',
    'personImgURL',
    'image',
    'type',
    'sort',
    'isFeatured',
  ]);
}

function normalizeTvdbRemoteIdForCache(remoteId: any) {
  return pickDefined(remoteId, ['id', 'sourceName', 'sourceId', 'url']);
}

function normalizeTvdbGenreForCache(genre: any) {
  return pickDefined(genre, ['id', 'name', 'slug']);
}

function normalizeTvdbContentRatingForCache(contentRating: any) {
  return pickDefined(contentRating, ['id', 'name', 'country', 'contentType', 'description']);
}

function normalizeTvdbTrailerForCache(trailer: any) {
  return pickDefined(trailer, ['id', 'name', 'url', 'language', 'runtime', 'thumbnail']);
}

function normalizeTvdbStatusForCache(status: any) {
  if (!status || typeof status !== 'object') return status;
  return pickDefined(status, ['id', 'name', 'recordType', 'keepUpdated']);
}

function normalizeTvdbSeasonForCache(season: any) {
  if (!season || typeof season !== 'object') return season;

  return {
    ...pickDefined(season, ['id', 'name', 'slug', 'number', 'image', 'year']),
    ...(season.type !== undefined
      ? { type: pickDefined(season.type, ['id', 'name', 'type', 'alternateName']) }
      : {}),
  };
}

function normalizeTvdbFirstReleaseForCache(firstRelease: any) {
  if (!firstRelease || typeof firstRelease !== 'object') return firstRelease;
  return pickDefined(firstRelease, ['Date', 'date', 'country', 'releaseDate']);
}

export function normalizeTvdbSeriesEpisodesForCache(response: any) {
  if (!response || !Array.isArray(response.episodes)) return response;

  return {
    ...pickDefined(response, ['pageInfo']),
    episodes: response.episodes.map((episode: any) => pickDefined(episode, [
      'id',
      'name',
      'number',
      'seasonNumber',
      'absoluteNumber',
      'overview',
      'image',
      'aired',
      'runtime',
    ])),
  };
}

export function normalizeTvdbSeriesExtendedForCache(series: any) {
  if (!series || typeof series !== 'object') return series;

  return {
    ...pickDefined(series, [
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
    ]),
    ...(series.status !== undefined ? { status: normalizeTvdbStatusForCache(series.status) } : {}),
    ...(Array.isArray(series.genres) ? { genres: series.genres.map(normalizeTvdbGenreForCache) } : {}),
    ...(Array.isArray(series.contentRatings) ? { contentRatings: series.contentRatings.map(normalizeTvdbContentRatingForCache) } : {}),
    ...(Array.isArray(series.characters) ? { characters: series.characters.map(normalizeTvdbCharacterForCache) } : {}),
    ...(Array.isArray(series.remoteIds) ? { remoteIds: series.remoteIds.map(normalizeTvdbRemoteIdForCache) } : {}),
    ...(Array.isArray(series.seasons) ? { seasons: series.seasons.map(normalizeTvdbSeasonForCache) } : {}),
    ...(Array.isArray(series.artworks) ? { artworks: series.artworks.map(normalizeTvdbArtworkForCache) } : {}),
    ...(Array.isArray(series.trailers) ? { trailers: series.trailers.map(normalizeTvdbTrailerForCache) } : {}),
    ...(series.translations !== undefined ? { translations: normalizeTvdbTranslationsForCache(series.translations) } : {}),
  };
}

export function normalizeTvdbMovieExtendedForCache(movie: any) {
  if (!movie || typeof movie !== 'object') return movie;

  return {
    ...pickDefined(movie, [
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
    ]),
    ...(movie.first_release !== undefined ? { first_release: normalizeTvdbFirstReleaseForCache(movie.first_release) } : {}),
    ...(Array.isArray(movie.genres) ? { genres: movie.genres.map(normalizeTvdbGenreForCache) } : {}),
    ...(Array.isArray(movie.contentRatings) ? { contentRatings: movie.contentRatings.map(normalizeTvdbContentRatingForCache) } : {}),
    ...(Array.isArray(movie.characters) ? { characters: movie.characters.map(normalizeTvdbCharacterForCache) } : {}),
    ...(Array.isArray(movie.remoteIds) ? { remoteIds: movie.remoteIds.map(normalizeTvdbRemoteIdForCache) } : {}),
    ...(Array.isArray(movie.artworks) ? { artworks: movie.artworks.map(normalizeTvdbArtworkForCache) } : {}),
    ...(Array.isArray(movie.trailers) ? { trailers: movie.trailers.map(normalizeTvdbTrailerForCache) } : {}),
    ...(movie.translations !== undefined ? { translations: normalizeTvdbTranslationsForCache(movie.translations) } : {}),
  };
}

export const tvdbCacheNormalizers = {
  normalizeTvdbSeriesEpisodesForCache,
  normalizeTvdbSeriesExtendedForCache,
  normalizeTvdbMovieExtendedForCache,
};
