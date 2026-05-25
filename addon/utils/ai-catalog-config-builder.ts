import type { AICatalogOutput, CatalogConfig } from './ai-catalog-schema';
import { getSourceSchema } from './ai-catalog-schema';

function deriveFormState(source: string, catalogType: string, params: Record<string, any>): Record<string, any> {
  const fs: Record<string, any> = {};

  if (source === 'tmdb') {
    const schema = getSourceSchema(source, catalogType, params);
    fs.includeAdult = params.include_adult ?? false;
    if (params['vote_count.gte']) fs.voteCountMin = Number(params['vote_count.gte']);
    if (params['vote_average.gte'] !== undefined || params['vote_average.lte'] !== undefined) {
      fs.voteAverageRange = [Number(params['vote_average.gte'] ?? 0), Number(params['vote_average.lte'] ?? 10)];
    }
    if (params['with_runtime.gte'] !== undefined || params['with_runtime.lte'] !== undefined) {
      fs.runtimeRange = [Number(params['with_runtime.gte'] ?? 0), Number(params['with_runtime.lte'] ?? 400)];
    }
    if (params.with_original_language) fs.originalLanguage = params.with_original_language;
    if (params.with_origin_country) fs.originCountry = params.with_origin_country;
    if (params.certification_country) fs.certificationCountry = params.certification_country;
    if (params.certification) fs.certificationValue = params.certification;
    if (params['certification.lte']) { fs.certificationValue = params['certification.lte']; fs.certificationMode = 'lte'; }
    if (params['certification.gte']) { fs.certificationValue = params['certification.gte']; fs.certificationMode = 'gte'; }
    if (params.watch_region) fs.watchRegion = params.watch_region;
    if (params.region) fs.releaseRegion = params.region;
    if (params.with_release_type === '4|5|6' || params.with_status === '0|3|4|5') fs.releasedOnly = true;
    if (params.with_status && params.with_status !== '0|3|4|5') {
      fs.tmdbTvStatuses = String(params.with_status).split('|');
    }
    if (params.with_networks) {
      fs.withNetworks = String(params.with_networks).split(/[|,]/).map((id: string) => ({ id: Number(id), label: `Network ${id}` }));
    }

    if (catalogType === 'movie') {
      if (params['primary_release_date.gte']) fs.primaryReleaseFrom = params['primary_release_date.gte'];
      if (params['primary_release_date.lte']) fs.primaryReleaseTo = params['primary_release_date.lte'];
    } else {
      if (params['first_air_date.gte']) fs.firstAirFrom = params['first_air_date.gte'];
      if (params['first_air_date.lte']) fs.firstAirTo = params['first_air_date.lte'];
      if (params['air_date.gte']) fs.airDateFrom = params['air_date.gte'];
      if (params['air_date.lte']) fs.airDateTo = params['air_date.lte'];
    }

    if (params.with_genres) {
      const ids = String(params.with_genres).split(/[|,]/).map(Number);
      fs.includeGenres = ids.map(id => ({ id, label: schema.genreNames[id] || `Genre ${id}` }));
      fs.genreJoinMode = String(params.with_genres).includes('|') ? 'or' : 'and';
    }
    if (params.without_genres) {
      const ids = String(params.without_genres).split(/[|,]/).map(Number);
      fs.excludeGenres = ids.map(id => ({ id, label: schema.genreNames[id] || `Genre ${id}` }));
    }
  }

  if (source === 'anilist') {
    if (params.genre_in) fs.anilistIncludeGenres = String(params.genre_in).split(',').map((s: string) => s.trim());
    if (params.genre_not_in) fs.anilistExcludeGenres = String(params.genre_not_in).split(',').map((s: string) => s.trim());
    if (params.tag_in) fs.anilistIncludeTags = String(params.tag_in).split(',').map((s: string) => s.trim());
    if (params.tag_not_in) fs.anilistExcludeTags = String(params.tag_not_in).split(',').map((s: string) => s.trim());
    if (params.format_in) fs.anilistFormats = String(params.format_in).split(',').map((s: string) => s.trim());
    if (params.season) fs.anilistSeason = params.season;
    if (params.seasonYear) fs.anilistSeasonYear = String(params.seasonYear);
    if (params.status) fs.anilistStatus = params.status;
    if (params.countryOfOrigin) fs.anilistCountry = params.countryOfOrigin;
    if (params.averageScore_greater !== undefined || params.averageScore_lesser !== undefined) {
      fs.anilistScoreRange = [Number(params.averageScore_greater ?? 0), Number(params.averageScore_lesser ?? 100)];
    }
    if (params.popularity_greater) fs.anilistPopularityMin = Number(params.popularity_greater);
    if (params.episodes_greater !== undefined || params.episodes_lesser !== undefined) {
      fs.anilistEpisodesRange = [Number(params.episodes_greater ?? 0), Number(params.episodes_lesser ?? 200)];
    }
    if (params.duration_greater !== undefined || params.duration_lesser !== undefined) {
      fs.anilistDurationRange = [Number(params.duration_greater ?? 0), Number(params.duration_lesser ?? 180)];
    }
    if (params.isAdult !== undefined) fs.anilistIsAdult = params.isAdult;
    if (params.startDate_greater) fs.anilistStartDateFrom = String(params.startDate_greater).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    if (params.startDate_lesser) fs.anilistStartDateTo = String(params.startDate_lesser).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  }

  if (source === 'mal') {
    const schema = getSourceSchema(source, catalogType, params);
    if (params.order_by) fs.malOrderBy = params.order_by;
    if (params.sort) fs.malSortDirection = params.sort;
    if (params.type) fs.malType = params.type;
    if (params.status) fs.malStatus = params.status;
    if (params.rating) fs.malRating = params.rating;
    if (params.min_score) fs.malMinScore = Number(params.min_score);
    if (params.max_score) fs.malMaxScore = Number(params.max_score);
    if (params.season) fs.malSeason = params.season;
    if (params.seasonYear) fs.malSeasonYear = String(params.seasonYear);
    if (params.start_date) fs.malStartDate = params.start_date;
    if (params.end_date) fs.malEndDate = params.end_date;
    if (params.sfw !== undefined) fs.malSfw = params.sfw;
    if (params.genres) {
      fs.malIncludeGenreIds = String(params.genres).split(',').map((s: string) => {
        const id = Number(s.trim());
        return { id, label: schema.genres[id] || `Genre ${id}` };
      });
    }
    if (params.genres_exclude) {
      fs.malExcludeGenreIds = String(params.genres_exclude).split(',').map((s: string) => {
        const id = Number(s.trim());
        return { id, label: schema.genres[id] || `Genre ${id}` };
      });
    }
  }

  if (source === 'simkl') {
    if (params.media) fs.simklMediaType = params.media;
    if (params.genre) fs.simklGenre = params.genre;
    if (params.type) fs.simklType = params.type;
    if (params.country) fs.simklCountry = params.country;
    if (params.network) fs.simklNetwork = params.network;
    if (params.year) fs.simklYear = params.year;
  }

  if (source === 'tvdb') {
    if (params.sortType) fs.tvdbSortDirection = params.sortType;
    if (params.status) fs.tvdbStatus = String(params.status);
    if (params.year) fs.tvdbYear = String(params.year);
    if (params.country) fs.originCountry = params.country;
    if (params.lang) fs.originalLanguage = params.lang;
    if (params.genre) fs.includeGenres = [{ id: Number(params.genre), label: `Genre ${params.genre}` }];
    if (params.contentRating) fs.certificationValue = String(params.contentRating);
  }

  return fs;
}

function getSortBy(source: string, catalogType: string, params: Record<string, any>): string | undefined {
  const schema = getSourceSchema(source, catalogType, params);
  return schema?.sortParam ? params[schema.sortParam] : undefined;
}

export function buildCatalogConfigs(catalogs: AICatalogOutput[], resolvedParams: Record<string, string>[], originalQuery: string): CatalogConfig[] {
  const SOURCE_PREFIXES: Record<string, string> = {
    tmdb: 'tmdb.discover',
    tvdb: 'tvdb.discover',
    simkl: 'simkl.discover',
    mal: 'mal.discover',
    anilist: 'anilist.discover',
  };

  const SOURCE_LABELS: Record<string, string> = {
    tmdb: 'TMDB',
    tvdb: 'TVDB',
    simkl: 'SIMKL',
    mal: 'MAL',
    anilist: 'ANILIST',
  };

  return catalogs.map((catalog, i) => {
    const sanitizedName = catalog.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'ai_catalog';
    const uniqueSuffix = (Date.now() + i).toString(36);

    const sourcePrefix = SOURCE_PREFIXES[catalog.source] ?? 'tmdb.discover';
    const catalogTypeSegment = catalog.source === 'simkl'
      ? catalog.params.media || catalog.catalogType
      : (catalog.source === 'anilist' || catalog.source === 'mal')
        ? 'anime'
        : catalog.catalogType;

    const catalogId = `${sourcePrefix}.${catalogTypeSegment}.${sanitizedName}.${uniqueSuffix}`;

    const resolved = resolvedParams[i] || {};

    // Separate _formState_ metadata from actual params
    const formStateExtras: Record<string, any> = {};
    const cleanResolved: Record<string, any> = {};
    for (const [key, value] of Object.entries(resolved)) {
      if (key.startsWith('_formState_')) {
        const formKey = key.replace('_formState_', '');
        try { formStateExtras[formKey] = JSON.parse(value); } catch { formStateExtras[formKey] = value; }
      } else {
        cleanResolved[key] = value;
      }
    }

    const mergedParams = { ...catalog.params, ...cleanResolved };

    const sourceLabel = SOURCE_LABELS[catalog.source] ?? 'TMDB';
    const discoverMediaType = catalog.mediaType || catalog.catalogType;

    // Derive full formState from params so BYC editor can reconstruct the form
    const derivedFormState = deriveFormState(catalog.source, catalog.catalogType, mergedParams);

    return {
      id: catalogId,
      type: catalog.catalogType,
      name: catalog.name,
      enabled: true,
      showInHome: true,
      source: catalog.source,
      metadata: {
        description: `${sourceLabel} Discover (${discoverMediaType}) - AI Generated`,
        discover: {
          version: 2,
          source: catalog.source,
          mediaType: discoverMediaType,
          params: mergedParams,
          formState: {
            catalogName: catalog.name,
            discoverSource: catalog.source,
            catalogType: catalog.catalogType,
            sortBy: getSortBy(catalog.source, catalog.catalogType, mergedParams),
            aiGenerated: true,
            aiQuery: originalQuery,
            ...derivedFormState,
            ...formStateExtras,
          },
        },
      },
    };
  });
}
