const GENRE_KEYS = ['id', 'name'];
const PRODUCTION_COUNTRY_KEYS = ['iso_3166_1', 'name'];
const IMAGE_KEYS = ['file_path', 'iso_639_1', 'iso_3166_1', 'vote_average', 'vote_count', 'width', 'height', 'aspect_ratio'];
const CAST_CREDIT_KEYS = ['id', 'name', 'original_name', 'character', 'profile_path', 'order'];
const CREW_CREDIT_KEYS = ['id', 'name', 'original_name', 'job', 'department', 'profile_path'];
const USED_CREW_JOBS = new Set(['Director', 'Writer', 'Creator']);
const USED_CREW_DEPARTMENTS = new Set(['Writing']);
const VIDEO_KEYS = ['id', 'name', 'key', 'site', 'type', 'iso_639_1', 'iso_3166_1'];
const TRANSLATION_KEYS = ['iso_3166_1', 'iso_639_1', 'name', 'english_name'];
const TRANSLATION_DATA_KEYS = ['title', 'name', 'overview'];
const EXTERNAL_ID_KEYS = ['imdb_id', 'tvdb_id', 'wikidata_id', 'facebook_id', 'instagram_id', 'twitter_id'];
const RELEASE_DATE_KEYS = ['certification', 'type', 'release_date'];
const CONTENT_RATING_KEYS = ['iso_3166_1', 'rating'];
const KEYWORD_KEYS = ['id', 'name'];
const PROVIDER_KEYS = ['provider_id', 'provider_name', 'logo_path', 'display_priority'];
const PROVIDER_BUCKET_KEYS = ['flatrate', 'rent', 'buy', 'free', 'ads'] as const;
const EPISODE_KEYS = ['id', 'name', 'overview', 'air_date', 'episode_number', 'season_number', 'still_path', 'runtime'];
const SEASON_KEYS = ['id', '_id', 'air_date', 'episode_count', 'name', 'overview', 'poster_path', 'season_number', 'vote_average'];
const DETAIL_COMMON_KEYS = [
  'id',
  'title',
  'original_title',
  'name',
  'original_name',
  'original_language',
  'overview',
  'runtime',
  'episode_run_time',
  'release_date',
  'first_air_date',
  'last_air_date',
  'status',
  'origin_country',
  'vote_average',
  'vote_count',
  'popularity',
  'adult',
  'poster_path',
  'backdrop_path',
  'imdb_id',
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

function normalizeTmdbGenreForCache(genre: any) {
  return pickDefined(genre, GENRE_KEYS);
}

function normalizeTmdbProductionCountryForCache(country: any) {
  return pickDefined(country, PRODUCTION_COUNTRY_KEYS);
}

function normalizeTmdbImageForCache(image: any) {
  return pickDefined(image, IMAGE_KEYS);
}

export function normalizeTmdbImagesForCache(images: any) {
  if (!images || typeof images !== 'object') return images;

  const result: any = {};
  if (images.posters !== undefined) result.posters = mapIfArray(images.posters, normalizeTmdbImageForCache);
  if (images.backdrops !== undefined) result.backdrops = mapIfArray(images.backdrops, normalizeTmdbImageForCache);
  if (images.logos !== undefined) result.logos = mapIfArray(images.logos, normalizeTmdbImageForCache);
  return result;
}

function normalizeTmdbCastCreditForCache(credit: any) {
  return pickDefined(credit, CAST_CREDIT_KEYS);
}

function normalizeTmdbCrewCreditForCache(credit: any) {
  return pickDefined(credit, CREW_CREDIT_KEYS);
}

function isUsedTmdbCrewCredit(credit: any) {
  if (!credit || typeof credit !== 'object') return false;
  return USED_CREW_JOBS.has(credit.job) || USED_CREW_DEPARTMENTS.has(credit.department);
}

function normalizeTmdbCreditsForCache(credits: any) {
  if (!credits || typeof credits !== 'object') return credits;

  const result: any = {};
  if (credits.cast !== undefined) result.cast = mapIfArray(credits.cast, normalizeTmdbCastCreditForCache);
  if (credits.crew !== undefined) {
    const usedCrew = Array.isArray(credits.crew) ? credits.crew.filter(isUsedTmdbCrewCredit) : credits.crew;
    result.crew = mapIfArray(usedCrew, normalizeTmdbCrewCreditForCache);
  }
  return result;
}

function normalizeTmdbVideoForCache(video: any) {
  return pickDefined(video, VIDEO_KEYS);
}

function normalizeTmdbVideosForCache(videos: any) {
  if (!videos || typeof videos !== 'object') return videos;

  const result: any = {};
  if (videos.results !== undefined) result.results = mapIfArray(videos.results, normalizeTmdbVideoForCache);
  return result;
}

function normalizeTmdbTranslationForCache(translation: any) {
  if (!translation || typeof translation !== 'object') return translation;

  const result = pickDefined(translation, TRANSLATION_KEYS);
  if (translation.data !== undefined) result.data = pickDefined(translation.data, TRANSLATION_DATA_KEYS);
  return result;
}

function normalizeTmdbTranslationsForCache(translations: any) {
  if (!translations || typeof translations !== 'object') return translations;

  const result: any = {};
  if (translations.translations !== undefined) result.translations = mapIfArray(translations.translations, normalizeTmdbTranslationForCache);
  return result;
}

export function normalizeTmdbExternalIdsForCache(externalIds: any) {
  return pickDefined(externalIds, EXTERNAL_ID_KEYS);
}

function normalizeTmdbReleaseDateForCache(releaseDate: any) {
  return pickDefined(releaseDate, RELEASE_DATE_KEYS);
}

function normalizeTmdbReleaseCountryForCache(country: any) {
  const result = pickDefined(country, ['iso_3166_1']);
  if (country.release_dates !== undefined) {
    result.release_dates = mapIfArray(country.release_dates, normalizeTmdbReleaseDateForCache);
  }
  return result;
}

export function normalizeTmdbReleaseDatesForCache(releaseDates: any) {
  if (!releaseDates || typeof releaseDates !== 'object') return releaseDates;

  const result: any = {};
  if (releaseDates.results !== undefined) result.results = mapIfArray(releaseDates.results, normalizeTmdbReleaseCountryForCache);
  return result;
}

export function normalizeTmdbContentRatingsForCache(contentRatings: any) {
  if (!contentRatings || typeof contentRatings !== 'object') return contentRatings;

  const result: any = {};
  if (contentRatings.results !== undefined) {
    result.results = mapIfArray(contentRatings.results, normalizeTmdbContentRatingForCache);
  }
  return result;
}

function normalizeTmdbContentRatingForCache(rating: any) {
  return pickDefined(rating, CONTENT_RATING_KEYS);
}

function normalizeTmdbKeywordForCache(keyword: any) {
  return pickDefined(keyword, KEYWORD_KEYS);
}

function normalizeTmdbKeywordsForCache(keywords: any) {
  if (!keywords || typeof keywords !== 'object') return keywords;

  const result: any = {};
  if (keywords.keywords !== undefined) result.keywords = mapIfArray(keywords.keywords, normalizeTmdbKeywordForCache);
  if (keywords.results !== undefined) result.results = mapIfArray(keywords.results, normalizeTmdbKeywordForCache);
  return result;
}

function normalizeTmdbProviderForCache(provider: any) {
  return pickDefined(provider, PROVIDER_KEYS);
}

export function normalizeTmdbWatchProvidersForCache(watchProviders: any) {
  if (!watchProviders || typeof watchProviders !== 'object') return watchProviders;

  const normalizedResults: any = {};
  for (const [country, data] of Object.entries(watchProviders.results || {})) {
    if (!data || typeof data !== 'object') {
      normalizedResults[country] = data;
      continue;
    }

    const normalizedCountry = pickDefined(data, ['link']);
    for (const key of PROVIDER_BUCKET_KEYS) {
      if ((data as any)[key] !== undefined) {
        normalizedCountry[key] = mapIfArray((data as any)[key], normalizeTmdbProviderForCache);
      }
    }
    normalizedResults[country] = normalizedCountry;
  }

  const result: any = {};
  if (watchProviders.results !== undefined) result.results = normalizedResults;
  return result;
}

function normalizeTmdbEpisodeForCache(episode: any) {
  return pickDefined(episode, EPISODE_KEYS);
}

export function normalizeTmdbSeasonForCache(season: any) {
  if (!season || typeof season !== 'object') return season;

  const result = pickDefined(season, SEASON_KEYS);
  if (season.episodes !== undefined) result.episodes = mapIfArray(season.episodes, normalizeTmdbEpisodeForCache);
  return result;
}

export function normalizeTmdbGenreListForCache(genreList: any) {
  if (!genreList || typeof genreList !== 'object') return genreList;

  const result: any = {};
  if (genreList.genres !== undefined) result.genres = mapIfArray(genreList.genres, normalizeTmdbGenreForCache);
  return result;
}

export function normalizeTmdbLanguagesForCache(languages: any) {
  return mapIfArray(languages, (language: any) => pickDefined(language, ['iso_639_1', 'english_name', 'name']));
}

export function normalizeTmdbPrimaryTranslationsForCache(translations: any) {
  return Array.isArray(translations)
    ? translations.filter((translation: any) => typeof translation === 'string')
    : translations;
}

function normalizeTmdbDetailCommonForCache(detail: any) {
  if (!detail || typeof detail !== 'object') return detail;

  const normalized: any = pickDefined(detail, DETAIL_COMMON_KEYS);
  if (detail.genres !== undefined) normalized.genres = mapIfArray(detail.genres, normalizeTmdbGenreForCache);
  if (detail.production_countries !== undefined) {
    normalized.production_countries = mapIfArray(detail.production_countries, normalizeTmdbProductionCountryForCache);
  }
  if (detail.external_ids !== undefined) normalized.external_ids = normalizeTmdbExternalIdsForCache(detail.external_ids);
  if (detail.images !== undefined) normalized.images = normalizeTmdbImagesForCache(detail.images);
  if (detail.credits !== undefined) normalized.credits = normalizeTmdbCreditsForCache(detail.credits);
  if (detail.videos !== undefined) normalized.videos = normalizeTmdbVideosForCache(detail.videos);
  if (detail.translations !== undefined) normalized.translations = normalizeTmdbTranslationsForCache(detail.translations);
  if (detail.release_dates !== undefined) normalized.release_dates = normalizeTmdbReleaseDatesForCache(detail.release_dates);
  if (detail.content_ratings !== undefined) normalized.content_ratings = normalizeTmdbContentRatingsForCache(detail.content_ratings);
  if (detail.keywords !== undefined) normalized.keywords = normalizeTmdbKeywordsForCache(detail.keywords);
  if (detail['watch/providers'] !== undefined) normalized['watch/providers'] = normalizeTmdbWatchProvidersForCache(detail['watch/providers']);
  if (detail.seasons !== undefined) normalized.seasons = mapIfArray(detail.seasons, normalizeTmdbSeasonForCache);
  if (detail.last_episode_to_air !== undefined) normalized.last_episode_to_air = normalizeTmdbEpisodeForCache(detail.last_episode_to_air);
  if (detail.next_episode_to_air !== undefined) normalized.next_episode_to_air = normalizeTmdbEpisodeForCache(detail.next_episode_to_air);

  for (const [key, value] of Object.entries(detail)) {
    if (key.startsWith('season/')) {
      normalized[key] = normalizeTmdbSeasonForCache(value);
    }
  }

  return normalized;
}

export function normalizeTmdbMovieDetailForCache(movie: any) {
  return normalizeTmdbDetailCommonForCache(movie);
}

export function normalizeTmdbTvDetailForCache(series: any) {
  return normalizeTmdbDetailCommonForCache(series);
}

export const tmdbCacheNormalizers = {
  normalizeTmdbExternalIdsForCache,
  normalizeTmdbGenreListForCache,
  normalizeTmdbLanguagesForCache,
  normalizeTmdbPrimaryTranslationsForCache,
  normalizeTmdbReleaseDatesForCache,
  normalizeTmdbContentRatingsForCache,
  normalizeTmdbWatchProvidersForCache,
  normalizeTmdbImagesForCache,
  normalizeTmdbSeasonForCache,
  normalizeTmdbMovieDetailForCache,
  normalizeTmdbTvDetailForCache,
};
