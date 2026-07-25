const { fetch, FormData }: any = require('undici');
const { Blob }: any = require('node:buffer');
const crypto: any = require('crypto');
const database: any = require('./database');
const consola: any = require('consola');

const logger = consola.withTag('movielens');

const mlBase = () => (process.env.MOVIELENS_API_BASE || 'https://movielens.org/api').replace(/\/+$/, '');
const mlLoginReferer = () => process.env.MOVIELENS_LOGIN_REFERER || 'https://movielens.org/login';
const mlImportReferer = () => process.env.MOVIELENS_IMPORT_REFERER || 'https://movielens.org/profile/settings/import-export';
const mlTimeout = () => parseInt(process.env.MOVIELENS_REQUEST_TIMEOUT_MS || '25000', 10);
const mlUserAgent = () => process.env.MOVIELENS_USER_AGENT
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const baseHeaders = () => ({
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.5',
  'User-Agent': mlUserAgent(),
});

class MovieLensAuthError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'MovieLensAuthError';
  }
}

function credKey(): Buffer {
  const raw = process.env.MOVIELENS_CRED_KEY;
  if (!raw) throw new Error('MOVIELENS_CRED_KEY is not set — required to store MovieLens credentials');
  return crypto.createHash('sha256').update(raw).digest();
}

function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', credKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptSecret(blob: string): string {
  const [v, ivb, tagb, encb] = (blob || '').split(':');
  if (v !== 'v1' || !ivb || !tagb || !encb) throw new Error('Unrecognized MovieLens credential format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', credKey(), Buffer.from(ivb, 'base64'));
  decipher.setAuthTag(Buffer.from(tagb, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encb, 'base64')), decipher.final()]).toString('utf8');
}

async function login(userName: string, password: string): Promise<string> {
  const res = await fetch(`${mlBase()}/sessions`, {
    method: 'POST',
    headers: { ...baseHeaders(), 'Content-Type': 'application/json;charset=utf-8', Referer: mlLoginReferer() },
    body: JSON.stringify({ userName, password }),
    signal: AbortSignal.timeout(mlTimeout()),
  });
  if (res.status === 401 || res.status === 400) {
    throw new MovieLensAuthError('MovieLens rejected the username or password');
  }
  if (res.status !== 200) {
    throw new Error(`MovieLens login failed with status ${res.status}`);
  }
  const cookie = (res.headers.getSetCookie() || [])
    .map((c: string) => c.split(';')[0])
    .filter(Boolean)
    .join('; ');
  if (!cookie) throw new Error('MovieLens login returned no session cookie');
  return cookie;
}

async function connect(userName: string, password: string): Promise<string> {
  const cookie = await login(userName, password);
  const credId = crypto.randomUUID();
  await database.saveOAuthToken(credId, 'movielens', userName, cookie, encryptSecret(password), 0, '');
  logger.info(`Connected MovieLens account for user ${userName} (cred ${credId})`);
  return credId;
}

async function disconnect(credId: string): Promise<boolean> {
  return database.deleteOAuthToken(credId);
}

async function apiFetch(credId: string, path: string, opts: any = {}, retried = false): Promise<any> {
  const row = await database.getOAuthToken(credId);
  if (!row) throw new MovieLensAuthError(`No MovieLens credential for ${credId}`);

  const res = await fetch(`${mlBase()}/${path}`, {
    ...opts,
    headers: { ...baseHeaders(), ...(opts.headers || {}), cookie: row.access_token },
    signal: AbortSignal.timeout(mlTimeout()),
  });

  if (res.status === 401 && !retried) {
    logger.info(`MovieLens session expired for ${credId} — re-authenticating`);
    const password = decryptSecret(row.refresh_token);
    const cookie = await login(row.user_id, password);
    await database.updateOAuthToken(credId, cookie, row.refresh_token, 0);
    return apiFetch(credId, path, opts, true);
  }
  return res;
}

async function explore(credId: string, params: Record<string, any>): Promise<any[]> {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '') as any
  ).toString();
  const res = await apiFetch(credId, `movies/explore?${qs}`);
  if (res.status !== 200) throw new Error(`MovieLens explore failed with status ${res.status}`);
  const json: any = await res.json();
  return json?.data?.searchResults || [];
}

async function topPicks(
  credId: string,
  { genre, minYear, maxYear, page, pageSize }: { genre?: string; minYear?: number; maxYear?: number; page?: number; pageSize?: number } = {}
): Promise<any[]> {
  return explore(credId, { hasRated: 'no', sortBy: 'prediction', genre, minYear, maxYear, page, pageSize });
}

async function wishlist(credId: string, params: Record<string, any> = {}): Promise<any[]> {
  return explore(credId, { hasWishlisted: 'yes', sortBy: 'userListedDate', ...params });
}

async function getLists(credId: string): Promise<any[]> {
  const res = await apiFetch(credId, 'users/me/lists');
  if (res.status !== 200) throw new Error(`MovieLens lists failed with status ${res.status}`);
  const json: any = await res.json();
  return json?.data || [];
}

async function getListItems(
  credId: string,
  userId: string | number,
  listId: string | number,
  { page, pageSize }: { page?: number; pageSize?: number } = {}
): Promise<any[]> {
  const qs = new URLSearchParams(
    Object.entries({ page, pageSize }).filter(([, v]) => v !== undefined && v !== null) as any
  ).toString();
  const res = await apiFetch(credId, `users/${userId}/lists/${listId}${qs ? `?${qs}` : ''}`);
  if (res.status !== 200) throw new Error(`MovieLens list items failed with status ${res.status}`);
  const json: any = await res.json();
  return json?.data?.searchData?.searchResults || [];
}

interface MovieLensUserMeta {
  groupTags: string[];
  engineId: string | null;
  engineWeight: number | null;
  popWeight: number | null;
  numRatings: number | null;
}

async function getUserMeta(credId: string): Promise<MovieLensUserMeta> {
  const empty: MovieLensUserMeta = { groupTags: [], engineId: null, engineWeight: null, popWeight: null, numRatings: null };
  const res = await apiFetch(credId, 'users/me');
  // return empty metadata on failure, to avoid breaking otherwise working catalogs.
  if (res.status !== 200) return empty;
  const json: any = await res.json();
  const prefs = json?.data?.preferences || {};
  const rec = prefs.recommender || {};
  return {
    groupTags: Array.isArray(prefs.movieGroupTags) ? prefs.movieGroupTags : [],
    engineId: rec.engineId ?? null,
    engineWeight: rec.engineWeight ?? null,
    popWeight: rec.popWeight ?? null,
    numRatings: json?.data?.numRatings ?? null,
  };
}

async function getGenres(credId: string): Promise<any> {
  const res = await apiFetch(credId, 'movies/genres');
  if (res.status !== 200) throw new Error(`MovieLens genres failed with status ${res.status}`);
  const json: any = await res.json();
  return json?.data || {};
}

interface ImdbImportResult {
  successCount: number;
  alreadyRatedCount: number;
  errorCount: number;
  totalCount: number;
  errorImdbRatings: any[];
}

async function importImdbCsv(credId: string, csv: string): Promise<ImdbImportResult> {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'ratings.csv');
  const res = await apiFetch(credId, 'actions/imdb-import', {
    method: 'POST',
    headers: { Referer: mlImportReferer() },
    body: form,
  });
  const json: any = await res.json().catch(() => null);
  if (res.status !== 200 || json?.status !== 'success') {
    throw new Error(`MovieLens imdb-import failed (status ${res.status}): ${json?.message || 'unknown error'}`);
  }
  return json.data;
}

function imdbIdFromMovie(mlMovie: any): string | null {
  const raw = mlMovie?.movie?.imdbMovieId ?? mlMovie?.imdbMovieId;
  if (!raw) return null;
  return String(raw).startsWith('tt') ? String(raw) : `tt${raw}`;
}

export {
  MovieLensAuthError,
  encryptSecret,
  decryptSecret,
  login,
  connect,
  disconnect,
  explore,
  topPicks,
  wishlist,
  getLists,
  getListItems,
  getGenres,
  getUserMeta,
  importImdbCsv,
  imdbIdFromMovie,
};
module.exports = {
  MovieLensAuthError,
  encryptSecret,
  decryptSecret,
  login,
  connect,
  disconnect,
  explore,
  topPicks,
  wishlist,
  getLists,
  getListItems,
  getGenres,
  getUserMeta,
  importImdbCsv,
  imdbIdFromMovie,
};
