// A configuration's own Jellyfin page runs the dashboard's Jellyfin tab with a session in place of the admin key.

const ROOT = '/jellyfin-page';
const PATH = /^\/jellyfin-page\/([^/]+)/;
const CHOSE_KEY = 'own-page-chose';

export function isOwnPage(): boolean {
  return typeof window !== 'undefined' && Boolean((window as Window & { OWN_PAGE_MODE?: boolean }).OWN_PAGE_MODE);
}

export function ownPageUser(): string | null {
  if (!isOwnPage()) return null;
  const found = window.location.pathname.match(PATH);
  return found ? decodeURIComponent(found[1]) : null;
}

export const ownPageBase = (userUUID: string): string => `${ROOT}/${encodeURIComponent(userUUID)}`;

const tokenKey = (userUUID: string): string => `own-page:${userUUID}`;

export function ownPageToken(): string | null {
  const userUUID = ownPageUser();
  if (!userUUID) return null;
  try {
    return localStorage.getItem(tokenKey(userUUID));
  } catch {
    return null;
  }
}

export function keepOwnPageToken(userUUID: string, token: string | null): void {
  try {
    if (token) localStorage.setItem(tokenKey(userUUID), token);
    else localStorage.removeItem(tokenKey(userUUID));
  } catch {
    /* it lasts until this page closes, held by the caller */
  }
}

let everyProfileOpen = true;

/** Whether this session has every profile open; always so for an administrator. */
export const ownPageFull = (): boolean => !isOwnPage() || everyProfileOpen;

export function noteOwnPageFull(full: boolean): void {
  everyProfileOpen = full;
}

export function ownPageChose(): boolean {
  try {
    return sessionStorage.getItem(CHOSE_KEY) === '1';
  } catch {
    return false;
  }
}

export function noteOwnPageChose(chose: boolean): void {
  try {
    if (chose) sessionStorage.setItem(CHOSE_KEY, '1');
    else sessionStorage.removeItem(CHOSE_KEY);
  } catch {
    /* the picker shows again, which is only one more tap */
  }
}

/** Back to the profile picker, where a locked profile asks for its PIN again. */
export function switchOwnPageProfile(): void {
  const userUUID = ownPageUser();
  if (!userUUID) return;
  noteOwnPageChose(false);
  window.location.assign(ownPageBase(userUUID));
}

export function signOutOwnPage(): void {
  const userUUID = ownPageUser();
  if (!userUUID) return;
  keepOwnPageToken(userUUID, null);
  noteOwnPageChose(false);
  window.location.assign(ownPageBase(userUUID));
}

export interface OwnPageProfile {
  key: string;
  name: string;
  avatar: string | null;
  locked: boolean;
  open: boolean;
  activeAt: number | null;
}

async function ask(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const token = ownPageToken();
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(token ? { 'x-own-page': token } : {}) } });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

export const ownPageStatus = () => ask('/api/own-page/status');

export const ownPageProfiles = (userUUID: string) => ask(`/api/own-page/${encodeURIComponent(userUUID)}/profiles`);

export const startOwnPage = (userUUID: string, password?: string) =>
  ask(`/api/own-page/${encodeURIComponent(userUUID)}/session`, { method: 'POST', body: JSON.stringify(password ? { password } : {}) });

export const unlockOwnPage = (userUUID: string, profile: string, pin: string) =>
  ask(`/api/own-page/${encodeURIComponent(userUUID)}/unlock`, { method: 'POST', body: JSON.stringify({ profile, pin }) });
