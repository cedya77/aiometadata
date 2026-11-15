const REDIRECT_STAMP_KEY = 'aiom:signin-redirect-at';
const REDIRECT_GUARD_WINDOW_MS = 60_000;
const SIGNIN_REQUIRED = 'Sign-in required';

function sameOriginApiPath(input: RequestInfo | URL): string | null {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    return url.pathname.startsWith('/api/') ? url.pathname : null;
  } catch {
    return null;
  }
}

function claimRedirect(): boolean {
  try {
    const storage = window.sessionStorage;
    const last = Number(storage.getItem(REDIRECT_STAMP_KEY));
    if (Number.isFinite(last) && Date.now() - last < REDIRECT_GUARD_WINDOW_MS) return false;
    storage.setItem(REDIRECT_STAMP_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

async function isSigninRequired(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  try {
    const body = await response.clone().json();
    return body?.error === SIGNIN_REQUIRED;
  } catch {
    return false;
  }
}

/**
 * The server only lets this page load with a session, so a sign-in-required reply
 * means it expired while the page was open. Go through sign-in and back here, as
 * a fresh load of the page would.
 */
export function installSigninRedirect(): void {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  if ((window as Window & { DASHBOARD_MODE?: boolean; OWN_PAGE_MODE?: boolean }).DASHBOARD_MODE) return;
  if ((window as Window & { OWN_PAGE_MODE?: boolean }).OWN_PAGE_MODE) return;

  const original = window.fetch.bind(window);
  let redirecting = false;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await original(input, init);
    const path = sameOriginApiPath(input);
    if (redirecting || !path || path.startsWith('/api/auth/')) return response;
    if (!(await isSigninRequired(response)) || !claimRedirect()) return response;

    redirecting = true;
    const next = encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
    window.location.assign(`/api/auth/oidc/start?next=${next}`);
    return response;
  };
}
