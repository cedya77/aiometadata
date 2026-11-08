import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { listProfiles } from './profiles';
import { attemptsHeld, pinOpens, resetAttempts, takeAttempt } from './pins';

// A configuration's own Jellyfin page: the dashboard's routes, reached with a session its password opened.

const database: any = require('../database');

export const OWN_PAGE_HEADER = 'x-own-page';

/**
 * What a route reaches once a session may use it:
 * - `profile`: one profile, named by `profile` in the query or body; none means all of them.
 * - `heldProfile`: one profile by `field` in the body, which a row names, so none means the main one.
 * - `accounts`: tracker accounts named by these fields, which must belong to a profile the session has open.
 * - `config`: the whole configuration, for a session with every profile open.
 * - `session`: only that the session is good.
 */
export type TurnLane = 'files' | 'trackers';

export type OwnPageAccess = (
  | { reach: 'profile'; accounts?: string[]; heavy?: boolean }
  | { reach: 'heldProfile'; field: string }
  | { reach: 'accounts'; accounts: string[]; heavy?: boolean }
  | { reach: 'config'; heavy?: boolean }
  | { reach: 'session'; heavy?: boolean }
) & { turn?: TurnLane };

interface OpenProfile {
  k: string;
  /** The PIN it was opened with, so changing the PIN closes it. */
  p: string;
}

interface SessionBody {
  u: string;
  o: OpenProfile[];
  e: number;
}

export interface OwnPageSession {
  userUUID: string;
  config: any;
  /** Profiles open to this session, and every profile being open. */
  open: Set<string>;
  full: boolean;
  held: OpenProfile[];
}

export const ownPagesOn = (): boolean => String(process.env.JELLYFIN_OWN_PAGES ?? '').toLowerCase() === 'true';

/** What the page says before anyone has signed in. */
export const ownPageStatus = (): { enabled: boolean; hours: number } => ({ enabled: ownPagesOn(), hours: sessionHours() });

const sessionHours = (): number => envInt('JELLYFIN_OWN_PAGE_HOURS', 24, 1);

// The password hash read for every request of a page, briefly held; changing the password ends its sessions within this.
const hashes = new LRUCache<string, { hash: string | null }>({ max: 5000, ttl: 30_000 });

async function passwordHashOf(userUUID: string): Promise<string | null> {
  const held = hashes.get(userUUID);
  if (held) return held.hash;
  const user = await database.getUser(userUUID).catch(() => null);
  const hash = user?.password_hash ? String(user.password_hash) : null;
  hashes.set(userUUID, { hash });
  return hash;
}

const b64 = (text: string): string => Buffer.from(text).toString('base64url');
const signed = (body: string, passwordHash: string): string => createHmac('sha256', `own-page\0${passwordHash}`).update(body).digest('base64url');
const pinMark = (pin?: string): string => (pin ? createHash('sha256').update(pin).digest('base64url').slice(0, 16) : '');
const keyOf = (profile: { id: string | null }): string => profile.id ?? '';

function mint(userUUID: string, held: OpenProfile[], passwordHash: string, expires?: number): string {
  const body = b64(JSON.stringify({ u: userUUID, o: held, e: expires ?? Date.now() + sessionHours() * 3_600_000 } satisfies SessionBody));
  return `${body}.${signed(body, passwordHash)}`;
}

/** The session a token holds, as things stand now; null once it no longer opens anything. */
export async function readSession(token: unknown, userUUID: string): Promise<OwnPageSession | null> {
  if (typeof token !== 'string' || !token.includes('.') || token.length > 4096) return null;
  const [body, mac] = token.split('.');
  const hash = await passwordHashOf(userUUID);
  if (!hash) return null;
  const want = Buffer.from(signed(body, hash));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let parsed: SessionBody;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }
  if (parsed.u !== userUUID || !(parsed.e > Date.now()) || !Array.isArray(parsed.o)) return null;
  const config = await database.getUserConfig(userUUID).catch(() => null);
  if (!config) return null;
  const profiles = listProfiles(config, userUUID);
  const open = new Set(profiles.filter((p) => !p.pin || parsed.o.some((o) => o.k === keyOf(p) && o.p === pinMark(p.pin))).map(keyOf));
  return { userUUID, config, open, full: open.size === profiles.length, held: parsed.o };
}

const limiters = new LRUCache<string, { count: number; until: number }>({ max: 20000 });

function allowed(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const held = limiters.get(key);
  const entry = held && held.until > now ? held : { count: 0, until: now + windowMs };
  entry.count += 1;
  limiters.set(key, entry);
  return entry.count <= limit;
}

/** A profile's own key, and the history it reads when it shares another's. */
function openKeys(session: OwnPageSession): Set<string> {
  const out = new Set(session.open);
  for (const profile of listProfiles(session.config, session.userUUID)) {
    if (session.open.has(keyOf(profile)) && profile.sharesHistory) out.add('');
  }
  return out;
}

function accountsOpen(session: OwnPageSession, keys: string[]): boolean {
  if (session.full) return true;
  const { accountsOpenTo } = require('./dashboard');
  const mine: Set<string> = accountsOpenTo(session.config, session.userUUID, session.open);
  return keys.every((key) => mine.has(key));
}

function refusal(access: OwnPageAccess, req: any, session: OwnPageSession): string | null {
  const body = req.body ?? {};
  const named = (fields: string[]) => fields.flatMap((field) => [req.query?.[field], body[field]]).filter((value): value is string => typeof value === 'string' && value !== '');
  if (access.reach === 'session') return null;
  if (access.reach === 'config') return session.full ? null : 'Every profile has to be open for this';
  if (access.reach === 'heldProfile') {
    const key = typeof body[access.field] === 'string' ? body[access.field] : '';
    return openKeys(session).has(key) ? null : 'That profile is locked';
  }
  if (access.reach === 'profile') {
    // A handler reads one or the other, so both have to pass.
    const values = [req.query?.profile, body.profile].filter((value): value is string => typeof value === 'string');
    if (values.length ? values.some((value) => !session.open.has(value)) : !session.full) return 'That profile is locked';
  }
  if ('accounts' in access && access.accounts && !accountsOpen(session, named(access.accounts))) return 'That account belongs to a locked profile';
  return null;
}

/** A dashboard route an own page may use: an administrator goes as before, and a session only as far as `access` lets it. */
interface TurnWaiter { enter: () => void }
const LANES: Record<TurnLane, { setting: string; size: number; busy: string; queue: TurnWaiter[]; open: number }> = {
  files: { setting: 'JELLYFIN_OWN_PAGE_FILES', size: 2, busy: 'The server is busy with other histories, try again in a minute', queue: [], open: 0 },
  trackers: { setting: 'JELLYFIN_OWN_PAGE_TRACKERS', size: 4, busy: 'The server is busy with other tracker reads, try again in a minute', queue: [], open: 0 },
};

function nextTurns(lane: typeof LANES[TurnLane]): void {
  while (lane.queue.length && lane.open < envInt(lane.setting, lane.size, 1)) lane.queue.shift()?.enter();
}

// Reading a whole history or tracker holds it in memory, so the server takes only so many at once.
function takeTurn(which: TurnLane, res: any): Promise<boolean> {
  const lane = LANES[which];
  return new Promise((resolve) => {
    const waiter: TurnWaiter = {
      enter: () => {
        clearTimeout(gaveUp);
        res.off('close', left);
        lane.open += 1;
        let held = true;
        const release = () => {
          if (!held) return;
          held = false;
          clearTimeout(limit);
          lane.open -= 1;
          nextTurns(lane);
        };
        const limit = setTimeout(release, envInt('JELLYFIN_OWN_PAGE_HOLD', 300, 1) * 1000);
        res.once('close', release);
        resolve(true);
      },
    };
    const leave = () => {
      const at = lane.queue.indexOf(waiter);
      if (at >= 0) lane.queue.splice(at, 1);
      res.off('close', left);
      resolve(false);
    };
    const left = () => {
      clearTimeout(gaveUp);
      leave();
    };
    const gaveUp = setTimeout(leave, envInt('JELLYFIN_OWN_PAGE_WAIT', 120, 1) * 1000);
    res.once('close', left);
    lane.queue.push(waiter);
    nextTurns(lane);
  });
}

const importsFull = (req: any): boolean => String(req.query?.apply) === '1'
  && require('./historyTransfer').runningImports() >= envInt('JELLYFIN_OWN_PAGE_IMPORTS', 3, 1);

const addressOf = (req: any): string => require('../authRoutes').clientAddress(req);

/** One address across every configuration, so many configurations do not mean many allowances. */
export function ownPageAddressLimit(req: any, res: any, next: any) {
  if (allowed(`address:${addressOf(req)}`, envInt('JELLYFIN_OWN_PAGE_ADDRESS_REQUESTS', 1800, 1), 60_000)) return next();
  res.setHeader('Retry-After', '60');
  return res.status(429).json({ error: 'Too many requests, try again in a minute' });
}

/** The most a personal page may upload, in place of the administrator's limit. */
export const ownPageImportMb = (): number => Math.min(envInt('JELLYFIN_OWN_PAGE_IMPORT_MB', 32, 1), envInt('JELLYFIN_HISTORY_IMPORT_MAX_MB', 64, 1));

export function ownPageGuard(access: OwnPageAccess, requireAdmin: (req: any, res: any, next: any) => unknown) {
  return async (req: any, res: any, next: any) => {
    const token = req.headers[OWN_PAGE_HEADER];
    if (!token || req.headers['x-admin-key']) return requireAdmin(req, res, next);
    try {
      if (!ownPagesOn()) return res.status(401).json({ error: 'Personal Jellyfin pages are off on this server' });
      if (!allowed(`address:${addressOf(req)}`, envInt('JELLYFIN_OWN_PAGE_ADDRESS_REQUESTS', 1800, 1), 60_000)) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ error: 'Too many requests, try again in a minute' });
      }
      const userUUID = typeof req.params.userUUID === 'string' ? req.params.userUUID : sessionUser(token);
      const session = userUUID ? await readSession(token, userUUID) : null;
      if (!session) return res.status(401).json({ error: 'Sign in again' });
      if (!allowed(`requests:${session.userUUID}`, envInt('JELLYFIN_OWN_PAGE_REQUESTS', 600, 1), 60_000)) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ error: 'Too many requests, try again in a minute' });
      }
      const refused = refusal(access, req, session);
      if (refused) return res.status(403).json({ error: refused });
      if ('heavy' in access && access.heavy && !allowed(`heavy:${session.userUUID}`, envInt('JELLYFIN_OWN_PAGE_HEAVY', 30, 1), 3_600_000)) {
        res.setHeader('Retry-After', '3600');
        return res.status(429).json({ error: 'That has run too many times this hour, try again later' });
      }
      if (access.turn) {
        if (!(await takeTurn(access.turn, res))) {
          res.setHeader('Retry-After', '60');
          return res.status(503).json({ error: LANES[access.turn].busy });
        }
        // Checked with the turn in hand, or everyone waiting would pass it at once.
        if (access.turn === 'files' && importsFull(req)) {
          res.setHeader('Retry-After', '300');
          return res.status(503).json({ error: 'The server is busy importing for others, try again in a few minutes' });
        }
      }
      req.ownPage = session;
      return next();
    } catch {
      return res.status(500).json({ error: 'The page could not check this sign-in' });
    }
  };
}

function sessionUser(token: unknown): string | null {
  try {
    const parsed = JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString());
    return typeof parsed?.u === 'string' ? parsed.u : null;
  } catch {
    return null;
  }
}

/** A page opened on one profile sees that profile's figures, and of a locked one no more than its name. */
export function ownPageOverview(req: any, payload: any): any {
  const session: OwnPageSession | undefined = req.ownPage;
  if (!session || session.full || !payload) return payload;
  const names = new Set(listProfiles(session.config, session.userUUID).filter((p) => session.open.has(keyOf(p))).map((p) => p.name));
  const histories = openKeys(session);
  return {
    ...payload,
    // These are histories, so an open profile sharing one keeps its figures while the profile it shares stays shut.
    profiles: (payload.profiles ?? []).filter((p: any) => histories.has(String(p.key))),
    viewers: (payload.viewers ?? []).filter((p: any) => session.open.has(String(p.key))),
    sync: (payload.sync ?? []).filter((row: any) => (row.profiles ?? []).some((name: string) => names.has(name))),
  };
}

async function profilesOf(session: OwnPageSession) {
  const { historyKeyOf } = require('./dashboard');
  const profiles = listProfiles(session.config, session.userUUID);
  const active = new Map<string, number>();
  // Only the picker shows this, and one profile never sees the picker.
  if (profiles.length > 1) {
    for (const row of (await database.playstateForConfiguration(session.userUUID).catch(() => [])) as any[]) {
      active.set(String(row.profile ?? ''), Math.max(Number(row.last_played_at) || 0, Number(row.updated_at) || 0));
    }
  }
  return profiles.map((p) => {
    const open = session.open.has(keyOf(p));
    return {
      key: keyOf(p),
      name: p.name,
      avatar: p.avatar ?? null,
      locked: Boolean(p.pin),
      open,
      activeAt: open ? active.get(historyKeyOf(session.config, session.userUUID, keyOf(p)) ?? '') || null : null,
    };
  });
}

/** The password, or an account already signed in, opens every profile without a PIN. */
export async function startSession(req: any, userUUID: string, password: unknown): Promise<{ status: number; body: any }> {
  if (!ownPagesOn()) return { status: 404, body: { error: 'Personal Jellyfin pages are off on this server' } };
  const { resolveConfigAccess } = require('../configAccess');
  // Opening the link with neither a password nor an account is no attempt at anything.
  if (typeof password !== 'string') {
    const access = req?.session?.accountId ? await resolveConfigAccess(req, userUUID, null).catch(() => null) : null;
    if (!access?.passwordHash) return { status: 401, body: { error: 'Sign in' } };
    return sessionFor(userUUID, access.passwordHash);
  }
  // Wrong guesses count per address, so someone else's guessing does not lock the owner out. Each ceiling
  // stops guessing spread over many addresses or many configurations, and a right password never adds to it.
  const address = addressOf(req);
  const guesses = `own-page-signin:${userUUID}:${address}`;
  const ceilings = [`own-page-signin:${userUUID}`, `own-page-signin-from:${address}`];
  const ceiling = envInt('JELLYFIN_OWN_PAGE_SIGNIN_CEILING', 100, 1);
  const waiting = { status: 429, body: { error: 'Too many tries, this configuration has to wait a while' } };
  if ((await Promise.all(ceilings.map(attemptsHeld))).some((held) => held >= ceiling)) return waiting;
  if (!(await takeAttempt(guesses, envInt('JELLYFIN_OWN_PAGE_SIGNINS', 10, 1), 3_600_000))) return waiting;
  const access = await resolveConfigAccess(req, userUUID, password).catch(() => null);
  if (!access?.passwordHash) {
    await Promise.all(ceilings.map((key) => takeAttempt(key, ceiling, 3_600_000)));
    return { status: 401, body: { error: 'That password did not open this configuration' } };
  }
  await resetAttempts(guesses);
  return sessionFor(userUUID, access.passwordHash);
}

async function sessionFor(userUUID: string, passwordHash: string): Promise<{ status: number; body: any }> {
  hashes.delete(userUUID);
  const token = mint(userUUID, [], passwordHash);
  const session = await readSession(token, userUUID);
  if (!session) return { status: 401, body: { error: 'That password did not open this configuration' } };
  return { status: 200, body: { token, profiles: await profilesOf(session) } };
}

export async function sessionProfiles(token: unknown, userUUID: string): Promise<{ status: number; body: any }> {
  if (!ownPagesOn()) return { status: 404, body: { error: 'Personal Jellyfin pages are off on this server' } };
  const session = await readSession(token, userUUID);
  return session ? { status: 200, body: { profiles: await profilesOf(session) } } : { status: 401, body: { error: 'Sign in again' } };
}

/** A locked profile's PIN adds it to the session, which keeps its time. */
export async function unlockProfile(token: unknown, userUUID: string, key: unknown, pin: unknown): Promise<{ status: number; body: any }> {
  if (!ownPagesOn()) return { status: 404, body: { error: 'Personal Jellyfin pages are off on this server' } };
  const session = await readSession(token, userUUID);
  if (!session) return { status: 401, body: { error: 'Sign in again' } };
  const profile = listProfiles(session.config, userUUID).find((p) => keyOf(p) === key);
  if (!profile) return { status: 404, body: { error: 'No such profile' } };
  if (!(await pinOpens(userUUID, profile, typeof pin === 'string' ? pin : ''))) return { status: 403, body: { error: 'That PIN did not open this profile' } };
  const hash = await passwordHashOf(userUUID);
  if (!hash) return { status: 401, body: { error: 'Sign in again' } };
  const parsed: SessionBody = JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString());
  const held = [...parsed.o.filter((o) => o.k !== keyOf(profile)), { k: keyOf(profile), p: pinMark(profile.pin) }];
  const next = mint(userUUID, held, hash, parsed.e);
  const opened = await readSession(next, userUUID);
  return opened ? { status: 200, body: { token: next, profiles: await profilesOf(opened) } } : { status: 401, body: { error: 'Sign in again' } };
}
