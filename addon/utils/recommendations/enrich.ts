import consola from 'consola';
import type { WatchedRow } from './history';

const logger = consola.withTag('Recommendations');

/** Genres and credits do not change, so this outlives the profile that reads it. */
const FACT_TTL = parseInt(process.env.RECOMMENDATION_FACT_TTL || String(30 * 24 * 60 * 60), 10);

const CONCURRENCY = parseInt(process.env.RECOMMENDATION_ENRICH_CONCURRENCY || '6', 10);

export interface Facts {
  genres?: string[];
  /**
   * Episodes that have actually aired, not everything announced. A viewer who
   * is current with a returning series has watched all of them, and counting
   * unaired episodes against them reads that as abandonment.
   */
  episodes?: number;
  /** Aggregate critical standing, 0-100. Not the viewer's own opinion. */
  score?: number;
  /** 'Ended', 'Returning Series' and the like, where the source says. */
  status?: string;
}

export type FactMap = Map<string, Facts>;

async function factsFor(row: WatchedRow, config: any): Promise<Facts | null> {
  if (!row.tmdbId) return null;

  // Anime covers both films and series, so the episode counter decides which
  // endpoint holds the record.
  const asSeries = row.kind === 'series'
    || (row.kind === 'anime' && (row.totalEpisodes || 0) > 1);

  const { cacheWrapGlobal }: any = require('../../lib/getCache');
  // Versioned so a field added here is not hidden behind a month of entries
  // written before it existed.
  const key = `recommendations:facts:v2:${asSeries ? 'tv' : 'movie'}:${row.tmdbId}`;

  return cacheWrapGlobal(key, async () => {
    const { movieInfo, tvInfo }: any = require('../../lib/getTmdb');
    const params = { id: row.tmdbId };
    const detail = asSeries ? await tvInfo(params, config) : await movieInfo(params, config);
    const genres = Array.isArray(detail?.genres)
      ? detail.genres.map((genre: any) => String(genre?.name || '')).filter(Boolean)
      : [];
    const episodes = Number(detail?.number_of_episodes);
    return {
      genres,
      episodes: Number.isFinite(episodes) && episodes > 0 ? episodes : undefined,
    };
  }, FACT_TTL, {
    // A bare {genres, author} is not a meta object, and the shared classifier
    // reads anything it does not recognise as empty.
    resultClassifier: (result: any) => (result && (result.genres?.length || result.episodes)
      ? { type: 'SUCCESS', ttl: null }
      : { type: 'EMPTY_RESULT', ttl: 60 * 60 }),
  });
}

function airedEpisodes(seasons: any[]): number | undefined {
  if (!Array.isArray(seasons)) return undefined;
  const now = Date.now();
  let total = 0;
  for (const season of seasons) {
    // Specials sit at season 0 and are not part of the run.
    if (Number(season?.season_number) === 0) continue;
    const aired = Date.parse(String(season?.air_date || ''));
    if (Number.isFinite(aired) && aired > now) continue;
    const count = Number(season?.episode_count);
    if (Number.isFinite(count)) total += count;
  }
  return total > 0 ? total : undefined;
}

/** Genres, per-season episode counts with air dates, and outside ratings, for a
 *  whole sample in one request per type. */
async function fromMdblist(rows: WatchedRow[], config: any): Promise<FactMap> {
  const facts: FactMap = new Map();
  const apiKey = config?.apiKeys?.mdblist;
  if (!apiKey) return facts;

  const { fetchMDBListBatchMediaInfo }: any = require('../mdbList');

  for (const mediaType of ['movie', 'show'] as const) {
    const group = rows.filter(row => row.tmdbId
      && (mediaType === 'movie' ? row.kind === 'movie' : row.kind !== 'movie'));
    if (!group.length) continue;

    try {
      const results = await fetchMDBListBatchMediaInfo(
        'tmdb', mediaType, group.map(row => String(row.tmdbId)), apiKey, ['genre'],
      );
      const byTmdb = new Map<number, any>();
      for (const item of results || []) {
        const id = Number(item?.ids?.tmdb ?? item?.id);
        if (Number.isFinite(id)) byTmdb.set(id, item);
      }

      for (const row of group) {
        const item = byTmdb.get(Number(row.tmdbId));
        if (!item) continue;
        const genres = Array.isArray(item.genres)
          ? item.genres.map((genre: any) => String(genre?.title || '')).filter(Boolean)
          : [];
        const score = Number(item.score);
        facts.set(row.key, {
          genres,
          episodes: mediaType === 'show' ? airedEpisodes(item.seasons) : undefined,
          score: Number.isFinite(score) && score > 0 ? score : undefined,
          status: item.status ? String(item.status) : undefined,
        });
      }
    } catch (error: any) {
      logger.debug(`MDBList batch for ${mediaType} failed, falling back to TMDB: ${error.message}`);
    }
  }

  return facts;
}

/** Audience size and score. The instance already holds IMDb's ratings file; one
 *  MDBList batch per type supplies the imdb ids to look them up by. */
export async function attachRatings(items: any[], config: any): Promise<void> {
  const withIds = items.filter(item => item?.tmdbId);
  if (!withIds.length) return;

  const apiKey = config?.apiKeys?.mdblist;
  if (!apiKey) return;

  const { fetchMDBListBatchMediaInfo }: any = require('../mdbList');
  const { getImdbRating }: any = require('../../lib/imdbRatings');

  for (const mediaType of ['movie', 'show'] as const) {
    const group = withIds.filter(item => (mediaType === 'movie' ? item.kind === 'movie' : item.kind !== 'movie'));
    if (!group.length) continue;

    try {
      const results = await fetchMDBListBatchMediaInfo(
        'tmdb', mediaType, group.map(item => String(item.tmdbId)), apiKey, [],
      );
      const imdbByTmdb = new Map<number, string>();
      for (const entry of results || []) {
        const tmdb = Number(entry?.ids?.tmdb ?? entry?.id);
        const imdb = entry?.ids?.imdb;
        if (Number.isFinite(tmdb) && typeof imdb === 'string' && imdb) imdbByTmdb.set(tmdb, imdb);
      }

      await Promise.all(group.map(async (item) => {
        const imdbId = imdbByTmdb.get(Number(item.tmdbId));
        if (!imdbId) return;
        item.imdbId = imdbId;
        const rating = await getImdbRating(imdbId).catch(() => null);
        if (!rating) return;
        item.votes = rating.votes;
        item.score = rating.rating;
        item.votesFrom = 'imdb';
      }));
    } catch (error: any) {
      logger.debug(`Could not read ratings for ${mediaType}s, keeping TMDB counts: ${error.message}`);
    }
  }

  const known = items.filter(item => item.votesFrom === 'imdb').length;
  logger.debug(`Ratings: ${known} of ${items.length} from IMDb, the rest from TMDB`);
}

/** Genres and credits for the rows that reach the prompt. Neither history source
 *  carries them, but both carry a TMDB id to read them by. */
export async function enrichRows(rows: WatchedRow[], config: any): Promise<FactMap> {
  const targets = rows.filter(row => row.tmdbId);
  if (!targets.length) return new Map();

  // Two requests answer the whole sample. TMDB is asked only about what the
  // batch had no record of, or about everything when there is no MDBList key.
  const facts = await fromMdblist(targets, config);
  const batched = facts.size;

  const missing = targets.filter(row => !facts.has(row.key));
  let cursor = 0;
  const worker = async () => {
    while (cursor < missing.length) {
      const row = missing[cursor];
      cursor += 1;
      try {
        const found = await factsFor(row, config);
        if (found) facts.set(row.key, found);
      } catch (error: any) {
        logger.debug(`No TMDB detail for "${row.title}": ${error.message}`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker));
  logger.debug(
    `Enriched ${facts.size} of ${rows.length} rows: ${batched} from MDBList in one request `
    + `per type, ${missing.length} looked up individually`,
  );
  return facts;
}

module.exports = { enrichRows, attachRatings };
