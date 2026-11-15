const { getSetting }: any = require('./settingsService');
const { isOidcConfigured }: any = require('./oidc');

const APP_PAGES = new Set(['/index.html', '/configure', '/dashboard']);

const OPEN_API_PATHS = new Set([
  '/api/auth/status',
  '/api/auth/session',
  '/api/auth/logout',
  '/api/auth/oidc/start',
  '/api/auth/oidc/callback',
  '/api/auth/trakt/callback',
  '/api/auth/simkl/callback',
  '/api/config',
  '/api/config/addon-info',
  '/api/dashboard/config',
]);

/** Written into the meta we serve, so clients fetch these with no session. */
const OPEN_API_PREFIXES = ['/api/image/'];

const PROTECTED_PATHS = new Set(['/mal/disconnect', '/anilist/disconnect']);

const SIGNIN_REQUIRED = 'AIOM_SIGNIN_REQUIRED';

function truthy(value: any): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}

function signinRequired(): boolean {
  return truthy(getSetting('AUTH_REQUIRE_SIGNIN'));
}

/** Express routes case-insensitively and serves percent-encoded paths. */
function normalizePath(pathname: string): string {
  let path = String(pathname || '/');
  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed escape matches on the raw path rather than passing through.
  }
  path = path.toLowerCase();
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function isAppPage(pathname: string): boolean {
  const path = normalizePath(pathname);
  if (APP_PAGES.has(path)) return true;
  if (path.startsWith('/configure/') || path.startsWith('/dashboard/') || path.startsWith('/jellyfin-page/')) return true;
  return /^\/stremio\/[^/]+\/(configure|rating)$/.test(path);
}

function isProtectedApi(pathname: string): boolean {
  const path = normalizePath(pathname);
  if (PROTECTED_PATHS.has(path)) return true;
  if (!path.startsWith('/api/')) return false;
  if (OPEN_API_PATHS.has(path)) return false;
  return !OPEN_API_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function hasAdminKey(req: any): boolean {
  const key = process.env.ADMIN_KEY;
  return Boolean(key) && req?.headers?.['x-admin-key'] === key;
}

function isAuthenticatedRequest(req: any): boolean {
  return Boolean(req?.session) || hasAdminKey(req);
}

function gateApplies(req: any): boolean {
  if (isAuthenticatedRequest(req)) return false;
  if (!signinRequired()) return false;
  return isOidcConfigured();
}

function isSigninRequiredError(error: any): boolean {
  return error?.code === SIGNIN_REQUIRED;
}

function respondIfSigninRequired(error: any, res: any): boolean {
  if (!isSigninRequiredError(error)) return false;
  if (!res || res.headersSent) return true;
  res.status(401).json({ error: error.message });
  return true;
}

function assertConfigWriteAllowed(): void {
  const { inRequest, requestIsAuthenticated } = require('./requestSession');

  if (!inRequest()) return;
  if (requestIsAuthenticated()) return;
  if (!signinRequired()) return;
  if (!isOidcConfigured()) return;

  const error: any = new Error('Sign-in required to modify a configuration');
  error.code = SIGNIN_REQUIRED;
  error.statusCode = 401;
  throw error;
}

function requireSigninForApi(req: any, res: any, next: any): void {
  if (!gateApplies(req)) return next();
  if (!isProtectedApi(req.path)) return next();

  res.status(401).json({ error: 'Sign-in required' });
}

function requireSigninForAppPages(req: any, res: any, next: any): void {
  if (!gateApplies(req)) return next();
  if (!isAppPage(req.path)) return next();

  if (req.accepts(['html', 'json']) === 'html') {
    return res.redirect(302, `/api/auth/oidc/start?next=${encodeURIComponent(req.originalUrl)}`);
  }

  res.status(401).json({ error: 'Sign-in required' });
}

export {
  requireSigninForAppPages,
  requireSigninForApi,
  isAuthenticatedRequest,
  assertConfigWriteAllowed,
  isSigninRequiredError,
  respondIfSigninRequired,
  isAppPage,
  isProtectedApi,
  signinRequired,
};
module.exports = {
  requireSigninForAppPages,
  requireSigninForApi,
  isAuthenticatedRequest,
  assertConfigWriteAllowed,
  isSigninRequiredError,
  respondIfSigninRequired,
  isAppPage,
  isProtectedApi,
  signinRequired,
};
