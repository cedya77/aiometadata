// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import crypto from 'crypto';

const STATE_VERSION_HEX = '01';
const EXPIRY_HEX_LENGTH = 16;
const NONCE_HEX_LENGTH = 64;
const MAC_HEX_LENGTH = 64;
const UNSIGNED_STATE_LENGTH =
  STATE_VERSION_HEX.length + EXPIRY_HEX_LENGTH + NONCE_HEX_LENGTH;
const STATE_LENGTH = UNSIGNED_STATE_LENGTH + MAC_HEX_LENGTH;
const STATE_PATTERN = new RegExp(`^[0-9a-f]{${STATE_LENGTH}}$`);
const TRAKT_STATE_HMAC_DOMAIN = 'aiometadata:trakt-oauth-state:v1';
const MAL_STATE_HMAC_DOMAIN = 'aiometadata:mal-oauth-state:v1';
const ANILIST_STATE_HMAC_DOMAIN = 'aiometadata:anilist-oauth-state:v1';
const SIMKL_STATE_HMAC_DOMAIN = 'aiometadata:simkl-oauth-state:v1';
const MAL_PKCE_VERIFIER_DOMAIN = 'aiometadata:mal-pkce-verifier:v1';
const SIMKL_V2_STATE_HMAC_DOMAIN = 'aiometadata:simkl-oauth2-state:v1';
const SIMKL_V2_PKCE_VERIFIER_DOMAIN = 'aiometadata:simkl-pkce-verifier:v1';

function validateSigningInputs(
  provider: string,
  secret: string,
  ttlMs: number,
  now: number
): void {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error(`${provider} OAuth state signing requires a non-empty client secret`);
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error(`${provider} OAuth state TTL must be a positive integer in milliseconds`);
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error(`${provider} OAuth state timestamp must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(now + ttlMs)) {
    throw new Error(`${provider} OAuth state expiry exceeds the supported timestamp range`);
  }
}

function createMac(unsignedState: string, secret: string, domain: string): Buffer {
  return crypto
    .createHmac('sha256', secret)
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(unsignedState, 'ascii')
    .digest();
}

function createSignedOAuthState(
  provider: string,
  secret: string,
  ttlMs: number,
  domain: string,
  now: number = Date.now()
): string {
  validateSigningInputs(provider, secret, ttlMs, now);

  const expiresAt = now + ttlMs;
  const expiryHex = expiresAt.toString(16).padStart(EXPIRY_HEX_LENGTH, '0');
  if (expiryHex.length !== EXPIRY_HEX_LENGTH) {
    throw new Error(`${provider} OAuth state expiry does not fit the token format`);
  }

  const nonceHex = crypto.randomBytes(NONCE_HEX_LENGTH / 2).toString('hex');
  const unsignedState = `${STATE_VERSION_HEX}${expiryHex}${nonceHex}`;
  const macHex = createMac(unsignedState, secret, domain).toString('hex');

  return `${unsignedState}${macHex}`;
}

function verifySignedOAuthState(
  state: unknown,
  secret: string,
  domain: string,
  now: number = Date.now()
): string | null {
  if (
    typeof state !== 'string' ||
    typeof secret !== 'string' ||
    secret.length === 0 ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !STATE_PATTERN.test(state)
  ) {
    return null;
  }

  const unsignedState = state.slice(0, UNSIGNED_STATE_LENGTH);
  const suppliedMac = Buffer.from(state.slice(UNSIGNED_STATE_LENGTH), 'hex');
  const expectedMac = createMac(unsignedState, secret, domain);

  if (
    suppliedMac.length !== expectedMac.length ||
    !crypto.timingSafeEqual(suppliedMac, expectedMac)
  ) {
    return null;
  }

  const versionHex = unsignedState.slice(0, STATE_VERSION_HEX.length);
  if (versionHex !== STATE_VERSION_HEX) {
    return null;
  }

  const expiryStart = STATE_VERSION_HEX.length;
  const expiryHex = unsignedState.slice(expiryStart, expiryStart + EXPIRY_HEX_LENGTH);
  const expiresAt = BigInt(`0x${expiryHex}`);
  if (expiresAt > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }

  return Number(expiresAt) > now ? unsignedState : null;
}

function deriveMalCodeVerifier(state: string, secret: string): string {
  return deriveCodeVerifier(state, secret, MAL_PKCE_VERIFIER_DOMAIN);
}

function deriveCodeVerifier(state: string, secret: string, domain: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(state, 'ascii')
    .digest('base64url');
}

export function createTraktOAuthState(
  secret: string,
  ttlMs: number,
  now: number = Date.now()
): string {
  return createSignedOAuthState(
    'Trakt',
    secret,
    ttlMs,
    TRAKT_STATE_HMAC_DOMAIN,
    now
  );
}

export function verifyTraktOAuthState(
  state: unknown,
  secret: string,
  now: number = Date.now()
): boolean {
  return verifySignedOAuthState(state, secret, TRAKT_STATE_HMAC_DOMAIN, now) !== null;
}

export function createAniListOAuthState(
  secret: string,
  ttlMs: number,
  now: number = Date.now()
): string {
  return createSignedOAuthState(
    'AniList',
    secret,
    ttlMs,
    ANILIST_STATE_HMAC_DOMAIN,
    now
  );
}

export function verifyAniListOAuthState(
  state: unknown,
  secret: string,
  now: number = Date.now()
): boolean {
  return verifySignedOAuthState(state, secret, ANILIST_STATE_HMAC_DOMAIN, now) !== null;
}

export function createSimklOAuthState(
  secret: string,
  ttlMs: number,
  now: number = Date.now()
): string {
  return createSignedOAuthState(
    'Simkl',
    secret,
    ttlMs,
    SIMKL_STATE_HMAC_DOMAIN,
    now
  );
}

export function verifySimklOAuthState(
  state: unknown,
  secret: string,
  now: number = Date.now()
): boolean {
  return verifySignedOAuthState(state, secret, SIMKL_STATE_HMAC_DOMAIN, now) !== null;
}

export interface MalOAuthTransaction {
  state: string;
  codeVerifier: string;
}

export function createMalOAuthTransaction(
  secret: string,
  ttlMs: number,
  now: number = Date.now()
): MalOAuthTransaction {
  const state = createSignedOAuthState('MAL', secret, ttlMs, MAL_STATE_HMAC_DOMAIN, now);
  return {
    state,
    codeVerifier: deriveMalCodeVerifier(state, secret),
  };
}

export function verifyMalOAuthState(
  state: unknown,
  secret: string,
  now: number = Date.now()
): string | null {
  const verifiedState = verifySignedOAuthState(state, secret, MAL_STATE_HMAC_DOMAIN, now);
  return verifiedState && typeof state === 'string'
    ? deriveMalCodeVerifier(state, secret)
    : null;
}


export function createSimklV2OAuthTransaction(
  secret: string,
  ttlMs: number,
  now: number = Date.now()
): { state: string; codeVerifier: string } {
  const state = createSignedOAuthState('Simkl', secret, ttlMs, SIMKL_V2_STATE_HMAC_DOMAIN, now);
  return { state, codeVerifier: deriveCodeVerifier(state, secret, SIMKL_V2_PKCE_VERIFIER_DOMAIN) };
}

export function verifySimklV2OAuthState(
  state: unknown,
  secret: string,
  now: number = Date.now()
): string | null {
  const verifiedState = verifySignedOAuthState(state, secret, SIMKL_V2_STATE_HMAC_DOMAIN, now);
  return verifiedState && typeof state === 'string'
    ? deriveCodeVerifier(state, secret, SIMKL_V2_PKCE_VERIFIER_DOMAIN)
    : null;
}
