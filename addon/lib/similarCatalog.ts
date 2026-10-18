import consola from 'consola';
import { allowsUnrated, hasAgeRatingCap, passesAgeRating } from '../utils/ageRating';

// Titles like a given one, for apps that ask a catalog with a required `similar` extra:
// https://docs.aiostreams.viren070.me/reference/addon-protocol/similar/

const logger = consola.withTag('Similar');
const { getSetting }: any = require('./settingsService');

export const SIMILAR_CATALOG_ID = 'aiom.similar';
const ID_PREFIXES = ['mal:', 'kitsu:', 'anilist:', 'anidb:', 'tt', 'tmdb:', 'tvdb:', 'tvmaze:'];

export function similarCatalogs(config: any): any[] {
  if (config?.catalogModeOnly) return [];
  return (['movie', 'series'] as const).map((type) => ({
    id: SIMILAR_CATALOG_ID,
    type,
    name: 'More Like This',
    extra: [{ name: 'similar', isRequired: true }],
    showInHome: false,
    idPrefixes: ID_PREFIXES,
  }));
}

export async function similarCatalogMetas(userUUID: string, config: any, type: string, sourceId: string): Promise<any[]> {
  if (type !== 'movie' && type !== 'series') return [];
  const { similarTitles } = require('./jellyfin/people');
  const { previewMeta, titleCards } = require('./titleCards');
  const { projectMetaForCatalogCache } = require('./getCache');
  const source = await previewMeta(config, userUUID, type, sourceId).catch(() => null);
  if (!source) return [];

  const rows: any[] = await similarTitles(config, source, type).catch((error: any) => {
    logger.debug(`Similar titles failed for ${sourceId}: ${error?.message || error}`);
    return [];
  });
  const size = Number(getSetting('SIMILAR_CATALOG_SIZE')) || 20;
  const capped = hasAgeRatingCap(config);
  const unrated = allowsUnrated(config);
  const built = await titleCards(config, userUUID, capped ? rows : rows.slice(0, size));
  return built
    .filter((meta: any) => meta?.id && meta.id !== source.id)
    .filter((meta: any) => !capped || passesAgeRating(meta.app_extras?.certification || meta.certification || null, meta.type || type, String(config.ageRating), unrated))
    .slice(0, size)
    .map(projectMetaForCatalogCache);
}
