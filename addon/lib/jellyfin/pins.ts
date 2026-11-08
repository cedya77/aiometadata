import bcrypt from 'bcrypt';
import { LRUCache } from 'lru-cache';
import redis from '../redisClient';
import { envInt } from '../../utils/envNumber';

export const PIN_PATTERN = /^\d{4,12}$/;
const HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

export function isPinHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

/** `password/PIN` as one field; the whole value is tried first, so a password holding a slash still works. */
export function splitSecret(secret: string): Array<{ password: string; pin: string }> {
  const out = [{ password: secret, pin: '' }];
  const slash = secret.lastIndexOf('/');
  if (slash > 0) out.push({ password: secret.slice(0, slash), pin: secret.slice(slash + 1) });
  return out;
}

const local = new LRUCache<string, { count: number; until: number }>({ max: 10000 });

function lockoutMs(): number {
  return envInt('JELLYFIN_PIN_LOCKOUT', 900, 1) * 1000;
}

export async function takeAttempt(key: string, limit = envInt('JELLYFIN_PIN_ATTEMPTS', 5, 1), windowMs = lockoutMs()): Promise<boolean> {
  if (redis) {
    const count = await redis.incr(`jellyfin:pin:${key}`).catch(() => null);
    if (count !== null) {
      if (count === 1) await redis.pexpire(`jellyfin:pin:${key}`, windowMs).catch(() => undefined);
      return count <= limit;
    }
  }
  const now = Date.now();
  const held = local.get(key);
  const entry = held && held.until > now ? held : { count: 0, until: now + windowMs };
  entry.count += 1;
  local.set(key, entry);
  return entry.count <= limit;
}

/** How many attempts a key holds, without adding one. */
export async function attemptsHeld(key: string): Promise<number> {
  if (redis) {
    const count = await redis.get(`jellyfin:pin:${key}`).catch(() => null);
    if (count !== null) return Number(count) || 0;
  }
  const held = local.get(key);
  return held && held.until > Date.now() ? held.count : 0;
}

export async function resetAttempts(key: string): Promise<void> {
  local.delete(key);
  if (redis) await redis.del(`jellyfin:pin:${key}`).catch(() => undefined);
}

/** Past the attempt limit even the right PIN is refused until the lockout ends. */
export async function pinOpens(userUUID: string, profile: { id: string | null; pin?: string }, pin: string): Promise<boolean> {
  if (!profile.pin) return true;
  if (!pin) return false;
  const key = `${userUUID}:${profile.id ?? ''}`;
  if (!(await takeAttempt(key))) return false;
  if (PIN_PATTERN.test(pin) && (await bcrypt.compare(pin, profile.pin))) {
    await resetAttempts(key);
    return true;
  }
  return false;
}

/** The PIN as it should be stored: the old hash when the same PIN comes back, else a new one; null for none. */
async function securePin(value: unknown, old: string | undefined): Promise<string | null> {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (PIN_PATTERN.test(raw)) return old && (await bcrypt.compare(raw, old)) ? old : bcrypt.hash(raw, 10);
  return isPinHash(raw) ? raw : null;
}

/**
 * Hashes each user's PIN in place before a save, the main user's included. Returns
 * the users whose PIN was set or changed, null standing for the main user.
 */
export async function securePins(config: any, previous: any): Promise<Array<string | null>> {
  const before = new Map<string, string>();
  for (const user of Array.isArray(previous?.jellyfinUsers) ? previous.jellyfinUsers : []) {
    if (typeof user?.id === 'string' && isPinHash(user.pin)) before.set(user.id, user.pin);
  }
  const changed: Array<string | null> = [];
  for (const user of Array.isArray(config?.jellyfinUsers) ? config.jellyfinUsers : []) {
    if (!user || typeof user.id !== 'string') continue;
    const old = before.get(user.id);
    const pin = await securePin(user.pin, old);
    if (pin) user.pin = pin;
    else delete user.pin;
    if (pin && pin !== old) changed.push(user.id);
  }
  if (config && 'jellyfinUserPin' in config) {
    const old = isPinHash(previous?.jellyfinUserPin) ? previous.jellyfinUserPin : undefined;
    const pin = await securePin(config.jellyfinUserPin, old);
    if (pin) config.jellyfinUserPin = pin;
    else delete config.jellyfinUserPin;
    if (pin && pin !== old) changed.push(null);
  }
  return changed;
}
