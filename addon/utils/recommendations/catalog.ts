import consola from 'consola';
import { getTasteProfile } from './profile';
import { recommend, type RecommendKind } from './rank';

const logger = consola.withTag('Recommendations');

export const RECOMMENDATION_PREFIX = 'recommendations.';

/**
 * Catalog ids this feature serves, split by kind. A mixed row is deliberately not
 * offered: TMDB has no anime type, so the model is the only thing separating anime
 * from live-action series, and asking for both in one pass returns the same title
 * twice (Attack on Titan and Death Note both landed in series *and* anime).
 */
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

/**
 * A recommendation is only useful if it can be opened, so each pick is emitted
 * against its TMDB id. The reason the model gave is kept in the description,
 * ahead of the synopsis, because it is the part that explains the row.
 */
/**
 * Turns picks into metas the same way every other catalog does.
 *
 * A pick is only a TMDB id and a sentence; everything a row actually shows —
 * the art the user chose, rating posters, age filtering, id mapping — lives in
 * getMeta. Building metas by hand from the search hit skipped all of it, so
 * these rows looked unlike every other row in the addon.
 */
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

    // The whole selection is generated at once, but clients page through it at
    // the manifest's page size. Serving only the first page silently discarded
    // most of what was generated.
    const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE || '20', 10);
    const start = Math.max(0, (page - 1) * pageSize);
    const slice = picks.slice(start, start + pageSize);

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
};

/**
 * Builds the profile and the picks for whichever recommendation catalogs the
 * saved configuration carries, off the request path.
 *
 * Generation is around a minute and a half of a large model writing, so the
 * first person to open the row would otherwise wait it out or see it empty. A
 * save is the natural moment to pay that: it is already asynchronous from the
 * user's point of view, and it is exactly when the inputs changed.
 */
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
