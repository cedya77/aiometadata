const crypto: any = require('crypto');
const { stableStringify }: any = require('./getCache');

/**
 * Signature over the discover params as stored, so it moves when the filters are
 * edited.
 *
 * Date tokens are left unresolved on purpose: resolving first folds the current
 * date into the key, orphaning warmed entries at the user's local midnight.
 * Expiry belongs to the catalog TTL and the warm window clamp.
 */

const DISCOVER_CATALOG_PREFIXES = [
  'tmdb.discover.',
  'tvdb.discover.',
  'simkl.discover.',
  'anilist.discover.',
  'mal.discover.',
];

function isDiscoverCatalogId(catalogId: string): boolean {
  if (typeof catalogId !== 'string') return false;
  return DISCOVER_CATALOG_PREFIXES.some(prefix => catalogId.startsWith(prefix));
}

function getDiscoverParams(catalogConfig: any): any {
  return catalogConfig?.metadata?.discover?.params
    || catalogConfig?.metadata?.discoverParams
    || null;
}

function computeDiscoverSignature(catalogConfig: any): string | null {
  const params = getDiscoverParams(catalogConfig);
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;

  return crypto
    .createHash('md5')
    .update(stableStringify(params))
    .digest('hex')
    .substring(0, 8);
}

function applyDiscoverSignature(extraArgs: any, catalogConfig: any): void {
  // Discover providers treat "None" (case-insensitively) as no genre filter.
  // Normalize here so the route, comprehensive warmer and merged sources share
  // the same cache entry when a client omits the manifest's "None" option.
  if (extraArgs.genre == null || extraArgs.genre === '' ||
      (typeof extraArgs.genre === 'string' && extraArgs.genre.toLowerCase() === 'none')) {
    delete extraArgs.genre;
  }

  const signature = computeDiscoverSignature(catalogConfig);
  if (signature) extraArgs.discoverSig = signature;
}

export {
  isDiscoverCatalogId,
  getDiscoverParams,
  computeDiscoverSignature,
  applyDiscoverSignature,
};
module.exports = {
  isDiscoverCatalogId,
  getDiscoverParams,
  computeDiscoverSignature,
  applyDiscoverSignature,
};
