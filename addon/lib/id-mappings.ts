import consola from 'consola';
import { IdField, IdMap, IndexStats, MappingIndex, ParsedMappings, buildIndex, lookup, parseMappingCsv } from './id-mapping-index';
import { MappingSource, SOURCES, downloadCsv, readCachedCsv } from './mapping-sources';
const redis = require('./redisClient');
const logger = consola.withTag('ID Mappings');

const UPDATE_INTERVAL_HOURS = parseInt(process.env.WIKI_MAPPER_UPDATE_INTERVAL_HOURS || '24');
const MAINTENANCE_KEY = 'maintenance:last_wiki_mapper_update';

type MediaType = 'series' | 'movie';

// Wikidata ids filled into dins rows were checked against TMDB, TVDB, Trakt and TVmaze: TMDB fills
// and movie fills were too often dead or another title, while series TVDB and TVmaze fills held up.
const MEDIA: Record<MediaType, { primary: MappingSource; backfill: MappingSource; withTvmaze: boolean; fillable: IdField[] }> = {
  series: { primary: SOURCES.dinsSeries, backfill: SOURCES.wikiSeries, withTvmaze: true, fillable: ['tvdbId', 'tvmazeId'] },
  movie: { primary: SOURCES.dinsMovies, backfill: SOURCES.wikiMovies, withTvmaze: false, fillable: [] },
};

let indexes: Record<MediaType, MappingIndex> | null = null;
let updateInterval: ReturnType<typeof setInterval> | null = null;

function parseSource(csv: string, source: MappingSource): ParsedMappings {
  const parsed = parseMappingCsv(csv);
  if (parsed.count === 0) throw new Error(`${source.name} has no valid rows`);
  logger.info(`Parsed ${source.name}: ${parsed.count} valid rows, ${parsed.invalid} invalid skipped`);
  return parsed;
}

function loadRows(source: MappingSource, skipIfUnchanged = false): Promise<ParsedMappings | null> {
  return downloadCsv(source, (csv) => parseSource(csv, source), skipIfUnchanged);
}

function build(type: MediaType, primaryRows: ParsedMappings, backfillRows: ParsedMappings): MappingIndex {
  const { withTvmaze, fillable } = MEDIA[type];
  const index = buildIndex(primaryRows, backfillRows, withTvmaze, fillable);
  const { primaryRows: dinsRows, backfilledRows, filled, conflicts } = index.stats;
  logger.info(`Built ${type} index: ${dinsRows} dins rows, ${backfilledRows} backfilled from Wikidata, filled ${JSON.stringify(filled)}, ${conflicts} conflicting Wikidata rows skipped`);
  return index;
}

async function loadAll(): Promise<Record<MediaType, MappingIndex>> {
  const [dinsSeries, wikiSeries, dinsMovies, wikiMovies] = await Promise.all(
    [SOURCES.dinsSeries, SOURCES.wikiSeries, SOURCES.dinsMovies, SOURCES.wikiMovies].map((source) => loadRows(source)),
  );
  return { series: build('series', dinsSeries, wikiSeries), movie: build('movie', dinsMovies, wikiMovies) };
}

// Downloads save the ETag before the index is built; reset them so a failed load is re-fetched next time.
async function clearSourceEtags(): Promise<void> {
  if (!redis || redis.status !== 'ready') return;
  try {
    await redis.del(...Object.values(SOURCES).map((source) => source.etagKey));
  } catch (error: any) {
    logger.warn(`Failed to clear ETags: ${error.message}`);
  }
}

async function markUpdated(): Promise<void> {
  if (!redis || redis.status !== 'ready') return;
  try {
    await redis.set(MAINTENANCE_KEY, Date.now().toString());
  } catch (error: any) {
    logger.warn(`Failed to record mapping update time: ${error.message}`);
  }
}

export async function refreshChangedMappings(): Promise<void> {
  ensureInitialized();
  try {
    const next = { ...indexes };
    let rebuilt = false;
    for (const type of ['series', 'movie'] as MediaType[]) {
      const { primary, backfill } = MEDIA[type];
      const [primaryRows, backfillRows] = await Promise.all([loadRows(primary, true), loadRows(backfill, true)]);
      if (primaryRows === null && backfillRows === null) continue;
      next[type] = build(
        type,
        primaryRows ?? parseSource(readCachedCsv(primary), primary),
        backfillRows ?? parseSource(readCachedCsv(backfill), backfill),
      );
      rebuilt = true;
    }
    if (rebuilt) indexes = next;
    else logger.info('Scheduled refresh found no changes. Keeping existing mappings.');
  } catch (error) {
    await clearSourceEtags();
    throw error;
  }
  await markUpdated();
}

function scheduleRefresh(): void {
  if (updateInterval) return;
  updateInterval = setInterval(async () => {
    logger.info(`Running scheduled update (every ${UPDATE_INTERVAL_HOURS} hours)...`);
    try {
      await refreshChangedMappings();
      logger.info('Scheduled update completed successfully.');
    } catch (error: any) {
      logger.error(`Scheduled update failed: ${error.message}`);
    }
  }, UPDATE_INTERVAL_HOURS * 60 * 60 * 1000);
  updateInterval.unref();
  logger.info(`Scheduled periodic updates every ${UPDATE_INTERVAL_HOURS} hours.`);
}

export async function initializeMappings(): Promise<void> {
  if (indexes) return;
  try {
    indexes = await loadAll();
    await markUpdated();
  } catch (error: any) {
    const message = error?.message || String(error);
    logger.error(`Initialization failed: ${message}`);
    await clearSourceEtags();
    throw new Error(`ID mappings failed to initialize: ${message}`);
  }
  scheduleRefresh();
  logger.info('Initialization complete');
}

function ensureInitialized(): void {
  if (!indexes) throw new Error('ID mappings not initialized. Ensure initializeMappings() is called at server startup.');
}

function indexFor(type: string): MappingIndex {
  ensureInitialized();
  return type === 'series' ? indexes.series : indexes.movie;
}

export function getByImdbId(imdbId: string, type: 'series' | 'movie' = 'series'): IdMap | undefined {
  return lookup(indexFor(type), 'imdbId', imdbId);
}

export function getByTmdbId(tmdbId: string, type: 'series' | 'movie' = 'series'): IdMap | undefined {
  return lookup(indexFor(type), 'tmdbId', tmdbId);
}

export function getByTvdbId(tvdbId: string, type: 'series' | 'movie' = 'series'): IdMap | undefined {
  return lookup(indexFor(type), 'tvdbId', tvdbId);
}

export const getSeriesByImdb = (imdbId: string) => getByImdbId(imdbId, 'series');
export const getSeriesByTmdb = (tmdbId: string) => getByTmdbId(tmdbId, 'series');
export const getSeriesByTvdb = (tvdbId: string) => getByTvdbId(tvdbId, 'series');
export const getMovieByImdb = (imdbId: string) => getByImdbId(imdbId, 'movie');
export const getMovieByTmdb = (tmdbId: string) => getByTmdbId(tmdbId, 'movie');
export const getMovieByTvdb = (tvdbId: string) => getByTvdbId(tvdbId, 'movie');

export function getSeriesByTvmaze(tvmazeId: string): IdMap | undefined {
  return lookup(indexFor('series'), 'tvmazeId', tvmazeId);
}

export const mappingsReady = (): boolean => indexes !== null;

export function getMappingStats() {
  ensureInitialized();
  const { series, movie } = indexes;
  return {
    series: { imdb: series.byId.imdbId.ids.length, tvdb: series.byId.tvdbId.ids.length, tmdb: series.byId.tmdbId.ids.length, tvmaze: series.byId.tvmazeId.ids.length },
    movies: { imdb: movie.byId.imdbId.ids.length, tvdb: movie.byId.tvdbId.ids.length, tmdb: movie.byId.tmdbId.ids.length },
  };
}

export function getIdMappingsStats() {
  const all: IndexStats[] = indexes ? [indexes.series.stats, indexes.movie.stats] : [];
  const sum = (pick: (stats: IndexStats) => number) => all.reduce((total, stats) => total + pick(stats), 0);
  const seriesCount = indexes ? indexes.series.stats.totalRows : 0;
  const moviesCount = indexes ? indexes.movie.stats.totalRows : 0;
  return {
    seriesCount,
    moviesCount,
    totalCount: seriesCount + moviesCount,
    dinsCount: sum((stats) => stats.primaryRows),
    backfilledCount: sum((stats) => stats.backfilledRows),
    filledFields: sum(({ filled }) => filled.imdbId + filled.tmdbId + filled.tvdbId + filled.tvmazeId),
    conflictsSkipped: sum((stats) => stats.conflicts),
    initialized: indexes !== null,
    updateIntervalHours: UPDATE_INTERVAL_HOURS,
  };
}

export async function forceUpdateIdMappings(): Promise<{ success: boolean; message: string; seriesCount: number; moviesCount: number }> {
  logger.info('Force update requested...');
  await clearSourceEtags();

  try {
    indexes = await loadAll();
    await markUpdated();
    scheduleRefresh();
    const { seriesCount, moviesCount } = getIdMappingsStats();
    logger.info(`Force update completed: ${seriesCount} series, ${moviesCount} movies`);
    return {
      success: true,
      message: `Updated successfully (${seriesCount.toLocaleString()} series, ${moviesCount.toLocaleString()} movies)`,
      seriesCount,
      moviesCount,
    };
  } catch (error: any) {
    logger.error(`Force update failed: ${error.message}`);
    await clearSourceEtags();
    const { seriesCount, moviesCount } = getIdMappingsStats();
    return { success: false, message: `Force update failed: ${error.message}`, seriesCount, moviesCount };
  }
}

export const mappings = {
  getByTvdbId,
  getByTmdbId,
  getByImdbId,
  getSeriesByImdb,
  getMovieByImdb,
  getSeriesByTmdb,
  getMovieByTmdb,
  getSeriesByTvdb,
  getMovieByTvdb,
  getSeriesByTvmaze,
  getStats: getMappingStats,
};

module.exports = {
  mappingsReady,
  mappings,
  initializeMappings,
  refreshChangedMappings,
  getSeriesByImdb,
  getMovieByImdb,
  getSeriesByTmdb,
  getMovieByTmdb,
  getSeriesByTvdb,
  getMovieByTvdb,
  getSeriesByTvmaze,
  getByTvdbId,
  getByTmdbId,
  getByImdbId,
  getMappingStats,
  forceUpdateIdMappings,
  getIdMappingsStats,
};
