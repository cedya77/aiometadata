import consola from 'consola';
import { readTokenSession, revokeToken } from './tokens';
import { listProfiles, profileKey, scopeConfigToProfile } from './profiles';
import { normaliseJellyfinId } from './idsCodec';
import { LRUCache } from 'lru-cache';
import { noteAccountOwner, noteMarksUnaired, noteProfile, runInViewerScope, viewerOwnsWatchlist } from './viewer';
import { accountOwner } from '../accounts';

const redis: any = require('../redisClient');
const { envInt } = require('../../utils/envNumber');

const seenRecently = new LRUCache<string, true>({ max: 10000, ttl: 60 * 60 * 1000 });

// One hash rather than a key each: reading these back was a keyspace scan,
// whose cost is every key on the server and not the few hundred that match.
const SEEN_KEY = 'jf:seen';

// A configuration a client signed in to recently; background work is spent on those alone.
function markSeen(userUUID: string): void {
  if (!redis || seenRecently.has(userUUID)) return;
  seenRecently.set(userUUID, true);
  const ttl = envInt('JELLYFIN_ACTIVE_DAYS', 7, 1) * 24 * 60 * 60;
  redis.multi()
    .hsetex(SEEN_KEY, 'EX', ttl, 'FIELDS', 1, userUUID, String(Date.now()))
    .expire(SEEN_KEY, ttl, 'NX')
    .expire(SEEN_KEY, ttl, 'GT')
    .exec()
    .catch(() => undefined);
}

/** Every configuration a client signed in to within the active window. */
export async function seenConfigurations(): Promise<string[] | null> {
  if (!redis) return null;
  try {
    return await redis.hkeys(SEEN_KEY);
  } catch {
    return [];
  }
}

/**
 * The configurations a client signed in to since a time, to the hour a sign-in is
 * noted at. One noted before the time was kept holds no time, and counts.
 */
export async function seenConfigurationsSince(since: number): Promise<string[] | null> {
  if (!redis) return null;
  try {
    const all: Record<string, string> = await redis.hgetall(SEEN_KEY);
    return Object.entries(all)
      .filter(([, at]) => {
        const time = Number(at);
        return !Number.isFinite(time) || time < 1e12 || time >= since;
      })
      .map(([uuid]) => uuid);
  } catch {
    return [];
  }
}

export async function forgetSeen(userUUIDs: string[]): Promise<void> {
  for (const userUUID of userUUIDs) seenRecently.delete(userUUID);
  if (!redis) return;
  for (let at = 0; at < userUUIDs.length; at += 500) {
    await redis.hdel(SEEN_KEY, ...userUUIDs.slice(at, at + 500)).catch(() => undefined);
  }
}

export async function seenRecentlyBy(userUUID: string): Promise<boolean> {
  if (seenRecently.has(userUUID)) return true;
  if (!redis) return false;
  try {
    return (await redis.hexists(SEEN_KEY, userUUID)) === 1;
  } catch {
    return false;
  }
}

const logger = consola.withTag('JellyfinAuth');

/**
 * `MediaBrowser Client="Odin", Token="abc"` and the Emby-prefixed spelling of
 * the same header both appear in the wild, alongside three plainer places a
 * client may put the token.
 */
export function parseMediaBrowserHeader(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const body = value.replace(/^(MediaBrowser|Emby)\s+/i, '');
  const out: Record<string, string> = {};
  for (const part of body.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const raw = part.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

export function extractToken(req: any): string | undefined {
  const header = parseMediaBrowserHeader(
    req.get('authorization') || req.get('x-emby-authorization')
  );
  return (
    header.token ||
    req.get('x-emby-token') ||
    req.get('x-mediabrowser-token') ||
    (typeof req.query?.api_key === 'string' ? req.query.api_key : undefined) ||
    (typeof req.query?.ApiKey === 'string' ? req.query.ApiKey : undefined) ||
    undefined
  );
}

// Pelagica shows a watchlist beside favourites, through the like a title carries. Other
// clients have favourites alone, so the watchlist is what they are shown as favourites.
const OWN_WATCHLIST_CLIENT = /^pelagica\b/i;

const EXTENSION_CLIENT = /^(aiostreams|pelagica)\b/i;

export function runWithClient<T>(req: any, fn: () => T): T {
  const { client } = clientInfo(req);
  return runInViewerScope(OWN_WATCHLIST_CLIENT.test(client), fn, EXTENSION_CLIENT.test(client));
}

/** Whether the client asking keeps a watchlist apart from favourites. */
export function clientHasOwnWatchlist(): boolean {
  return viewerOwnsWatchlist();
}

export function clientInfo(req: any): { client: string; device: string; deviceId: string; version: string } {
  const header = parseMediaBrowserHeader(
    req.get('authorization') || req.get('x-emby-authorization')
  );
  return {
    client: header.client || 'Unknown',
    device: header.device || 'Unknown',
    deviceId: header.deviceid || 'unknown',
    version: header.version || '0.0.0',
  };
}

export function serverIdFor(userUUID: string): string {
  return normaliseJellyfinId(userUUID);
}

/** A sign-in as a user since removed from the configuration no longer opens anything. */
async function profileExists(userUUID: string, profileId: string): Promise<boolean> {
  let stored: any;
  try {
    stored = await require('../configApi').loadSharedConfig(userUUID);
  } catch (error: any) {
    if (error?.code === 'CONFIG_NOT_FOUND') return false;
    throw error;
  }
  return Boolean(stored) && listProfiles(stored, userUUID).some((profile) => profile.id === profileId);
}

export async function attachJellyfinContext(req: any, _res: any, next: any): Promise<void> {
  const userUUID = req.params?.userUUID;
  req.jellyfin = { userUUID, token: extractToken(req), authenticated: false, config: null, profileId: null };

  if (!userUUID) {
    next();
    return;
  }

  const token = req.jellyfin.token;
  if (!token) {
    next();
    return;
  }

  try {
    const session = await readTokenSession(token);
    if (session && session.userUUID === userUUID && session.profileId && !(await profileExists(userUUID, session.profileId))) {
      revokeToken(token).catch((error: any) => logger.debug(`Revoking a removed user's sign-in failed: ${error.message}`));
    } else if (session && session.userUUID === userUUID) {
      req.jellyfin.authenticated = true;
      req.jellyfin.profileId = session.profileId;
      markSeen(userUUID);
    }
  } catch (error: any) {
    logger.warn(`Token resolution failed: ${error.message}`);
    req.jellyfin.authUnavailable = true;
  }

  next();
}

/** The configuration as the signed-in profile sees it. */
export async function loadConfig(req: any): Promise<any> {
  if (req.jellyfin?.config) return req.jellyfin.config;
  let stored: any;
  try {
    stored = await require('../configApi').loadSharedConfig(req.jellyfin.userUUID);
  } catch (error: any) {
    if (error?.code === 'CONFIG_NOT_FOUND') return null;
    throw error;
  }
  if (!stored) return null;

  // The cached copy is every reader's, so a request changes only its own top level.
  require('./items').noteArtScope(serverIdFor(req.jellyfin.userUUID), stored);
  const config = scopeConfigToProfile({ ...stored }, req.jellyfin.userUUID, req.jellyfin.profileId ?? null);
  config.userUUID = req.jellyfin.userUUID;
  req.jellyfin.config = config;
  noteAccountOwner(accountOwner(config));
  noteProfile(profileKey(config));
  noteMarksUnaired(config.jellyfinMarkUnaired !== false);
  return config;
}

// Artwork is anonymous in Jellyfin, because a client renders it with a plain
// image tag that cannot carry a token. Requiring one leaves every poster blank
// in the clients that do not put the key in the query.
const ANONYMOUS_PATH = /\/(?:(?:Items|Users)\/[^/]+\/Images\/|UserImage$)/i;

export function requireAuth(req: any, res: any, next: any): void {
  if (req.jellyfin?.authenticated || ANONYMOUS_PATH.test(String(req.path || ''))) {
    next();
    return;
  }
  // A 401 makes a client drop its sign-in, which a store it could not reach is no reason for.
  if (req.jellyfin?.authUnavailable) {
    res.status(503).json({ Message: 'Service Unavailable' });
    return;
  }
  res.status(401).json({ Message: 'Unauthorized' });
}
