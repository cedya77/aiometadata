// Stremio's account API, called straight from the browser so the password and keys never reach this server.

export const STREMIO_API = 'https://api.strem.io/api/';
export const STREMIO_FILE_NAME = 'stremio-library.json';

export class StremioError extends Error {
  code: number | null;

  constructor(message: string, code: number | null) {
    super(message);
    this.name = 'StremioError';
    this.code = code;
  }
}

// Stremio answers errors with 200, 400 or 401 alike, so only the body says whether a call worked.
export async function stremioCall<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${STREMIO_API}${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const reply = await response.json().catch(() => null);
  if (reply?.error) {
    const code = Number(reply.error.code);
    throw new StremioError(String(reply.error.message || 'Stremio refused the request'), Number.isFinite(code) ? code : null);
  }
  if (!reply || !('result' in reply)) throw new StremioError(`Stremio answered ${response.status}`, null);
  return reply.result as T;
}

const keyOf = (result: any): string => {
  if (typeof result?.authKey !== 'string' || !result.authKey) throw new StremioError('Stremio sent no session', null);
  return result.authKey;
};

export async function signIn(email: string, password: string): Promise<string> {
  return keyOf(await stremioCall('login', { type: 'Login', email, password, facebook: false }));
}

export type StremioProfileInfo = { id: string; name: string; hasPin: boolean; main: boolean };
export type StremioAccount = { accountId: string; profileKey: boolean; profiles: StremioProfileInfo[] };

export async function readAccount(authKey: string): Promise<StremioAccount> {
  const user: any = await stremioCall('getUser', { type: 'GetUser', authKey });
  const id = String(user?._id ?? '');
  const listed: Record<string, any> = user?.premiumPrefs?.userProfiles && typeof user.premiumPrefs.userProfiles === 'object' ? user.premiumPrefs.userProfiles : {};
  const nameOf = (profileId: string) => (typeof listed[profileId]?.name === 'string' && listed[profileId].name.trim()) || 'Stremio';
  if (user?.parent_id) {
    return { accountId: String(user.parent_id), profileKey: true, profiles: [{ id, name: nameOf(id), hasPin: false, main: false }] };
  }
  const profiles = Object.keys(listed).map((profileId) => ({ id: profileId, name: nameOf(profileId), hasPin: listed[profileId]?.hasPin === true, main: profileId === id }));
  if (!profiles.some((profile) => profile.main)) profiles.push({ id, name: 'Stremio', hasPin: false, main: true });
  profiles.sort((a, b) => Number(b.main) - Number(a.main));
  return { accountId: id, profileKey: false, profiles };
}

export async function openProfile(accountKey: string, profileId: string, pin: string): Promise<string> {
  return keyOf(await stremioCall('premiumPrefs/authenticateProfile', { type: 'AuthenticateProfile', authKey: accountKey, profileId, pin }));
}

export async function readLibrary(authKey: string): Promise<unknown[]> {
  const items = await stremioCall<unknown>('datastoreGet', { authKey, collection: 'libraryItem', ids: [], all: true });
  return Array.isArray(items) ? items : [];
}

export async function signOut(authKey: string): Promise<void> {
  try {
    await stremioCall('logout', { type: 'Logout', authKey });
  } catch {
    // The session is left to expire.
  }
}

export function stremioMessage(error: unknown): string {
  if (error instanceof StremioError) {
    if (error.code === 1) return 'Stremio signed this session out. Sign in again.';
    if (error.code === 2) return 'No Stremio account uses that email.';
    if (error.code === 54) return 'Incorrect PIN.';
    return error.message;
  }
  return 'Stremio could not be reached.';
}

export function libraryFile(profiles: Array<{ key: string; name: string; items: unknown[] }>): File {
  const json = JSON.stringify({
    format: 'stremio-library',
    version: 1,
    exportedAt: new Date().toISOString(),
    profiles: profiles.filter((profile) => profile.items.length > 0).map(({ key, name, items }) => ({ key, name, items })),
  });
  return new File([json], STREMIO_FILE_NAME, { type: 'application/json' });
}
