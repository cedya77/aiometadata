import crypto from 'crypto';
import consola from 'consola';
import { LRUCache } from 'lru-cache';
import redis from '../redisClient';
import { envInt } from '../../utils/envNumber';

const logger = consola.withTag('JellyfinAuth');

const PREFIX = 'jellyfin:qc:';

export interface QuickConnectRequest {
  userUUID: string;
  secret: string;
  code: string;
  deviceId: string;
  deviceName: string;
  appName: string;
  appVersion: string;
  dateAdded: string;
  authenticated: boolean;
  /** The user the device signs in as, chosen by whoever approved it. */
  profileId: string | null;
}

function ttlSeconds(): number {
  return envInt('JELLYFIN_QUICK_CONNECT_TTL', 10 * 60, 60);
}

const memory = new LRUCache<string, string>({
  max: envInt('JELLYFIN_QUICK_CONNECT_MEMORY_MAX', 2000, 1),
  ttl: ttlSeconds() * 1000,
});

async function put(key: string, value: string): Promise<void> {
  if (redis) {
    try {
      await redis.set(`${PREFIX}${key}`, value, 'EX', ttlSeconds());
      return;
    } catch (error: any) {
      logger.debug(`Quick connect write failed, falling back to memory: ${error.message}`);
    }
  }
  memory.set(key, value);
}

async function get(key: string): Promise<string | null> {
  if (redis) {
    try {
      return await redis.get(`${PREFIX}${key}`);
    } catch (error: any) {
      logger.debug(`Quick connect read failed: ${error.message}`);
      return null;
    }
  }
  return memory.get(key) ?? null;
}

async function drop(key: string): Promise<void> {
  if (redis) {
    try {
      await redis.del(`${PREFIX}${key}`);
      return;
    } catch (error: any) {
      logger.debug(`Quick connect delete failed: ${error.message}`);
    }
  }
  memory.delete(key);
}

const secretKey = (secret: string) => `secret:${secret}`;
const codeKey = (userUUID: string, code: string) => `code:${userUUID}:${code}`;

async function save(request: QuickConnectRequest): Promise<void> {
  await put(secretKey(request.secret), JSON.stringify(request));
  await put(codeKey(request.userUUID, request.code), request.secret);
}

export function normaliseCode(input: unknown): string {
  return String(input ?? '').replace(/\D/g, '');
}

export async function initiateQuickConnect(
  userUUID: string,
  client: { client: string; device: string; deviceId: string; version: string }
): Promise<QuickConnectRequest> {
  let code = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (!(await get(codeKey(userUUID, candidate)))) {
      code = candidate;
      break;
    }
  }
  if (!code) throw new Error('Could not allocate a quick connect code');

  const request: QuickConnectRequest = {
    userUUID,
    secret: crypto.randomBytes(32).toString('hex'),
    code,
    deviceId: client.deviceId,
    deviceName: client.device,
    appName: client.client,
    appVersion: client.version,
    dateAdded: new Date().toISOString(),
    authenticated: false,
    profileId: null,
  };
  await save(request);
  return request;
}

export async function readQuickConnect(userUUID: string, secret: string | undefined): Promise<QuickConnectRequest | null> {
  if (!secret) return null;
  const raw = await get(secretKey(secret));
  if (!raw) return null;

  try {
    const request = JSON.parse(raw) as QuickConnectRequest;
    return request.userUUID === userUUID ? request : null;
  } catch {
    return null;
  }
}

export async function authorizeQuickConnect(userUUID: string, code: string, profileId: string | null = null): Promise<QuickConnectRequest | null> {
  const clean = normaliseCode(code);
  if (clean.length !== 6) return null;

  const secret = await get(codeKey(userUUID, clean));
  if (!secret) return null;

  const request = await readQuickConnect(userUUID, secret);
  if (!request) return null;

  request.authenticated = true;
  request.profileId = profileId;
  await save(request);
  return request;
}

/** Consumes an approved request; the secret only signs in once. */
export async function claimQuickConnect(userUUID: string, secret: string | undefined): Promise<QuickConnectRequest | null> {
  const request = await readQuickConnect(userUUID, secret);
  if (!request?.authenticated) return null;

  await drop(secretKey(request.secret));
  await drop(codeKey(userUUID, request.code));
  return request;
}

export function quickConnectResult(request: QuickConnectRequest): any {
  return {
    Authenticated: request.authenticated,
    Secret: request.secret,
    Code: request.code,
    DeviceId: request.deviceId,
    DeviceName: request.deviceName,
    AppName: request.appName,
    AppVersion: request.appVersion,
    DateAdded: request.dateAdded,
  };
}
