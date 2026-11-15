export const NUVIO_API = 'https://api.nuvio.tv';
export const NUVIO_KEY = 'sb_publishable_1Clq8rlTVACkdcZuqr6_AD__xUUC_EN';
export const NUVIO_FILE_NAME = 'nuvio-library.json';

const PAGE = 500;
const LIBRARY_FIELDS = ['content_id', 'content_type', 'name', 'added_at'];
const WATCHED_FIELDS = ['content_id', 'content_type', 'title', 'season', 'episode', 'watched_at'];
const PROGRESS_FIELDS = ['content_id', 'content_type', 'video_id', 'season', 'episode', 'position', 'duration', 'last_watched'];

export class NuvioError extends Error {
  status: number | null;
  code: string | null;

  constructor(message: string, status: number | null, code: string | null) {
    super(message);
    this.name = 'NuvioError';
    this.status = status;
    this.code = code;
  }
}

export async function nuvioCall<T>(path: string, body: Record<string, unknown>, token: string | null): Promise<T> {
  const headers: Record<string, string> = { apikey: NUVIO_KEY, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${NUVIO_API}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text().catch(() => '');
  let reply: any = null;
  try {
    reply = text ? JSON.parse(text) : null;
  } catch {
    reply = null;
  }
  if (!response.ok) {
    const code = typeof reply?.error_code === 'string' ? reply.error_code : typeof reply?.code === 'string' ? reply.code : null;
    throw new NuvioError(String(reply?.msg || reply?.message || `Nuvio answered ${response.status}`), response.status, code);
  }
  return reply as T;
}

const rpc = <T>(name: string, token: string, body: Record<string, unknown> = {}) => nuvioCall<T>(`/rest/v1/rpc/${name}`, body, token);

const rowsOf = (value: unknown): any[] => (Array.isArray(value) ? value : []);

export async function signIn(email: string, password: string): Promise<string> {
  const reply = await nuvioCall<any>('/auth/v1/token?grant_type=password', { email, password }, null);
  if (typeof reply?.access_token !== 'string' || !reply.access_token) throw new NuvioError('Nuvio sent no session', null, null);
  return reply.access_token;
}

export type NuvioCounts = { library: number; watched: number; progress: number };
export type NuvioProfileInfo = { index: number; id: string | null; name: string; hasPin: boolean; listed: boolean; counts: NuvioCounts | null };

const countIn = (map: unknown, index: number): number => {
  const n = Number(map && typeof map === 'object' ? (map as Record<string, unknown>)[String(index)] : 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export async function readProfiles(token: string): Promise<NuvioProfileInfo[]> {
  const [rows, overview] = await Promise.all([rpc<unknown>('sync_pull_profiles', token), rpc<any>('get_sync_overview', token).catch(() => null)]);
  const counted = overview && typeof overview === 'object' ? overview : null;
  const countsOf = (index: number): NuvioCounts | null =>
    counted ? { library: countIn(counted.library_items, index), watched: countIn(counted.watched_items, index), progress: countIn(counted.watch_progress, index) } : null;
  const profiles = new Map<number, NuvioProfileInfo>();
  for (const row of rowsOf(rows)) {
    const index = Number(row?.profile_index);
    if (!Number.isInteger(index) || index < 1) continue;
    const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : `Profile ${index}`;
    profiles.set(index, { index, id: typeof row.id === 'string' ? row.id : null, name, hasPin: row.pin_enabled === true, listed: true, counts: countsOf(index) });
  }
  const indexes = counted
    ? [counted.library_items, counted.watched_items, counted.watch_progress].flatMap((map) => (map && typeof map === 'object' ? Object.keys(map).map(Number) : []))
    : [];
  if (!profiles.size) indexes.push(1);
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 1 || profiles.has(index)) continue;
    profiles.set(index, { index, id: null, name: index === 1 ? 'Nuvio' : `Profile ${index}`, hasPin: false, listed: false, counts: countsOf(index) });
  }
  return [...profiles.values()].sort((a, b) => a.index - b.index);
}

export type NuvioProfileRows = { library: unknown[]; watched: unknown[]; progress: unknown[] };

const keep = (fields: string[]) => (row: any) => Object.fromEntries(fields.filter((field) => row && typeof row === 'object' && field in row).map((field) => [field, row[field]]));

async function paged(read: (page: number) => Promise<unknown>): Promise<any[]> {
  const all: any[] = [];
  for (let page = 0; ; page += 1) {
    const rows = rowsOf(await read(page));
    all.push(...rows);
    if (rows.length < PAGE) return all;
  }
}

export async function readProfile(token: string, index: number): Promise<NuvioProfileRows> {
  const library = await paged((page) => rpc('sync_pull_library', token, { p_profile_id: index, p_limit: PAGE, p_offset: page * PAGE }));
  const watched = await paged((page) => rpc('sync_pull_watched_items', token, { p_profile_id: index, p_page: page + 1, p_page_size: PAGE }));
  // Without a limit Nuvio returns every progress row in one answer.
  const progress = rowsOf(await rpc('sync_pull_watch_progress', token, { p_profile_id: index, p_since_last_watched: 0 }));
  return { library: library.map(keep(LIBRARY_FIELDS)), watched: watched.map(keep(WATCHED_FIELDS)), progress: progress.map(keep(PROGRESS_FIELDS)) };
}

export async function signOut(token: string): Promise<void> {
  await nuvioCall('/auth/v1/logout?scope=local', {}, token).catch(() => undefined);
}

export const profileKey = (profile: Pick<NuvioProfileInfo, 'index' | 'id'>): string => (profile.index === 1 ? '' : profile.id ?? `nuvio-profile-${profile.index}`);

export function nuvioMessage(error: unknown): string {
  if (error instanceof NuvioError) {
    if (error.code === 'invalid_credentials') return 'Wrong email or password.';
    if (error.status === 401) return 'Nuvio signed this session out. Sign in again.';
    if (error.status === 429) return 'Nuvio is busy. Try again in a minute.';
    return error.message;
  }
  return 'Nuvio could not be reached.';
}

export function libraryFile(profiles: Array<{ key: string; name: string } & NuvioProfileRows>): File {
  const json = JSON.stringify({
    format: 'nuvio-library',
    version: 1,
    exportedAt: new Date().toISOString(),
    profiles: profiles
      .filter((profile) => profile.library.length + profile.watched.length + profile.progress.length > 0)
      .map(({ key, name, library, watched, progress }) => ({ key, name, library, watched, progress })),
  });
  return new File([json], NUVIO_FILE_NAME, { type: 'application/json' });
}
