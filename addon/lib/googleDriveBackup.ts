import crypto from 'crypto';
import consola from 'consola';
import { resolveConfigAccess } from './configAccess';
import { createGoogleDriveOAuthState, verifyGoogleDriveOAuthState } from './googleDriveOAuthState';
import { normalizeRedirectUri } from '../utils/oauthRedirect';

const database: any = require('./database');
const { getSetting } = require('./settingsService');
const logger = consola.withTag('GoogleDriveBackup');
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const BACKUP_FORMAT_VERSION = 1;
const DEFAULT_RETENTION_LIMIT = 10;
const BACKUP_LOCK_MS = 30 * 60 * 1000;
const BACKUP_RETRY_MS = 60 * 60 * 1000;
const UUID_PATTERN = /^[A-Za-z0-9_-]{3,255}$/;
const API_BASE = 'https://www.googleapis.com/drive/v3';
let scheduler: NodeJS.Timeout | null = null;

interface DriveBackupFile {
  id: string;
  name: string;
  createdTime: string;
  appProperties?: Record<string, string>;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

class BackupBusyError extends Error {}

function credentials() {
  const clientId = String(getSetting('GOOGLE_DRIVE_CLIENT_ID') || '').trim();
  const clientSecret = String(getSetting('GOOGLE_DRIVE_CLIENT_SECRET') || '').trim();
  const redirectUri = normalizeRedirectUri(
    getSetting('GOOGLE_DRIVE_REDIRECT_URI') || `${process.env.HOST_NAME}/api/auth/google-drive/callback`
  );
  return { clientId, clientSecret, redirectUri };
}

function validUserUUID(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function sendOAuthResult(res: any, success: boolean, message: string) {
  const safeMessage = JSON.stringify(message).replace(/[<\u2028\u2029]/g, (character) => {
    if (character === '<') return '\\u003c';
    return character === '\u2028' ? '\\u2028' : '\\u2029';
  });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<title>Google Drive backup</title></head><body>
<p>${success ? 'Google Drive connected.' : 'Google Drive connection failed.'} This window may close.</p>
<script>
  if (window.opener) {
    window.opener.postMessage({
      type: 'aiometadata-google-drive-backup',
      success: ${success},
      message: ${safeMessage}
    }, window.location.origin);
    window.close();
  }
</script></body></html>`);
}

async function responseBody(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    if (response.ok) throw new Error('Google returned an invalid response');
    return { error: { message: text } };
  }
}

async function googleRequest(url: string, init: RequestInit = {}): Promise<any> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  const body = await responseBody(response);
  if (!response.ok) {
    const message = typeof body?.error?.message === 'string' ? body.error.message : response.statusText;
    throw new Error(`Google Drive request failed (${response.status}): ${message}`);
  }
  return body;
}

async function exchangeCode(code: string): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret, redirectUri } = credentials();
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await responseBody(response) as GoogleTokenResponse;
  if (!response.ok || !body?.access_token) {
    throw new Error(`Google OAuth token exchange failed (${response.status}): ${body?.error_description || body?.error || response.statusText}`);
  }
  return body;
}

async function getAccessToken(userUUID: string, tokenId: string): Promise<string> {
  const token = await database.getOAuthToken(tokenId);
  if (!token || token.provider !== 'google-drive' || token.user_id !== userUUID) {
    throw new Error('Google Drive is not connected to this configuration. Reconnect Google Drive and try again.');
  }

  if (Number(token.expires_at) > Date.now() + 60_000) return token.access_token;
  if (!token.refresh_token) {
    throw new Error('Google Drive authorization has expired. Reconnect Google Drive to continue.');
  }

  const { clientId, clientSecret } = credentials();
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await responseBody(response) as GoogleTokenResponse;
  if (!response.ok || !body?.access_token) {
    throw new Error(`Google Drive token refresh failed (${response.status}): ${body?.error_description || body?.error || response.statusText}`);
  }

  const expiresAt = Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000;
  const updated = await database.updateOAuthToken(tokenId, body.access_token, token.refresh_token, expiresAt);
  if (!updated) throw new Error('Google Drive token could not be saved after refresh');
  return body.access_token;
}

async function listDriveBackups(accessToken: string, userUUID: string): Promise<DriveBackupFile[]> {
  const query = `trashed = false and appProperties has { key='aiometadataUserUUID' and value='${userUUID}' } and appProperties has { key='aiometadataBackup' and value='v1' }`;
  const files: DriveBackupFile[] = [];
  let pageToken = '';

  do {
    const params = new URLSearchParams({
      q: query,
      pageSize: '1000',
      orderBy: 'createdTime desc',
      fields: 'nextPageToken,files(id,name,createdTime,appProperties)',
      spaces: 'drive',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await googleRequest(`${API_BASE}/files?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    files.push(...(Array.isArray(page.files) ? page.files : []));
    pageToken = typeof page.nextPageToken === 'string' ? page.nextPageToken : '';
  } while (pageToken);

  return files.sort((a, b) => b.createdTime.localeCompare(a.createdTime) || b.name.localeCompare(a.name));
}

async function deleteDriveFile(accessToken: string, fileId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = await responseBody(response);
    throw new Error(`Google Drive could not remove an expired backup (${response.status}): ${body?.error?.message || response.statusText}`);
  }
}

async function pruneDriveBackups(accessToken: string, userUUID: string, retentionLimit: number): Promise<void> {
  const files = await listDriveBackups(accessToken, userUUID);
  for (const expired of files.slice(retentionLimit)) {
    await deleteDriveFile(accessToken, expired.id);
  }
}

async function uploadBackup(accessToken: string, userUUID: string): Promise<DriveBackupFile> {
  const config = await database.getUserConfig(userUUID);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('No saved configuration was found to back up');
  }

  const now = new Date();
  const backup = {
    formatVersion: BACKUP_FORMAT_VERSION,
    userUUID,
    createdAt: now.toISOString(),
    config,
    jellyfinState: await database.getGoogleDriveJellyfinBackupState(userUUID),
  };
  const boundary = `aiometadata-${crypto.randomUUID()}`;
  const metadata = {
    name: `aiometadata-backup-${now.toISOString().replaceAll(':', '-')}.json`,
    mimeType: 'application/json',
    appProperties: {
      aiometadataUserUUID: userUUID,
      aiometadataBackup: 'v1',
    },
  };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(backup, null, 2)}\r\n`),
    Buffer.from(`--${boundary}--`),
  ]);
  const file = await googleRequest(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime,appProperties',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  if (!file?.id) throw new Error('Google Drive did not return an ID for the new backup');
  return file as DriveBackupFile;
}

async function readDriveBackup(accessToken: string, userUUID: string, fileId: string): Promise<any | null> {
  const available = await listDriveBackups(accessToken, userUUID);
  if (!available.some((file) => file.id === fileId)) return null;
  const response = await fetch(`${API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  const backup = await responseBody(response);
  if (!response.ok) throw new Error(`Google Drive could not read this backup (${response.status})`);
  if (
    backup?.formatVersion !== BACKUP_FORMAT_VERSION ||
    backup?.userUUID !== userUUID ||
    !backup.config ||
    typeof backup.config !== 'object' ||
    Array.isArray(backup.config)
  ) {
    throw new Error('This Drive file is not a valid backup for this UUID');
  }
  return backup;
}

async function runBackup(userUUID: string, allowDisabled: boolean): Promise<DriveBackupFile> {
  const now = Date.now();
  const claimed = await database.claimGoogleDriveBackup(
    userUUID,
    now,
    now + BACKUP_LOCK_MS,
    allowDisabled
  );
  if (!claimed) throw new BackupBusyError('A backup is already running for this configuration');

  try {
    const settings = await database.getGoogleDriveBackupSettings(userUUID);
    if (!settings) throw new Error('Google Drive backup is not configured for this UUID');
    const accessToken = await getAccessToken(userUUID, settings.token_id);
    const file = await uploadBackup(accessToken, userUUID);
    await pruneDriveBackups(accessToken, userUUID, Number(settings.retention_limit) || DEFAULT_RETENTION_LIMIT);
    await database.recordGoogleDriveBackupSuccess(userUUID, Date.now());
    logger.info(`Uploaded Google Drive backup ${file.id} for a UUID configuration`);
    return file;
  } catch (error) {
    try {
      await database.recordGoogleDriveBackupFailure(
        userUUID,
        error instanceof Error ? error.message : 'Unknown Google Drive backup failure',
        Date.now() + BACKUP_RETRY_MS
      );
    } catch (recordError) {
      logger.error('Could not record Google Drive backup failure:', recordError);
    }
    throw error;
  }
}

async function authorizeUser(req: any, userUUID: string) {
  const access = await resolveConfigAccess(req, userUUID, req.body?.password);
  return access;
}

async function restoreJellyfinState(userUUID: string, state: any): Promise<void> {
  await database.restoreGoogleDriveJellyfinBackupState(userUUID, state);
  require('./jellyfin/resume').invalidateResume(userUUID);
  require('./jellyfin/watchlist').invalidateWatchlist(userUUID);
  const restoredConfig = await database.getUserConfig(userUUID);
  if (!restoredConfig) throw new Error('The configuration no longer exists');
  await require('./jellyfin/watched').invalidateWatched(restoredConfig);
}

function getBodyUUID(req: any): string | null {
  return validUserUUID(req.body?.userUUID) ? req.body.userUUID : null;
}

function requireGoogleSetup(res: any): boolean {
  const { clientId, clientSecret } = credentials();
  if (clientId && clientSecret) return true;
  res.status(503).json({
    error: 'Google Drive backups are not configured on this server. Set GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET, then restart.',
  });
  return false;
}

export function registerGoogleDriveBackupRoutes(addon: any): void {
  addon.post('/api/google-drive-backup/status', async (req: any, res: any) => {
    const userUUID = getBodyUUID(req);
    if (!userUUID) return res.status(400).json({ error: 'A valid userUUID is required' });
    try {
      const access = await authorizeUser(req, userUUID);
      if (!access) return res.status(401).json({ error: 'Invalid UUID or password' });
      const settings = await database.getGoogleDriveBackupSettings(userUUID);
      const token = settings ? await database.getOAuthToken(settings.token_id) : null;
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        configured: Boolean(credentials().clientId && credentials().clientSecret),
        connected: Boolean(token && token.provider === 'google-drive' && token.user_id === userUUID),
        enabled: Boolean(settings?.enabled),
        retentionLimit: Number(settings?.retention_limit) || DEFAULT_RETENTION_LIMIT,
        lastBackupAt: settings?.last_backup_at ? Number(settings.last_backup_at) : null,
        nextBackupAt: settings?.next_backup_at ? Number(settings.next_backup_at) : null,
        lastBackupFailed: Boolean(settings?.last_error),
      });
    } catch (error) {
      logger.error('Could not load Google Drive backup status:', error);
      return res.status(500).json({ error: 'Could not load Google Drive backup status' });
    }
  });

  addon.post('/api/google-drive-backup/authorize', async (req: any, res: any) => {
    const userUUID = getBodyUUID(req);
    if (!userUUID) return res.status(400).json({ error: 'A valid userUUID is required' });
    try {
      const access = await authorizeUser(req, userUUID);
      if (!access) return res.status(401).json({ error: 'Invalid UUID or password' });
      if (!requireGoogleSetup(res)) return;
      const { clientId, clientSecret, redirectUri } = credentials();
      const state = createGoogleDriveOAuthState(userUUID, clientSecret);
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        state,
      }).toString();
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ authorizationUrl: url.toString() });
    } catch (error) {
      logger.error('Could not start Google Drive authorization:', error);
      return res.status(500).json({ error: 'Could not start Google Drive authorization' });
    }
  });

  addon.get('/api/auth/google-drive/callback', async (req: any, res: any) => {
    const stateParam = Array.isArray(req.query.state) ? req.query.state[0] : req.query.state;
    const { clientId, clientSecret } = credentials();
    if (!clientId || !clientSecret) {
      return sendOAuthResult(res, false, 'This server has not configured Google Drive OAuth.');
    }
    const userUUID = verifyGoogleDriveOAuthState(stateParam, clientSecret);
    if (!userUUID) return sendOAuthResult(res, false, 'The authorization request expired or was invalid. Start again.');
    const codeParam = Array.isArray(req.query.code) ? req.query.code[0] : req.query.code;
    const errorParam = Array.isArray(req.query.error) ? req.query.error[0] : req.query.error;
    if (errorParam || typeof codeParam !== 'string' || !codeParam) {
      return sendOAuthResult(res, false, 'Google Drive authorization was cancelled or did not complete.');
    }

    let createdTokenId: string | null = null;
    try {
      if (!(await database.getUser(userUUID))) {
        return sendOAuthResult(res, false, 'The configuration no longer exists. Reload it and try again.');
      }
      const tokens = await exchangeCode(codeParam);
      if (!tokens.refresh_token) {
        throw new Error('Google did not return offline access. Revoke the app in your Google Account and reconnect.');
      }
      const tokenId = crypto.randomUUID();
      createdTokenId = tokenId;
      const saved = await database.saveOAuthToken(
        tokenId,
        'google-drive',
        userUUID,
        tokens.access_token!,
        tokens.refresh_token,
        Date.now() + Math.max(60, Number(tokens.expires_in) || 3600) * 1000,
        tokens.scope || GOOGLE_SCOPE
      );
      if (!saved) throw new Error('Could not save the Google Drive authorization');

      const previous = await database.getGoogleDriveBackupSettings(userUUID);
      await database.saveGoogleDriveBackupSettings(
        userUUID,
        tokenId,
        Number(previous?.retention_limit) || DEFAULT_RETENTION_LIMIT,
        true,
        Date.now()
      );
      if (previous?.token_id && previous.token_id !== tokenId) {
        await database.deleteOAuthToken(previous.token_id);
      }
      return sendOAuthResult(res, true, 'Google Drive is connected. Daily backups are enabled.');
    } catch (error) {
      if (createdTokenId) await database.deleteOAuthToken(createdTokenId);
      logger.error('Google Drive OAuth callback failed:', error);
      return sendOAuthResult(
        res,
        false,
        error instanceof Error ? error.message : 'Google Drive could not be connected.'
      );
    }
  });

  addon.post('/api/google-drive-backup/settings', async (req: any, res: any) => {
    const userUUID = getBodyUUID(req);
    if (!userUUID) return res.status(400).json({ error: 'A valid userUUID is required' });
    const { enabled, retentionLimit } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
    if (!Number.isSafeInteger(retentionLimit) || retentionLimit < 1 || retentionLimit > 2_147_483_647) {
      return res.status(400).json({ error: 'retentionLimit must be a positive integer' });
    }
    try {
      const access = await authorizeUser(req, userUUID);
      if (!access) return res.status(401).json({ error: 'Invalid UUID or password' });
      const existing = await database.getGoogleDriveBackupSettings(userUUID);
      if (!existing) return res.status(409).json({ error: 'Connect Google Drive before changing backup settings' });
      const nextBackupAt = enabled && !existing.enabled
        ? Date.now()
        : Number(existing.next_backup_at) || Date.now();
      const updated = await database.updateGoogleDriveBackupSettings(
        userUUID,
        enabled,
        retentionLimit,
        nextBackupAt
      );
      if (!updated) return res.status(409).json({ error: 'Google Drive backup settings no longer exist' });
      if (retentionLimit < Number(existing.retention_limit)) {
        try {
          const accessToken = await getAccessToken(userUUID, existing.token_id);
          await pruneDriveBackups(accessToken, userUUID, retentionLimit);
        } catch (error) {
          logger.error('Saved Google Drive retention limit but could not remove older backups:', error);
          return res.status(502).json({
            error: 'The new backup limit was saved, but older Drive backups could not be removed. Reconnect Google Drive and try again.',
          });
        }
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ success: true, enabled, retentionLimit });
    } catch (error) {
      logger.error('Could not update Google Drive backup settings:', error);
      return res.status(500).json({ error: 'Could not update Google Drive backup settings' });
    }
  });

  addon.post('/api/google-drive-backup/list', async (req: any, res: any) => {
    const userUUID = getBodyUUID(req);
    if (!userUUID) return res.status(400).json({ error: 'A valid userUUID is required' });
    try {
      const access = await authorizeUser(req, userUUID);
      if (!access) return res.status(401).json({ error: 'Invalid UUID or password' });
      const settings = await database.getGoogleDriveBackupSettings(userUUID);
      if (!settings) return res.status(409).json({ error: 'Connect Google Drive to see backups' });
      const accessToken = await getAccessToken(userUUID, settings.token_id);
      const files = await listDriveBackups(accessToken, userUUID);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        backups: files.map(({ id, name, createdTime }) => ({ id, name, createdTime })),
      });
    } catch (error) {
      logger.error('Could not list Google Drive backups:', error);
      return res.status(502).json({
        error: error instanceof Error ? error.message : 'Could not list Google Drive backups',
      });
    }
  });

  addon.post('/api/google-drive-backup/export-file', async (req: any, res: any) => {
    const userUUID = getBodyUUID(req);
    const fileId = req.body?.fileId;
    if (!userUUID) return res.status(400).json({ error: 'A valid userUUID is required' });
    if (typeof fileId !== 'string' || !fileId || fileId.length > 1024) {
      return res.status(400).json({ error: 'A valid backup fileId is required' });
    }
    try {
      const access = await authorizeUser(req, userUUID);
      if (!access) return res.status(401).json({ error: 'Invalid UUID or password' });
      const settings = await database.getGoogleDriveBackupSettings(userUUID);
      if (!settings) return res.status(409).json({ error: 'Connect Google Drive to export a backup' });
      const accessToken = await getAccessToken(userUUID, settings.token_id);
      const backup = await readDriveBackup(accessToken, userUUID, fileId);
      if (!backup) return res.status(404).json({ error: 'That backup does not belong to this UUID or no longer exists' });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ backup });
    } catch (error) {
      logger.error('Could not export a portable Google Drive backup:', error);
      return res.status(502).json({
        error: error instanceof Error ? error.message : 'Could not export this Google Drive backup',
      });
    }
  });

  addon.post('/api/google-drive-backup/run', async (req: any, res: any) => {
    const userUUID = getBodyUUID(req);
    if (!userUUID) return res.status(400).json({ error: 'A valid userUUID is required' });
    try {
      const access = await authorizeUser(req, userUUID);
      if (!access) return res.status(401).json({ error: 'Invalid UUID or password' });
      const settings = await database.getGoogleDriveBackupSettings(userUUID);
      if (!settings) return res.status(409).json({ error: 'Connect Google Drive before creating a backup' });
      const file = await runBackup(userUUID, true);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ success: true, backup: { id: file.id, name: file.name, createdTime: file.createdTime } });
    } catch (error) {
      if (error instanceof BackupBusyError) return res.status(409).json({ error: error.message });
      logger.error('Manual Google Drive backup failed:', error);
      return res.status(502).json({
        error: error instanceof Error ? error.message : 'Google Drive backup failed',
      });
    }
  });

  addon.post('/api/google-drive-backup/restore', async (req: any, res: any) => {
    const userUUID = getBodyUUID(req);
    const fileId = req.body?.fileId;
    if (!userUUID) return res.status(400).json({ error: 'A valid userUUID is required' });
    if (typeof fileId !== 'string' || !fileId || fileId.length > 1024) {
      return res.status(400).json({ error: 'A valid backup fileId is required' });
    }
    try {
      const access = await authorizeUser(req, userUUID);
      if (!access) return res.status(401).json({ error: 'Invalid UUID or password' });
      const settings = await database.getGoogleDriveBackupSettings(userUUID);
      if (!settings) return res.status(409).json({ error: 'Connect Google Drive before restoring a backup' });
      const accessToken = await getAccessToken(userUUID, settings.token_id);
      const available = await listDriveBackups(accessToken, userUUID);
      if (!available.some((file) => file.id === fileId)) {
        return res.status(404).json({ error: 'That backup does not belong to this UUID or no longer exists' });
      }
      const response = await fetch(`${API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(20_000),
      });
      const backup = await responseBody(response);
      if (!response.ok) {
        throw new Error(`Google Drive could not read this backup (${response.status})`);
      }
      if (
        backup?.formatVersion !== BACKUP_FORMAT_VERSION ||
        backup?.userUUID !== userUUID ||
        !backup.config ||
        typeof backup.config !== 'object' ||
        Array.isArray(backup.config)
      ) {
        return res.status(422).json({ error: 'This Drive file is not a valid backup for this UUID' });
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ success: true, config: backup.config, hasJellyfinState: Boolean(backup.jellyfinState) });
    } catch (error) {
      logger.error('Could not read Google Drive backup:', error);
      return res.status(502).json({
        error: error instanceof Error ? error.message : 'Could not read Google Drive backup',
      });
    }
  });

  addon.post('/api/google-drive-backup/restore-state', async (req: any, res: any) => {
    const userUUID = getBodyUUID(req);
    const fileId = req.body?.fileId;
    if (!userUUID) return res.status(400).json({ error: 'A valid userUUID is required' });
    if (typeof fileId !== 'string' || !fileId || fileId.length > 1024) {
      return res.status(400).json({ error: 'A valid backup fileId is required' });
    }
    try {
      const access = await authorizeUser(req, userUUID);
      if (!access) return res.status(401).json({ error: 'Invalid UUID or password' });
      const settings = await database.getGoogleDriveBackupSettings(userUUID);
      if (!settings) return res.status(409).json({ error: 'Connect Google Drive before restoring a backup' });
      const accessToken = await getAccessToken(userUUID, settings.token_id);
      const backup = await readDriveBackup(accessToken, userUUID, fileId);
      if (!backup) {
        return res.status(404).json({ error: 'That backup does not belong to this UUID or no longer exists' });
      }
      if (!backup.jellyfinState) return res.status(409).json({ error: 'This backup does not contain Jellyfin history' });
      await restoreJellyfinState(userUUID, backup.jellyfinState);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ success: true });
    } catch (error) {
      logger.error('Could not restore Jellyfin state from Google Drive backup:', error);
      return res.status(422).json({
        error: error instanceof Error ? error.message : 'Could not restore Jellyfin state from Google Drive backup',
      });
    }
  });

  addon.post('/api/google-drive-backup/restore-portable-state', async (req: any, res: any) => {
    const userUUID = getBodyUUID(req);
    if (!userUUID) return res.status(400).json({ error: 'A valid userUUID is required' });
    try {
      const access = await authorizeUser(req, userUUID);
      if (!access) return res.status(401).json({ error: 'Invalid UUID or password' });
      if (!req.body?.state) return res.status(400).json({ error: 'Portable backup Jellyfin state is required' });
      await restoreJellyfinState(userUUID, req.body.state);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ success: true });
    } catch (error) {
      logger.error('Could not restore portable Jellyfin state:', error);
      return res.status(422).json({
        error: error instanceof Error ? error.message : 'Could not restore portable Jellyfin state',
      });
    }
  });

  addon.post('/api/google-drive-backup/disconnect', async (req: any, res: any) => {
    const userUUID = getBodyUUID(req);
    if (!userUUID) return res.status(400).json({ error: 'A valid userUUID is required' });
    try {
      const access = await authorizeUser(req, userUUID);
      if (!access) return res.status(401).json({ error: 'Invalid UUID or password' });
      const settings = await database.getGoogleDriveBackupSettings(userUUID);
      await database.deleteGoogleDriveBackupSettings(userUUID);
      if (settings?.token_id) await database.deleteOAuthToken(settings.token_id);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ success: true, backupsKept: true });
    } catch (error) {
      logger.error('Could not disconnect Google Drive:', error);
      return res.status(500).json({ error: 'Could not disconnect Google Drive' });
    }
  });
}

async function runDueBackups(): Promise<void> {
  try {
    const due = await database.getDueGoogleDriveBackups(Date.now());
    for (const row of due) {
      try {
        await runBackup(row.user_uuid, false);
      } catch (error) {
        if (error instanceof BackupBusyError) continue;
        logger.error('Scheduled Google Drive backup failed:', error);
      }
    }
  } catch (error) {
    logger.error('Could not check scheduled Google Drive backups:', error);
  }
}

export function startGoogleDriveBackupScheduler(): void {
  if (scheduler) return;
  scheduler = setInterval(() => void runDueBackups(), 5 * 60 * 1000);
  scheduler.unref?.();
  void runDueBackups();
}
