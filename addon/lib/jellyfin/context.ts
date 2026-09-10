import consola from 'consola';
import { readToken } from './tokens';
import { normaliseJellyfinId } from './idsCodec';

const database: any = require('../database');

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
    const raw = part.slice(eq + 1).trim();
    out[key] = raw.replace(/^"(.*)"$/, '$1');
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

export async function attachJellyfinContext(req: any, _res: any, next: any): Promise<void> {
  const userUUID = req.params?.userUUID;
  req.jellyfin = { userUUID, token: extractToken(req), authenticated: false, config: null };

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
    const owner = await readToken(token);
    if (owner && owner === userUUID) {
      req.jellyfin.authenticated = true;
    }
  } catch (error: any) {
    logger.debug(`Token resolution failed: ${error.message}`);
  }

  next();
}

export async function loadConfig(req: any): Promise<any> {
  if (req.jellyfin?.config) return req.jellyfin.config;
  const config = await database.getUserConfig(req.jellyfin.userUUID);
  if (config) {
    config.userUUID = req.jellyfin.userUUID;
    req.jellyfin.config = config;
  }
  return config;
}

// Artwork is anonymous in Jellyfin, because a client renders it with a plain
// image tag that cannot carry a token. Requiring one leaves every poster blank
// in the clients that do not put the key in the query.
const ANONYMOUS_PATH = /\/Items\/[^/]+\/Images\//i;

export function requireAuth(req: any, res: any, next: any): void {
  if (req.jellyfin?.authenticated || ANONYMOUS_PATH.test(String(req.path || ''))) {
    next();
    return;
  }
  res.status(401).json({ Message: 'Unauthorized' });
}
