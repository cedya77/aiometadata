import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import consola from 'consola';
import { isDiscoverCatalogId, applyDiscoverSignature } from './discoverCatalogSignature';
import { defaultsToNoneGenre } from './genreNoneDefault';
import { envInt } from '../utils/envNumber';

const logger = consola.withTag('Catalog');

function todayIn(config: any): string {
  const tz = config?.timezone || process.env.TZ || 'UTC';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function applyCatalogKeyArgs(args: Record<string, any>, catalogId: string, catalogConfig: any, config: any): Record<string, any> {
  const { supportsMdblistScoreFilters } = require('../utils/mdbList');

  if (isDiscoverCatalogId(catalogId)) {
    applyDiscoverSignature(args, catalogConfig);
  } else if (catalogId.startsWith('trakt.') || catalogId.startsWith('anilist.') || catalogId.startsWith('streaming.') || catalogId.startsWith('tmdb.year') || catalogId.startsWith('tmdb.language')) {
    if (catalogConfig?.sort) args.sort = catalogConfig.sort;
    if (catalogConfig?.sortDirection) args.sortDirection = catalogConfig.sortDirection;
    if (catalogId.startsWith('tmdb.year') && typeof catalogConfig?.minVotes === 'number') args.minVotes = catalogConfig.minVotes;
  } else if (catalogId.startsWith('mdblist.')) {
    if (catalogConfig?.sort) args.sort = catalogConfig.sort;
    if (catalogConfig?.order) args.order = catalogConfig.order;
    if (supportsMdblistScoreFilters(catalogConfig)) {
      if (typeof catalogConfig.filter_score_min === 'number') args.filter_score_min = catalogConfig.filter_score_min;
      if (typeof catalogConfig.filter_score_max === 'number') args.filter_score_max = catalogConfig.filter_score_max;
    }
  } else if (catalogId.startsWith('mal.userlist.')) {
    if (catalogConfig?.sort) args.sort = catalogConfig.sort;
  } else if (catalogId.startsWith('movielens.')) {
    const ml: any = catalogConfig?.metadata || {};
    if (ml.sortBy) args.sort = ml.sortBy;
    if (ml.sortDirection) args.sortDirection = ml.sortDirection;
    if (ml.tags) args.tags = ml.tags;
    if (ml.minYear) args.minYear = ml.minYear;
    if (ml.maxYear) args.maxYear = ml.maxYear;
    if (ml.minPop) args.minPop = ml.minPop;
    if (ml.maxDaysAgo) args.maxDaysAgo = ml.maxDaysAgo;
    if (ml.maxFutureDays !== undefined) args.maxFutureDays = ml.maxFutureDays;
    if (ml.includeRated) args.includeRated = true;
  }

  if (catalogId === 'trakt.upnext' || catalogId === 'mdblist.upnext' || catalogId.startsWith('simkl.upnext')) {
    args.useShowPoster = typeof catalogConfig?.metadata?.useShowPosterForUpNext === 'boolean'
      ? catalogConfig.metadata.useShowPosterForUpNext
      : false;
  }
  if (catalogId === 'simkl.upnext') {
    args.includeAnime = catalogConfig?.metadata?.includeAnimeInUpNext !== false;
  }
  if ((catalogId === 'trakt.upnext' || catalogId.startsWith('simkl.upnext')) && catalogConfig?.metadata?.upNextSort === 'aired') {
    args.upNextSort = 'aired';
  }
  if (catalogId.startsWith('simkl.watchlist.') && ['added', 'released', 'released_asc'].includes(catalogConfig?.metadata?.watchlistSort)) {
    args.watchlistSort = catalogConfig.metadata.watchlistSort;
  }
  if (catalogId === 'mdblist.upnext' && catalogConfig?.metadata?.hideUnreleased !== undefined) {
    args.hideUnreleased = catalogConfig.metadata.hideUnreleased;
  }

  if (catalogId === 'trakt.calendar' || catalogId.startsWith('simkl.calendar')) {
    args.date = todayIn(config);
    args.days = typeof catalogConfig?.metadata?.airingSoonDays === 'number' ? catalogConfig.metadata.airingSoonDays : 1;
  }
  if (catalogId === 'tvmaze.schedule') {
    args.date = args.date || todayIn(config);
    args.genre = !args.genre || args.genre === 'None' ? '' : String(args.genre).toUpperCase();
  }

  return args;
}

export async function applyCatalogKeyStamps(args: Record<string, any>, catalogId: string, catalogConfig: any, config: any): Promise<Record<string, any>> {
  if (catalogId.startsWith('simkl.watchlist.') || catalogId.startsWith('simkl.upnext')) {
    try {
      const { getSimklToken, getSimklActivityFingerprint } = require('../utils/simklUtils');
      const tokenId = config.apiKeys?.simklTokenId;
      const token = tokenId ? await getSimklToken(tokenId) : null;
      if (token?.access_token) {
        // Up Next reads whichever buckets it renders, so its key has to move when
        // any of them does, not just when the shows bucket does.
        let pairs: string[][];
        if (catalogId === 'simkl.upnext.anime') {
          pairs = [['anime', 'watching']];
        } else if (catalogId === 'simkl.upnext') {
          pairs = args.includeAnime === false
            ? [['shows', 'watching']]
            : [['shows', 'watching'], ['anime', 'watching']];
        } else {
          const parts = catalogId.split('.');
          pairs = parts[2] === 'all'
            ? ['movies', 'shows', 'anime'].map(t => [t, parts[3]])
            : [[parts[2], parts[3]]];
        }
        const fps = await Promise.all(pairs.map(([t, s]) => getSimklActivityFingerprint(token.access_token, t, s, config)));
        const fp = fps.filter(Boolean).join('+');
        if (fp) args._simklAct = fp;
      }
    } catch (e: any) {
      logger.warn(`Simkl activity fingerprint failed for ${catalogId}: ${e.message}`);
    }
  }

  if (catalogId.startsWith('movielens.explore')) {
    try {
      const credId = config.apiKeys?.movieLensCredId;
      const explicitTags = String(catalogConfig?.metadata?.tags || '')
        .split(',').map((s: string) => s.trim()).filter(Boolean).join(',');
      if (credId && !explicitTags) {
        const { cacheWrapGlobal } = require('./getCache');
        const movielens = require('./movielens');
        const metaTtl = parseInt(
          process.env.MOVIELENS_USERMETA_TTL_SECONDS || process.env.MOVIELENS_GROUPTAGS_TTL_SECONDS || '43200', 10);
        const userMeta = await cacheWrapGlobal(`movielens-usermeta:${credId}`, async () => movielens.getUserMeta(credId), metaTtl);
        if (userMeta?.engineId === 'bard' && Array.isArray(userMeta.groupTags) && userMeta.groupTags.length) {
          args._mlTags = userMeta.groupTags.map((t: string) => t.trim()).filter(Boolean).join(',');
        }
      }
    } catch (e: any) {
      logger.warn(`MovieLens group tags failed for ${catalogId}: ${e.message}`);
    }
  }

  return args;
}

const manifestCatalogs = new LRUCache<string, Promise<any[]>>({
  max: envInt('CATALOG_MANIFEST_MEMO_MAX', 500, 1),
  ttl: envInt('CATALOG_MANIFEST_MEMO_TTL', 600, 30) * 1000,
});

function builtCatalogs(config: any, userUUID: string): Promise<any[]> {
  const shape = createHash('md5').update(JSON.stringify([config?.language, config?.catalogs ?? null])).digest('hex').slice(0, 12);
  const key = `${userUUID}:${shape}`;
  let built = manifestCatalogs.get(key);
  if (!built) {
    const { getManifest } = require('./getManifest');
    built = Promise.resolve(getManifest(config, { userUUID }))
      .then((manifest: any) => (Array.isArray(manifest?.catalogs) ? manifest.catalogs : []))
      .catch((e: any) => {
        manifestCatalogs.delete(key);
        logger.warn(`Manifest for ${userUUID} failed: ${e?.message || e}`);
        return [];
      });
    manifestCatalogs.set(key, built);
  }
  return built;
}

export async function hiddenCatalogGenre(config: any, userUUID: string, catalogId: string, catalogType: string): Promise<string | null> {
  const entry = config?.catalogs?.find((c: any) => c.id === catalogId && c.type === catalogType);
  if (!entry || entry.showInHome !== false) return null;
  const shownAs = entry.displayType || entry.type;
  const built = (await builtCatalogs(config, userUUID)).find((c: any) =>
    (c.id === catalogId || c.id === `${catalogId}_${entry.type}`) && c.type === shownAs);
  const genre = built?.extra?.find((e: any) => e?.name === 'genre' && e?.isRequired);
  if (Array.isArray(genre?.options) && genre.options.length > 0) return String(genre.options[0]);
  return defaultsToNoneGenre(catalogId) ? 'None' : null;
}
