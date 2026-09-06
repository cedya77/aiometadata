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

/**
 * Everything MDBList will say about a whole sample, in one request per type.
 *
 * It carries genres, per-season episode counts with their air dates, and how
 * the title is rated elsewhere, which is worth more here than it looks: a
 * library with a handful of personal scores has nothing else to say whether
 * what they watch is acclaimed or disposable.
 */
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

/**
 * Genres and the name behind each title, for the rows that reach the prompt.
 *
 * Neither source carries them: Simkl's history endpoint returns watch state and
 * a title stub at every `extended` value. Both do carry a TMDB id, so this is
 * one detail read per title rather than a search, and the answers are shared
 * between users and kept for a month.
 */
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

module.exports = { enrichRows };
