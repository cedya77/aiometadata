import crypto from 'crypto';
import consola from 'consola';
import redis from './redisClient';
import { getSetting } from './settingsService';
import database from './database';
import {
  attachSession,
  clearSessionCookie,
  countAccountSessions,
  createSession,
  destroyAccountSessions,
  destroySession,
  isSecureRequest,
  readCookie,
  setSessionCookie,
  SESSION_COOKIE,
  type Permission,
} from './authSession';
import {
  buildAuthRequest,
  exchangeCode,
  isOidcConfigured,
  previewPermissions,
  readOidcConfig,
  resolvePermissions,
  emailDomainRefusal,
} from './oidc';
import {
  clearSigninFailures,
  listSigninFailures,
  recordSigninFailure,
} from './signinFailures';

const logger = consola.withTag('Auth');

const FLOW_PREFIX = 'auth:flow:';
const FLOW_COOKIE = 'aiom_auth_flow';
const FLOW_TTL_SECONDS = 10 * 60;
const MAX_PROFILES = 50;
const MAX_LABEL_LENGTH = 64;

interface Flow {
  codeVerifier: string;
  nonce: string;
  next: string;
}

function resolveBaseUrl(req: any): string {
  const configured = process.env.HOST_NAME;
  if (configured) {
    return configured.startsWith('http') ? configured : `https://${configured}`;
  }
  return `${req.protocol}://${req.get('host')}`;
}

export function redirectUriFor(req: any): string {
  return `${resolveBaseUrl(req).replace(/\/+$/, '')}/api/auth/oidc/callback`;
}

/**
 * Only same-origin paths, so the provider cannot be used to bounce someone to
 * another site after a successful sign-in.
 */
function safeNext(value: unknown): string {
  const next = String(value ?? '').trim();
  if (!next.startsWith('/')) return '/configure';

  const base = 'https://aiom.invalid';
  let parsed: URL;
  try {
    parsed = new URL(next, base);
  } catch {
    return '/configure';
  }
  if (parsed.origin !== base) return '/configure';
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function trimmed(value: unknown): string {
  return String(value ?? '').trim();
}

function parseGroups(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : null;
  } catch {
    return null;
  }
}

function flowCookieOptions(req: any) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isSecureRequest(req),
    path: '/api/auth/oidc',
  };
}

function trustedProxyHops(): number {
  const parsed = parseInt(getSetting('TRUST_PROXY_HOPS') || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function clientAddress(req: any): string {
  const hops = trustedProxyHops();
  if (hops > 0) {
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((entry: string) => entry.trim())
      .filter(Boolean);
    const index = forwarded.length - hops;
    if (index >= 0 && forwarded[index]) return forwarded[index];
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function sameValue(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function ssoRateLimit(req: any, res: any, next: any): Promise<void> {
  const perWindow = Math.max(1, parseInt(getSetting('OIDC_RATE_LIMIT_PER_WINDOW') || '', 10) || 20);
  const windowSeconds = Math.max(1, parseInt(getSetting('OIDC_RATE_LIMIT_WINDOW') || '', 10) || 300);

  try {
    const address = clientAddress(req);
    const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
    const key = `rate-limit:sso:${address}:${bucket}`;

    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSeconds + 10);

    if (count > perWindow) {
      logger.warn(`Rate limited sign-in attempts from ${address}`);
      // Recording the refusal must not decide whether it is refused: anything
      // thrown here would reach the outer catch and let the request through.
      try {
        const first = await redis.set(`${key}:logged`, '1', 'EX', windowSeconds + 10, 'NX');
        if (first) {
          await recordSigninFailure({
            reason: 'rate-limited',
            address,
            detail: `More than ${perWindow} attempts in ${windowSeconds}s`,
          });
        }
      } catch (error: any) {
        logger.warn(`Could not record the rate-limited attempt: ${error.message}`);
      }
      return res.status(429).json({ error: 'Too many sign-in attempts. Please try again shortly.' });
    }
  } catch (error: any) {
    logger.warn(`Sign-in limiter failed, allowing request: ${error.message}`);
  }

  next();
}

export interface AdminImpact {
  signedOut: string[];
  demoted: string[];
}

export function emptyAdminImpact(): AdminImpact {
  return { signedOut: [], demoted: [] };
}

export async function accountsLosingAdmin(
  key: string,
  value: string,
  exceptAccountId?: string
): Promise<AdminImpact> {
  const config = readOidcConfig();
  const rows = await database.listAccounts();
  const impact: AdminImpact = emptyAdminImpact();

  for (const row of rows) {
    if (row.id === exceptAccountId) continue;
    const groups = parseGroups(row.groups_json);
    if (groups === null) continue;

    const before = resolvePermissions(groups, config);
    if (before === null || !before.includes('admin')) continue;

    const name = row.username || row.id;
    const preview = previewPermissions(groups, key, value);

    if (preview.outcome === 'malformed') continue;
    if (preview.outcome === 'unconfigured' || preview.outcome === 'refused') impact.signedOut.push(name);
    else if (!preview.permissions.includes('admin')) impact.demoted.push(name);
  }

  return impact;
}

export function register(addon: any, options: { rateLimit?: any; requireAdmin?: any } = {}): void {
  const rateLimit = options.rateLimit || ((_req: any, _res: any, next: any) => next());
  const requireAdmin = options.requireAdmin || ((_req: any, res: any) => res.status(401).json({ error: 'Unauthorized' }));

  addon.use(attachSession);

  // These answer from the session cookie alone, so a cached copy is a copy of
  // somebody's sign-in state. Express adds an ETag to every JSON response and
  // the default Vary does not mention Cookie, which leaves the answer eligible
  // for reuse across a sign-in.
  addon.use('/api/auth', (_req: any, res: any, next: any) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Vary', 'Cookie');
    next();
  });

  addon.get('/api/auth/status', (req: any, res: any) => {
    const config = readOidcConfig();
    res.json({
      oidcEnabled: isOidcConfigured(config),
      redirectUri: redirectUriFor(req),
      signedIn: Boolean(req.session),
    });
  });

  addon.get('/api/auth/session', (req: any, res: any) => {
    if (!req.session) return res.status(401).json({ error: 'Not signed in' });
    res.json({
      accountId: req.session.accountId,
      username: req.session.username,
      email: req.session.email,
      permissions: req.session.permissions,
    });
  });

  addon.post('/api/auth/logout', async (req: any, res: any) => {
    await destroySession(readCookie(req, SESSION_COOKIE));
    clearSessionCookie(req, res);
    res.json({ success: true });
  });

  addon.get('/api/auth/oidc/start', ssoRateLimit, async (req: any, res: any) => {
    const config = readOidcConfig();
    if (!isOidcConfigured(config)) {
      return res.status(404).json({ error: 'SSO is not configured on this instance' });
    }

    try {
      const request = await buildAuthRequest(config, redirectUriFor(req));
      const flow: Flow = {
        codeVerifier: request.codeVerifier,
        nonce: request.nonce,
        next: safeNext(req.query.next),
      };
      await redis.set(`${FLOW_PREFIX}${request.state}`, JSON.stringify(flow), 'EX', FLOW_TTL_SECONDS);
      res.cookie(FLOW_COOKIE, request.state, { ...flowCookieOptions(req), maxAge: FLOW_TTL_SECONDS * 1000 });
      res.redirect(request.url);
    } catch (error: any) {
      logger.error(`Could not start sign-in: ${error.message}`);
      res.status(502).json({ error: 'Could not reach the identity provider' });
    }
  });

  addon.get('/api/auth/oidc/callback', ssoRateLimit, async (req: any, res: any) => {
    const config = readOidcConfig();
    if (!isOidcConfigured(config)) {
      return res.status(404).json({ error: 'SSO is not configured on this instance' });
    }

    const state = trimmed(req.query.state);
    const code = trimmed(req.query.code);
    if (!state || !code) {
      return res.status(400).json({ error: 'Incomplete reply from the identity provider' });
    }

    const presented = readCookie(req, FLOW_COOKIE);
    res.clearCookie(FLOW_COOKIE, flowCookieOptions(req));
    if (!presented || !sameValue(presented, state)) {
      await recordSigninFailure({
        reason: 'browser-mismatch',
        address: clientAddress(req),
        detail: presented ? 'The reply carried a different state than this browser started' : 'This browser started no sign-in',
      });
      return res.status(400).json({ error: 'This sign-in did not start in this browser. Start again.' });
    }

    // Single use: a replayed state must not open a second session.
    const raw = await redis.get(`${FLOW_PREFIX}${state}`);
    await redis.del(`${FLOW_PREFIX}${state}`);
    if (!raw) {
      await recordSigninFailure({
        reason: 'expired',
        address: clientAddress(req),
        detail: 'The sign-in was already completed or took longer than the flow allows',
      });
      return res.status(400).json({ error: 'This sign-in is no longer valid. Start again.' });
    }

    const flow: Flow = JSON.parse(raw);

    try {
      const identity = await exchangeCode(config, code, flow.codeVerifier, flow.nonce, redirectUriFor(req));

      const domainRefusal = emailDomainRefusal(identity.email, config);
      if (domainRefusal) {
        logger.warn(`Refused ${identity.subject}: ${domainRefusal}`);
        await recordSigninFailure({
          reason: 'refused',
          username: identity.username,
          subject: identity.subject,
          issuer: identity.issuer,
          groups: identity.groups,
          groupsClaim: config.groupsClaim,
          address: clientAddress(req),
          detail: `Sign-in refused because ${domainRefusal}`,
        });
        return res.status(403).send('Your account is not allowed to sign in here.');
      }

      const permissions = resolvePermissions(identity.groups, config);
      if (permissions === null) {
        logger.warn(`Refused ${identity.subject}: nothing in the ${config.groupsClaim} claim grants access`);
        await recordSigninFailure({
          reason: 'refused',
          username: identity.username,
          subject: identity.subject,
          issuer: identity.issuer,
          groups: identity.groups,
          groupsClaim: config.groupsClaim,
          address: clientAddress(req),
          detail: config.groupPermissions === null
            ? 'The group mapping could not be read'
            : 'Nothing presented in the claim matched the group mapping',
        });
        return res.status(403).send('Your account is not allowed to sign in here.');
      }

      const account = await database.upsertAccount(
        identity.issuer,
        identity.subject,
        identity.username,
        identity.email,
        identity.groups
      );

      if (account.blocked) {
        logger.warn(`Refused ${identity.username}: the account is blocked`);
        await recordSigninFailure({
          reason: 'blocked',
          username: identity.username,
          subject: identity.subject,
          issuer: identity.issuer,
          groups: identity.groups,
          groupsClaim: config.groupsClaim,
          address: clientAddress(req),
          detail: 'An administrator blocked this account',
        });
        return res.status(403).send('Your account is not allowed to sign in here.');
      }

      const sessionId = await createSession({
        accountId: account.id,
        username: identity.username,
        email: identity.email,
        permissions: permissions as Permission[],
        groups: identity.groups,
      });

      let current;
      try {
        current = await database.getAccount(account.id);
      } catch (error: any) {
        await destroySession(sessionId);
        throw error;
      }

      if (!current || current.blocked) {
        const what = current ? 'blocked' : 'deleted';
        await destroySession(sessionId);
        logger.warn(`Refused ${identity.username}: the account was ${what} during sign-in`);
        await recordSigninFailure({
          reason: 'blocked',
          username: identity.username,
          subject: identity.subject,
          issuer: identity.issuer,
          groups: identity.groups,
          groupsClaim: config.groupsClaim,
          address: clientAddress(req),
          detail: `An administrator ${what} this account while it was signing in`,
        });
        return res.status(403).send('Your account is not allowed to sign in here.');
      }

      setSessionCookie(req, res, sessionId);

      logger.info(`Signed in ${identity.username} with ${permissions.length ? permissions.join(', ') : 'no'} permissions`);
      res.redirect(flow.next);
    } catch (error: any) {
      logger.error(`Sign-in failed: ${error.message}`);
      await recordSigninFailure({
        reason: 'provider-error',
        issuer: config.issuer,
        address: clientAddress(req),
        detail: error.message,
      });
      res.status(401).send('Sign-in failed. Please try again.');
    }
  });

  addon.get('/api/auth/accounts', requireAdmin, async (_req: any, res: any) => {
    try {
      const config = readOidcConfig();
      const mappingReadable = config.groupPermissions !== null;
      const rows = await database.listAccounts();
      const accounts = await Promise.all(rows.map(async (row: any) => {
        const groups = parseGroups(row.groups_json);
        return {
          accountId: row.id,
          issuer: row.issuer,
          subject: row.subject,
          username: row.username,
          email: row.email,
          groups,
          permissionsKnown: groups !== null,
          permissions: groups === null || !mappingReadable ? null : resolvePermissions(groups, config),
          blocked: Boolean(row.blocked),
          createdAt: row.created_at,
          lastSeenAt: row.last_seen_at,
          activeSessions: await countAccountSessions(row.id),
        };
      }));
      res.json({ accounts, groupsClaim: config.groupsClaim, mappingReadable });
    } catch (error: any) {
      logger.error(`Could not list accounts: ${error.message}`);
      res.status(500).json({ error: 'Could not list accounts' });
    }
  });

  addon.post('/api/auth/accounts/:accountId/block', requireAdmin, async (req: any, res: any) => {
    const accountId = trimmed(req.params.accountId);
    if (!accountId) return res.status(400).json({ error: 'An account is required' });

    const blocked = req.body?.blocked !== false;
    if (blocked && accountId === req.session?.accountId) {
      return res.status(409).json({ error: 'You cannot block your own account' });
    }

    try {
      const account = await database.getAccount(accountId);
      if (!account) return res.status(404).json({ error: 'No such account' });

      await database.setAccountBlocked(accountId, blocked);
      logger.info(`${blocked ? 'Blocked' : 'Unblocked'} ${account.username || accountId}`);
      if (!blocked) return res.json({ success: true, blocked, revoked: 0 });

      // Blocking only refuses the next sign-in, so the sessions it already
      // holds have to go with it or the block does nothing until they expire.
      try {
        const revoked = await destroyAccountSessions(accountId);
        return res.json({ success: true, blocked, revoked });
      } catch (error: any) {
        logger.error(`Blocked ${account.username || accountId} but could not sign them out: ${error.message}`);
        return res.json({
          success: true,
          blocked,
          revoked: typeof error.revoked === 'number' ? error.revoked : 0,
          warning: 'The block is saved, but signing out their existing sessions failed. Some may stay live until they expire.',
        });
      }
    } catch (error: any) {
      logger.error(`Could not change the block state: ${error.message}`);
      res.status(500).json({ error: 'Could not change this account\'s block state' });
    }
  });

  addon.get('/api/auth/signin-failures', requireAdmin, async (_req: any, res: any) => {
    try {
      res.json({ failures: await listSigninFailures() });
    } catch (error: any) {
      logger.error(`Could not list sign-in failures: ${error.message}`);
      res.status(500).json({ error: 'Could not list sign-in failures' });
    }
  });

  addon.delete('/api/auth/signin-failures', requireAdmin, async (_req: any, res: any) => {
    try {
      await clearSigninFailures();
      res.json({ success: true });
    } catch (error: any) {
      logger.error(`Could not clear sign-in failures: ${error.message}`);
      res.status(500).json({ error: 'Could not clear sign-in failures' });
    }
  });

  addon.post('/api/auth/accounts/:accountId/revoke', requireAdmin, async (req: any, res: any) => {
    const accountId = trimmed(req.params.accountId);
    if (!accountId) return res.status(400).json({ error: 'An account is required' });

    try {
      const account = await database.getAccount(accountId);
      if (!account) return res.status(404).json({ error: 'No such account' });

      const revoked = await destroyAccountSessions(accountId);
      logger.info(`Revoked ${revoked} session(s) for ${account.username || accountId}`);
      res.json({ success: true, revoked });
    } catch (error: any) {
      logger.error(`Could not revoke sessions: ${error.message}`);
      res.status(500).json({ error: 'Could not revoke this account\'s sessions' });
    }
  });

  addon.get('/api/auth/accounts/:accountId/configs', requireAdmin, async (req: any, res: any) => {
    try {
      const rows = await database.getAccountConfigs(req.params.accountId);
      res.json({
        configs: rows.map((row: any) => ({
          userUUID: row.user_uuid,
          label: row.label,
          linkedAt: row.linked_at,
          lastOpenedAt: row.last_opened_at,
        })),
      });
    } catch (error: any) {
      logger.error(`Could not list account configurations: ${error.message}`);
      res.status(500).json({ error: 'Could not list this account\'s configurations' });
    }
  });

  addon.delete('/api/auth/accounts/:accountId', requireAdmin, async (req: any, res: any) => {
    const accountId = trimmed(req.params.accountId);
    if (!accountId) return res.status(400).json({ error: 'An account is required' });

    if (accountId === req.session?.accountId && trimmed(req.query.confirm) !== 'true') {
      return res.status(409).json({
        error: 'This would delete your own account',
        requiresConfirmation: true,
        reason: 'Deleting your own account signs you out immediately and unlinks the configurations saved to it.',
      });
    }

    try {
      const account = await database.getAccount(accountId);
      if (!account) return res.status(404).json({ error: 'No such account' });

      await database.deleteAccount(accountId);

      try {
        const revoked = await destroyAccountSessions(accountId);
        logger.info(`Deleted account ${account.username || accountId} and ${revoked} session(s)`);
        return res.json({ success: true, revoked });
      } catch (error: any) {
        logger.error(`Deleted ${account.username || accountId} but could not sign them out: ${error.message}`);
        return res.json({
          success: true,
          revoked: typeof error.revoked === 'number' ? error.revoked : 0,
          warning: 'The account is deleted, but signing out its existing sessions failed. Some may stay live until they expire.',
        });
      }
    } catch (error: any) {
      logger.error(`Could not delete account: ${error.message}`);
      res.status(500).json({ error: 'Could not delete this account' });
    }
  });

  // --- Config profiles ---

  function requireSession(req: any, res: any, next: any) {
    if (!req.session) return res.status(401).json({ error: 'Not signed in' });
    next();
  }

  addon.get('/api/profiles', requireSession, async (req: any, res: any) => {
    try {
      const rows = await database.getAccountConfigs(req.session.accountId);
      res.json({
        profiles: rows.map((row: any) => ({
          userUUID: row.user_uuid,
          label: row.label,
          linkedAt: row.linked_at,
          lastOpenedAt: row.last_opened_at,
        })),
      });
    } catch (error: any) {
      logger.error(`Could not list profiles: ${error.message}`);
      res.status(500).json({ error: 'Could not list your configurations' });
    }
  });

  /**
   * The one place a configuration password is needed. Proving it once is what
   * links the configuration; afterwards the session stands in for it, and the
   * password is never stored.
   */
  addon.post('/api/profiles', requireSession, rateLimit, async (req: any, res: any) => {
    const userUUID = trimmed(req.body?.userUUID);
    const password = String(req.body?.password ?? '');
    const label = trimmed(req.body?.label).slice(0, MAX_LABEL_LENGTH);

    if (!userUUID || !password) {
      return res.status(400).json({ error: 'A UUID and its password are required' });
    }

    try {
      const already = await database.ownsConfig(req.session.accountId, userUUID);
      if (!already && await database.countAccountConfigs(req.session.accountId) >= MAX_PROFILES) {
        return res.status(409).json({ error: `You can save up to ${MAX_PROFILES} configurations` });
      }

      const config = await database.verifyUserAndGetConfig(userUUID, password);
      if (!config) {
        return res.status(401).json({ error: 'Invalid UUID or password' });
      }

      await database.linkAccountConfig(req.session.accountId, userUUID, label || userUUID.slice(0, 8));
      res.json({ success: true, userUUID, label: label || userUUID.slice(0, 8) });
    } catch (error: any) {
      logger.error(`Could not save profile: ${error.message}`);
      res.status(500).json({ error: 'Could not save this configuration' });
    }
  });

  addon.patch('/api/profiles/:userUUID', requireSession, async (req: any, res: any) => {
    const label = trimmed(req.body?.label).slice(0, MAX_LABEL_LENGTH);
    if (!label) return res.status(400).json({ error: 'A name is required' });

    try {
      if (!await database.ownsConfig(req.session.accountId, req.params.userUUID)) {
        return res.status(404).json({ error: 'Not one of your configurations' });
      }
      await database.linkAccountConfig(req.session.accountId, req.params.userUUID, label);
      res.json({ success: true, label });
    } catch (error: any) {
      logger.error(`Could not rename profile: ${error.message}`);
      res.status(500).json({ error: 'Could not rename this configuration' });
    }
  });

  /** Unlinks only. The configuration itself is untouched. */
  addon.delete('/api/profiles/:userUUID', requireSession, async (req: any, res: any) => {
    try {
      await database.unlinkAccountConfig(req.session.accountId, req.params.userUUID);
      res.json({ success: true });
    } catch (error: any) {
      logger.error(`Could not remove profile: ${error.message}`);
      res.status(500).json({ error: 'Could not remove this configuration' });
    }
  });
}

export { MAX_PROFILES };
