import consola from 'consola';
import { getTasteProfile } from './profile';
import { recommend, type RecommendKind } from './rank';

const logger = consola.withTag('Recommendations');

export const RECOMMENDATION_PREFIX = 'recommendations.';

/** One row per kind. A mixed row returns the same title twice, since only the
 *  model separates anime from live action. */
export const RECOMMENDATION_CATALOGS: Array<{ id: string; kind: RecommendKind; type: string; name: string }> = [
  { id: 'recommendations.movies', kind: 'movie', type: 'movie', name: 'Films For You' },
  { id: 'recommendations.series', kind: 'series', type: 'series', name: 'Series For You' },
  { id: 'recommendations.anime', kind: 'anime', type: 'anime', name: 'Anime For You' },
];

export function isRecommendationCatalog(id: string): boolean {
  return typeof id === 'string' && id.startsWith(RECOMMENDATION_PREFIX);
}

function kindFor(id: string): RecommendKind {
  const match = RECOMMENDATION_CATALOGS.find(entry => entry.id === id);
  return match ? match.kind : 'movie';
}


/** Through getMeta, so a row gets the art, filtering and id mapping every other
 *  row gets. The model's reason leads the description. */
async function hydrate(picks: any[], config: any, userUUID: string): Promise<any[]> {
  const { getMeta }: any = require('../../lib/getMeta');
  const language = config?.language || 'en-US';

  // Bounded: a page is twenty titles and each one fans out to its providers.
  const limit = parseInt(process.env.RECOMMENDATION_HYDRATE_CONCURRENCY || '6', 10);
  const out: any[] = new Array(picks.length).fill(null);
  let cursor = 0;

  const worker = async () => {
    while (cursor < picks.length) {
      const index = cursor;
      cursor += 1;
      const pick = picks[index];
      const type = pick.kind === 'series' ? 'series' : 'movie';
      try {
        const result = await getMeta(type, language, `tmdb:${pick.tmdbId}`, config, userUUID, false);
        const meta = result?.meta;
        if (!meta) continue;
        out[index] = {
          ...meta,
          // The model's line is why this title is here, which the synopsis cannot say.
          description: pick.reason
            ? `${pick.reason}\n\n${meta.description || ''}`.trim()
            : meta.description,
        };
      } catch (error: any) {
        logger.debug(`Could not hydrate tmdb:${pick.tmdbId}: ${error.message}`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, picks.length) }, worker));
  return out.filter(Boolean);
}

/** Sorts the whole selection before it is paged, so it reads counts carried on
 *  the picks: hydration only ever sees the page. */
export function arrange(picks: any[], config: any, catalogId?: string): any[] {
  const { pickOrder, voteFloor }: any = require('./provider');
  const order = pickOrder(config, catalogId);
  const floor = voteFloor(config, catalogId);

  // An unknown count is not evidence of obscurity, so it is left alone.
  const kept = floor > 0
    ? picks.filter(pick => !Number.isFinite(pick?.votes) || pick.votes >= floor)
    : picks.slice();

  if (order === 'suggested') return kept;

  const votes = (pick: any) => (Number.isFinite(pick?.votes) ? pick.votes : 0);
  const score = (pick: any) => (Number.isFinite(pick?.score) ? pick.score : 0);

  if (order === 'popular') return kept.sort((a, b) => votes(b) - votes(a));
  if (order === 'acclaimed') return kept.sort((a, b) => score(b) - score(a));

  // Weighted so a high score has to carry an audience to lead the row, which is
  // what stops a two hundred vote curiosity outranking everything.
  const counts = kept.map(votes).filter(Boolean).sort((a, b) => a - b);
  const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
  const mean = kept.length ? kept.reduce((sum, pick) => sum + score(pick), 0) / kept.length : 0;
  const weighted = (pick: any) => {
    const v = votes(pick);
    if (!v || !median) return score(pick);
    return (v / (v + median)) * score(pick) + (median / (v + median)) * mean;
  };
  return kept.sort((a, b) => weighted(b) - weighted(a));
}

export async function getRecommendationCatalog(
  type: string,
  id: string,
  page: number,
  config: any,
  userUUID: string
): Promise<any[]> {
  try {
    const profile = await getTasteProfile(config, userUUID);
    if (!profile) {
      logger.debug(`No taste profile for ${userUUID}, ${id} is empty`);
      return [];
    }

    // Waited on rather than raced against a deadline. AI search awaits its model
    // the same way: a row that answers empty while the work continues in the
    // background looks broken, and on a paged catalog it also makes pages
    // disagree, since each request races the clock separately.
    const picks = await recommend(config, userUUID, profile, kindFor(id));

    // Ordered here rather than when the row is written, so changing the setting
    // rearranges what already exists instead of paying a model to write it again.
    const ordered = arrange(picks, config, id);

    // The whole selection is generated at once, but clients page through it at
    // the manifest's page size. Serving only the first page silently discarded
    // most of what was generated.
    const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE || '20', 10);
    const start = Math.max(0, (page - 1) * pageSize);
    const slice = ordered.slice(start, start + pageSize);

    return hydrate(slice, config, userUUID);
  } catch (error: any) {
    logger.error(`Recommendation catalog ${id} failed: ${error.message}`);
    return [];
  }
}

module.exports = {
  RECOMMENDATION_PREFIX,
  RECOMMENDATION_CATALOGS,
  isRecommendationCatalog,
  getRecommendationCatalog,
  arrange,
};

/** Builds the saved configuration's rows off the request path, on save: it is
 *  already asynchronous, and it is when the inputs changed. */
export async function warmRecommendations(config: any, userUUID: string): Promise<void> {
  const wanted = (config?.catalogs || [])
    .filter((catalog: any) => catalog?.enabled && isRecommendationCatalog(catalog.id))
    .map((catalog: any) => catalog.id);

  if (!wanted.length) return;

  try {
    const { getTasteProfile }: any = require('./profile');
    const profile = await getTasteProfile(config, userUUID);
    if (!profile) {
      logger.debug(`Nothing to warm for ${userUUID}: no taste profile`);
      return;
    }

    const { recommend }: any = require('./rank');
    // Sequential on purpose: three concurrent generations against one key is a
    // good way to meet a rate limit, and nobody is waiting on this.
    for (const id of wanted) {
      try {
        const picks = await recommend(config, userUUID, profile, kindFor(id));
        logger.info(`Warmed ${id} for ${userUUID}: ${picks.length} picks`);
      } catch (error: any) {
        logger.warn(`Could not warm ${id} for ${userUUID}: ${error.message}`);
      }
    }
  } catch (error: any) {
    logger.warn(`Recommendation warm failed for ${userUUID}: ${error.message}`);
  }
}

module.exports.warmRecommendations = warmRecommendations;
