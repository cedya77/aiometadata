import { looksLikeAlias } from './userAliases.js';

const ALIAS_PATH_PREFIXES = new Set([
  'stremio',
  'jellyfin',
  'api/jellyfin',
  'api/config/load',
  'api/config/update',
  'api/config/is-trusted',
  'api/config/delete-user',
  'api/config/clear-cache',
  'api/movielens/sync',
  'api/movielens/lists',
  'api/cache/invalidate-user',
  'api/admin/users',
  'api/profiles',
]);

const MAX_PREFIX_SEGMENTS = 3;

type Resolve = (aliasLower: string) => string | null;

interface Rewrite {
  pathname: string;
  alias: string;
}

function rewritePathname(pathname: string, resolve: Resolve): Rewrite | null {
  const segments = pathname.split('/');

  for (let depth = 1; depth <= MAX_PREFIX_SEGMENTS; depth++) {
    const aliasIndex = depth + 1;
    if (segments.length <= aliasIndex) break;

    const prefix = segments.slice(1, aliasIndex).join('/');
    if (!ALIAS_PATH_PREFIXES.has(prefix)) continue;

    const candidate = segments[aliasIndex];
    if (!looksLikeAlias(candidate)) return null;

    const userUUID = resolve(candidate.toLowerCase());
    if (!userUUID) return null;

    segments[aliasIndex] = userUUID;
    return { pathname: segments.join('/'), alias: candidate };
  }

  return null;
}

export function createAliasResolutionMiddleware({
  resolve,
  isEnabled,
}: {
  resolve: Resolve;
  isEnabled: () => boolean;
}) {
  return function aliasResolutionMiddleware(req: any, _res: any, next: () => void): void {
    if (!isEnabled()) return next();

    try {
      const rawUrl = typeof req.url === 'string' ? req.url : '';
      const queryStart = rawUrl.indexOf('?');
      const pathname = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
      const search = queryStart === -1 ? '' : rawUrl.slice(queryStart + 1);

      const rewritten = rewritePathname(pathname, resolve);
      const nextPathname = rewritten === null ? null : rewritten.pathname;
      if (rewritten) req.addonIdentifier = rewritten.alias;

      let nextSearch = search;
      if (search) {
        const params = new URLSearchParams(search);
        const queryAlias = params.get('userUUID');
        if (queryAlias && looksLikeAlias(queryAlias)) {
          const userUUID = resolve(queryAlias.toLowerCase());
          if (userUUID) {
            nextSearch = search.replace(/(^|&)userUUID=[^&]*/, `$1userUUID=${userUUID}`);
          }
        }
      }

      if (nextPathname !== null || nextSearch !== search) {
        const finalPathname = nextPathname === null ? pathname : nextPathname;
        req.url = nextSearch ? `${finalPathname}?${nextSearch}` : finalPathname;
      }

      const body = req.body;
      if (body && typeof body === 'object' && typeof body.userUUID === 'string' && looksLikeAlias(body.userUUID)) {
        const userUUID = resolve(body.userUUID.toLowerCase());
        if (userUUID) body.userUUID = userUUID;
      }
    } catch {
      // Alias resolution is best-effort: never fail a request because of it.
    }

    next();
  };
}

module.exports = { createAliasResolutionMiddleware };
