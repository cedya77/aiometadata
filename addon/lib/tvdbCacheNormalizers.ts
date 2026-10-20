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
const SEASON_KEYS = ['id', 'name', 'slug', 'number', 'image', 'year', 'posters'];
const SEASON_TYPE_KEYS = ['id', 'name', 'type', 'alternateName'];
const FIRST_RELEASE_KEYS = ['Date', 'date', 'country', 'releaseDate'];
const EPISODE_RESPONSE_KEYS = ['pageInfo'];
const PERSON_KEYS = ['id', 'name', 'image', 'birth', 'death', 'birthPlace'];
const BIOGRAPHY_KEYS = ['language', 'biography'];
const PERSON_CREDIT_KEYS = ['peopleType', 'type', 'seriesId', 'movieId'];
const CREDIT_RECORD_KEYS = ['name', 'image', 'year'];
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
  'airsDays',
  'aliases',
  'nameTranslations',
  'overviewTranslations',
];
const COMPANY_KEYS = ['name'];
const MOVIE_COMPANY_KINDS = ['studio', 'production'];

function normalizeTvdbCompanyForCache(company: any) {
  if (!company || typeof company !== 'object') return company;
  const result = pickDefined(company, COMPANY_KEYS);
  if (company.companyType?.companyTypeName) result.companyType = { companyTypeName: company.companyType.companyTypeName };
  return result;
}

function normalizeTvdbMovieCompaniesForCache(companies: any) {
  if (!companies || typeof companies !== 'object' || Array.isArray(companies)) return companies;
  return Object.fromEntries(
    MOVIE_COMPANY_KINDS.filter((kind) => Array.isArray(companies[kind])).map((kind) => [kind, mapIfArray(companies[kind], (company: any) => pickDefined(company, COMPANY_KEYS))])
  );
}

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

// findArtwork() only uses .find() — the first match per (type, language).
// Keep the highest-scored artwork per group to avoid caching more than we need.
function deduplicateArtworks(artworks: any[]): any[] {
  const bestByKey = new Map<string, any>();
  for (const artwork of artworks) {
    const key = `${artwork.type}:${artwork.language ?? 'null'}`;
    const existing = bestByKey.get(key);
    if (!existing || (artwork.score ?? 0) > (existing.score ?? 0)) {
      bestByKey.set(key, artwork);
    }
  }
  return Array.from(bestByKey.values());
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

const SEASON_POSTER_ARTWORK_TYPE = 7;
const SEASON_POSTER_KEYS = ['image', 'language', 'score'];

function withSeasonPosters(seasons: any[], artworks: any[] | undefined) {
  if (!Array.isArray(artworks)) return seasons;

  const postersBySeason = new Map<number, any[]>();
  for (const artwork of artworks) {
    if (artwork?.type !== SEASON_POSTER_ARTWORK_TYPE || !artwork.image || artwork.seasonId == null) continue;
    const list = postersBySeason.get(artwork.seasonId) || [];
    list.push(artwork);
    postersBySeason.set(artwork.seasonId, list);
  }

  return seasons.map(season => {
    const posters = season?.type?.type === 'official' ? postersBySeason.get(season.id) : undefined;
    if (!posters) return season;

    const byLanguage = new Map<string, any>();
    for (const poster of posters) {
      const key = poster.language ?? 'null';
      const held = byLanguage.get(key);
      if (!held || (held.image !== season.image && (poster.image === season.image || (poster.score ?? 0) > (held.score ?? 0)))) {
        byLanguage.set(key, poster);
      }
    }
    return { ...season, posters: Array.from(byLanguage.values(), poster => pickDefined(poster, SEASON_POSTER_KEYS)) };
  });
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
    ...(series.originalNetwork?.name ? { originalNetwork: { name: series.originalNetwork.name } } : {}),
    ...(series.latestNetwork?.name ? { latestNetwork: { name: series.latestNetwork.name } } : {}),
    ...(Array.isArray(series.companies) ? { companies: mapIfArray(series.companies, normalizeTvdbCompanyForCache) } : {}),
    ...(Array.isArray(series.genres) ? { genres: mapIfArray(series.genres, normalizeTvdbGenreForCache) } : {}),
    ...(Array.isArray(series.contentRatings) ? { contentRatings: mapIfArray(series.contentRatings, normalizeTvdbContentRatingForCache) } : {}),
    ...(Array.isArray(series.characters) ? { characters: mapIfArray(series.characters.filter(isUsedTvdbCharacter), normalizeTvdbCharacterForCache) } : {}),
    ...(Array.isArray(series.remoteIds) ? { remoteIds: mapIfArray(series.remoteIds, normalizeTvdbRemoteIdForCache) } : {}),
    ...(Array.isArray(series.seasons) ? { seasons: mapIfArray(withSeasonPosters(series.seasons, series.artworks), normalizeTvdbSeasonForCache) } : {}),
    ...(Array.isArray(series.artworks) ? { artworks: mapIfArray(deduplicateArtworks(series.artworks.filter(a => USED_SERIES_ARTWORK_TYPES.has(a?.type))), normalizeTvdbArtworkForCache) } : {}),
    ...(Array.isArray(series.trailers) ? { trailers: mapIfArray(series.trailers, normalizeTvdbTrailerForCache) } : {}),
    ...(series.translations !== undefined ? { translations: normalizeTvdbTranslationsForCache(series.translations) } : {}),
  };
}

export function normalizeTvdbMovieExtendedForCache(movie: any) {
  if (!movie || typeof movie !== 'object') return movie;

  return {
    ...pickDefined(movie, MOVIE_EXTENDED_KEYS),
    ...(movie.first_release !== undefined ? { first_release: normalizeTvdbFirstReleaseForCache(movie.first_release) } : {}),
    ...(movie.companies !== undefined ? { companies: normalizeTvdbMovieCompaniesForCache(movie.companies) } : {}),
    ...(Array.isArray(movie.production_countries) ? { production_countries: mapIfArray(movie.production_countries, (country: any) => pickDefined(country, ['name'])) } : {}),
    ...(Array.isArray(movie.genres) ? { genres: mapIfArray(movie.genres, normalizeTvdbGenreForCache) } : {}),
    ...(Array.isArray(movie.contentRatings) ? { contentRatings: mapIfArray(movie.contentRatings, normalizeTvdbContentRatingForCache) } : {}),
    ...(Array.isArray(movie.characters) ? { characters: mapIfArray(movie.characters.filter(isUsedTvdbCharacter), normalizeTvdbCharacterForCache) } : {}),
    ...(Array.isArray(movie.remoteIds) ? { remoteIds: mapIfArray(movie.remoteIds, normalizeTvdbRemoteIdForCache) } : {}),
    ...(Array.isArray(movie.artworks) ? { artworks: mapIfArray(deduplicateArtworks(movie.artworks.filter(a => USED_MOVIE_ARTWORK_TYPES.has(a?.type))), normalizeTvdbArtworkForCache) } : {}),
    ...(Array.isArray(movie.trailers) ? { trailers: mapIfArray(movie.trailers, normalizeTvdbTrailerForCache) } : {}),
    ...(movie.translations !== undefined ? { translations: normalizeTvdbTranslationsForCache(movie.translations) } : {}),
  };
}

export function normalizeTvdbPersonExtendedForCache(person: any) {
  if (!person || typeof person !== 'object') return person;

  return {
    ...pickDefined(person, PERSON_KEYS),
    ...(Array.isArray(person.biographies) ? { biographies: mapIfArray(person.biographies, (b: any) => pickDefined(b, BIOGRAPHY_KEYS)) } : {}),
    ...(Array.isArray(person.remoteIds) ? { remoteIds: mapIfArray(person.remoteIds, normalizeTvdbRemoteIdForCache) } : {}),
    ...(Array.isArray(person.characters)
      ? {
          characters: mapIfArray(person.characters.filter((c: any) => c?.seriesId || c?.movieId), (c: any) => ({
            ...pickDefined(c, PERSON_CREDIT_KEYS),
            ...(c.series ? { series: pickDefined(c.series, CREDIT_RECORD_KEYS) } : {}),
            ...(c.movie ? { movie: pickDefined(c.movie, CREDIT_RECORD_KEYS) } : {}),
          })),
        }
      : {}),
  };
}

export const tvdbCacheNormalizers = {
  normalizeTvdbPersonExtendedForCache,
  normalizeTvdbSeriesEpisodesForCache,
  normalizeTvdbSeriesExtendedForCache,
  normalizeTvdbMovieExtendedForCache,
};
