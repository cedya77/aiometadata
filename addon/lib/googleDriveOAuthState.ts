import crypto from 'crypto';

const STATE_DOMAIN = 'aiometadata:google-drive-backup-oauth-state:v1';
const STATE_TTL_MS = 10 * 60 * 1000;
const UUID_PATTERN = /^[A-Za-z0-9_-]{3,255}$/;

function keyFromSecret(secret: string): Buffer {
  if (!secret) throw new Error('Google Drive OAuth requires a client secret');
  return crypto.createHash('sha256').update(STATE_DOMAIN).update('\0').update(secret).digest();
}

export function createGoogleDriveOAuthState(
  userUUID: string,
  secret: string,
  now: number = Date.now()
): string {
  if (!UUID_PATTERN.test(userUUID)) throw new Error('Invalid user UUID');
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + STATE_TTL_MS)) {
    throw new Error('Invalid Google Drive OAuth state timestamp');
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromSecret(secret), iv);
  const payload = Buffer.from(JSON.stringify({
    userUUID,
    expiresAt: now + STATE_TTL_MS,
    nonce: crypto.randomBytes(16).toString('hex'),
  }));
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function verifyGoogleDriveOAuthState(
  state: unknown,
  secret: string,
  now: number = Date.now()
): string | null {
  if (
    typeof state !== 'string' ||
    state.length > 4096 ||
    !/^[A-Za-z0-9_-]+$/.test(state) ||
    !Number.isSafeInteger(now) ||
    now < 0
  ) {
    return null;
  }

  try {
    const data = Buffer.from(state, 'base64url');
    if (data.length < 29) return null;
    if (data.toString('base64url') !== state) return null;
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const encrypted = data.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromSecret(secret), iv);
    decipher.setAuthTag(tag);
    const payload = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(payload);

    if (
      typeof parsed.userUUID !== 'string' ||
      !UUID_PATTERN.test(parsed.userUUID) ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      parsed.expiresAt <= now
    ) {
      return null;
    }

    return parsed.userUUID;
  } catch {
    return null;
  }
}
