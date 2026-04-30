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
  return Array.isArray(value) ? value.map(normalizer) : value;
}

function normalizeTmdbGenreForCache(genre: any) {
  return pickDefined(genre, ['id', 'name']);
}

function normalizeTmdbProductionCountryForCache(country: any) {
  return pickDefined(country, ['iso_3166_1', 'name']);
}

function normalizeTmdbImageForCache(image: any) {
  return pickDefined(image, [
    'file_path',
    'iso_639_1',
    'iso_3166_1',
    'vote_average',
    'vote_count',
    'width',
    'height',
    'aspect_ratio',
  ]);
}

function normalizeTmdbImagesForCache(images: any) {
  if (!images || typeof images !== 'object') return images;

  return {
    ...(images.posters !== undefined ? { posters: mapIfArray(images.posters, normalizeTmdbImageForCache) } : {}),
    ...(images.backdrops !== undefined ? { backdrops: mapIfArray(images.backdrops, normalizeTmdbImageForCache) } : {}),
    ...(images.logos !== undefined ? { logos: mapIfArray(images.logos, normalizeTmdbImageForCache) } : {}),
  };
}

function normalizeTmdbCastCreditForCache(credit: any) {
  return pickDefined(credit, ['id', 'name', 'original_name', 'character', 'profile_path', 'order']);
}

function normalizeTmdbCrewCreditForCache(credit: any) {
  return pickDefined(credit, ['id', 'name', 'original_name', 'job', 'department', 'profile_path']);
}

function normalizeTmdbCreditsForCache(credits: any) {
  if (!credits || typeof credits !== 'object') return credits;

  return {
    ...(credits.cast !== undefined ? { cast: mapIfArray(credits.cast, normalizeTmdbCastCreditForCache) } : {}),
    ...(credits.crew !== undefined ? { crew: mapIfArray(credits.crew, normalizeTmdbCrewCreditForCache) } : {}),
  };
}

function normalizeTmdbVideoForCache(video: any) {
  return pickDefined(video, ['id', 'name', 'key', 'site', 'type', 'iso_639_1', 'iso_3166_1']);
}

function normalizeTmdbVideosForCache(videos: any) {
  if (!videos || typeof videos !== 'object') return videos;

  return {
    ...(videos.results !== undefined ? { results: mapIfArray(videos.results, normalizeTmdbVideoForCache) } : {}),
  };
}

function normalizeTmdbTranslationForCache(translation: any) {
  if (!translation || typeof translation !== 'object') return translation;

  return {
    ...pickDefined(translation, ['iso_3166_1', 'iso_639_1', 'name', 'english_name']),
    ...(translation.data !== undefined
      ? { data: pickDefined(translation.data, ['title', 'name', 'overview']) }
      : {}),
  };
}

function normalizeTmdbTranslationsForCache(translations: any) {
  if (!translations || typeof translations !== 'object') return translations;

  return {
    ...(translations.translations !== undefined
      ? { translations: mapIfArray(translations.translations, normalizeTmdbTranslationForCache) }
      : {}),
  };
}

function normalizeTmdbExternalIdsForCache(externalIds: any) {
  return pickDefined(externalIds, [
    'imdb_id',
    'tvdb_id',
    'wikidata_id',
    'facebook_id',
    'instagram_id',
    'twitter_id',
  ]);
}

function normalizeTmdbReleaseDateForCache(releaseDate: any) {
  return pickDefined(releaseDate, ['certification', 'type', 'release_date']);
}

function normalizeTmdbReleaseDatesForCache(releaseDates: any) {
  if (!releaseDates || typeof releaseDates !== 'object') return releaseDates;

  return {
    ...(releaseDates.results !== undefined
      ? {
          results: mapIfArray(releaseDates.results, (country: any) => ({
            ...pickDefined(country, ['iso_3166_1']),
            ...(country.release_dates !== undefined
              ? { release_dates: mapIfArray(country.release_dates, normalizeTmdbReleaseDateForCache) }
              : {}),
          })),
        }
      : {}),
  };
}

function normalizeTmdbContentRatingsForCache(contentRatings: any) {
  if (!contentRatings || typeof contentRatings !== 'object') return contentRatings;

  return {
    ...(contentRatings.results !== undefined
      ? { results: mapIfArray(contentRatings.results, (rating: any) => pickDefined(rating, ['iso_3166_1', 'rating'])) }
      : {}),
  };
}

function normalizeTmdbKeywordForCache(keyword: any) {
  return pickDefined(keyword, ['id', 'name']);
}

function normalizeTmdbKeywordsForCache(keywords: any) {
  if (!keywords || typeof keywords !== 'object') return keywords;

  return {
    ...(keywords.keywords !== undefined ? { keywords: mapIfArray(keywords.keywords, normalizeTmdbKeywordForCache) } : {}),
    ...(keywords.results !== undefined ? { results: mapIfArray(keywords.results, normalizeTmdbKeywordForCache) } : {}),
  };
}

function normalizeTmdbProviderForCache(provider: any) {
  return pickDefined(provider, ['provider_id', 'provider_name', 'logo_path', 'display_priority']);
}

function normalizeTmdbWatchProvidersForCache(watchProviders: any) {
  if (!watchProviders || typeof watchProviders !== 'object') return watchProviders;

  const normalizedResults: any = {};
  for (const [country, data] of Object.entries(watchProviders.results || {})) {
    if (!data || typeof data !== 'object') {
      normalizedResults[country] = data;
      continue;
    }

    normalizedResults[country] = {
      ...pickDefined(data, ['link']),
      ...(['flatrate', 'rent', 'buy', 'free', 'ads'] as const).reduce((acc: any, key) => {
        if ((data as any)[key] !== undefined) {
          acc[key] = mapIfArray((data as any)[key], normalizeTmdbProviderForCache);
        }
        return acc;
      }, {}),
    };
  }

  return {
    ...(watchProviders.results !== undefined ? { results: normalizedResults } : {}),
  };
}

function normalizeTmdbEpisodeForCache(episode: any) {
  return pickDefined(episode, [
    'id',
    'name',
    'overview',
    'air_date',
    'episode_number',
    'season_number',
    'still_path',
    'runtime',
  ]);
}

function normalizeTmdbSeasonForCache(season: any) {
  if (!season || typeof season !== 'object') return season;

  return {
    ...pickDefined(season, [
      'id',
      '_id',
      'air_date',
      'episode_count',
      'name',
      'overview',
      'poster_path',
      'season_number',
      'vote_average',
    ]),
    ...(season.episodes !== undefined ? { episodes: mapIfArray(season.episodes, normalizeTmdbEpisodeForCache) } : {}),
  };
}

function normalizeTmdbDetailCommonForCache(detail: any) {
  if (!detail || typeof detail !== 'object') return detail;

  const normalized: any = {
    ...pickDefined(detail, [
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
    ]),
    ...(detail.genres !== undefined ? { genres: mapIfArray(detail.genres, normalizeTmdbGenreForCache) } : {}),
    ...(detail.production_countries !== undefined
      ? { production_countries: mapIfArray(detail.production_countries, normalizeTmdbProductionCountryForCache) }
      : {}),
    ...(detail.external_ids !== undefined ? { external_ids: normalizeTmdbExternalIdsForCache(detail.external_ids) } : {}),
    ...(detail.images !== undefined ? { images: normalizeTmdbImagesForCache(detail.images) } : {}),
    ...(detail.credits !== undefined ? { credits: normalizeTmdbCreditsForCache(detail.credits) } : {}),
    ...(detail.videos !== undefined ? { videos: normalizeTmdbVideosForCache(detail.videos) } : {}),
    ...(detail.translations !== undefined ? { translations: normalizeTmdbTranslationsForCache(detail.translations) } : {}),
    ...(detail.release_dates !== undefined ? { release_dates: normalizeTmdbReleaseDatesForCache(detail.release_dates) } : {}),
    ...(detail.content_ratings !== undefined ? { content_ratings: normalizeTmdbContentRatingsForCache(detail.content_ratings) } : {}),
    ...(detail.keywords !== undefined ? { keywords: normalizeTmdbKeywordsForCache(detail.keywords) } : {}),
    ...(detail['watch/providers'] !== undefined
      ? { 'watch/providers': normalizeTmdbWatchProvidersForCache(detail['watch/providers']) }
      : {}),
    ...(detail.seasons !== undefined ? { seasons: mapIfArray(detail.seasons, normalizeTmdbSeasonForCache) } : {}),
    ...(detail.last_episode_to_air !== undefined ? { last_episode_to_air: normalizeTmdbEpisodeForCache(detail.last_episode_to_air) } : {}),
    ...(detail.next_episode_to_air !== undefined ? { next_episode_to_air: normalizeTmdbEpisodeForCache(detail.next_episode_to_air) } : {}),
  };

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
  normalizeTmdbMovieDetailForCache,
  normalizeTmdbTvDetailForCache,
};
