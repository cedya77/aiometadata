// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
const consola = require('consola');
const { httpGet, httpPost } = require('../utils/httpClient.js');

const logger = consola.withTag('Simkl');

export const SIMKL_API_BASE = 'https://api.simkl.com';

export interface SimklTokens {
  access_token: string;
  // Note: Simkl access tokens never expire, no refresh_token
}

export interface SimklUser {
  username: string;
  name?: string;
  // Add other user fields as needed
}

export class SimklClient {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor(clientId: string, clientSecret?: string, redirectUri?: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret ?? '';
    this.redirectUri = redirectUri ?? '';
  }

  /**
   * Get authorization URL for OAuth flow
   */
  getAuthorizationUrl(state?: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
    });

    if (state) {
      params.append('state', state);
    }

    return `https://simkl.com/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   * Note: Simkl tokens never expire
   */
  async exchangeCodeForToken(code: string): Promise<SimklTokens> {
    try {
      const response = await httpPost('https://api.simkl.com/oauth/token', {
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
      });

      const data = response.data;

      logger.debug('Simkl token exchange response:', JSON.stringify(
        data,
        (key, value) =>
          (key === 'access_token' || key === 'refresh_token') && typeof value === 'string'
            ? '[REDACTED]'
            : value,
        2
      ));

      return {
        access_token: data.access_token,
      };
    } catch (error) {
      logger.error('Failed to exchange code for token:', error);
      throw error;
    }
  }

  /**
   * Get current user information
   */
  async getMe(accessToken: string): Promise<SimklUser> {
    try {
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'simkl-api-key': this.clientId,
      };

      // Simkl API endpoint for user settings/info
      // Try /users/settings endpoint first
      let response;
      let data;
      
      try {
        response = await httpGet(`${SIMKL_API_BASE}/users/settings`, { headers });
        data = response.data;
        logger.debug('Simkl /users/settings response:', JSON.stringify(data, null, 2));
      } catch (settingsError: any) {
        // If /users/settings fails, try /user (singular) as fallback
        logger.debug('Simkl /users/settings failed, trying /user:', settingsError.message);
        response = await httpGet(`${SIMKL_API_BASE}/user`, { headers });
        data = response.data;
        logger.debug('Simkl /user response:', JSON.stringify(data, null, 2));
      }

      if (!data) {
        logger.error('Simkl API returned null/undefined data');
        throw new Error('Simkl API returned no data');
      }

      const accountId = data?.account?.id;
      const userName = data?.user?.name || data?.name || '';
      
      const username = accountId ? String(accountId) : userName;
      const name = data?.user?.name || data?.name || data?.account?.name;

      if (!username) {
        logger.warn('No user identifier found in Simkl API response. Full response:', JSON.stringify(data, null, 2));
        throw new Error('Unable to retrieve user identifier from Simkl API');
      }

      return {
        username,
        name,
      };
    } catch (error) {
      logger.error('Failed to get user info:', error);
      throw error;
    }
  }

  /**
   * Revoke access token
   * Note: Simkl may not have a revoke endpoint, this is a placeholder
   */
  async revokeToken(accessToken: string): Promise<void> {
    try {
      // Simkl tokens can be revoked by user in Connected Apps settings
      // If there's a revoke endpoint, add it here
      logger.info('Token revoke requested - user should revoke in Simkl Connected Apps settings');
    } catch (error) {
      logger.error('Failed to revoke token:', error);
      throw error;
    }
  }

  /**
   * Get user's watchlist or lists
   * Add more methods as needed based on Simkl API documentation
   */
  async getUserLists(accessToken: string): Promise<any[]> {
    try {
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'simkl-api-key': this.clientId,
      };

      // Adjust endpoint based on actual Simkl API
      const response = await httpGet(`${SIMKL_API_BASE}/sync/all-items`, { headers });
      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      logger.error('Failed to get user lists:', error);
      throw error;
    }
  }
}
// A V2 token only works with the client id it was issued to.
export const SIMKL_V2_TOKEN_PREFIX = 'simkl_at_';
export const SIMKL_V2_ISSUER = 'https://simkl.com';
const SIMKL_V2_SCOPE = 'media:read media:write';

export interface SimklV2Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}

export function isSimklV2Token(accessToken: unknown): boolean {
  return typeof accessToken === 'string' && accessToken.startsWith(SIMKL_V2_TOKEN_PREFIX);
}

export function simklV2Credentials(): { clientId: string; clientSecret: string } {
  const { getSetting } = require('./settingsService');
  return {
    clientId: String(getSetting('SIMKL_V2_CLIENT_ID') || '').trim(),
    clientSecret: String(getSetting('SIMKL_V2_CLIENT_SECRET') || '').trim(),
  };
}

export type SimklAuthMode = 'oauth' | 'pin' | 'both';

/**
 * Which ways of connecting Simkl this instance offers. An unset or unknown
 * SIMKL_AUTH_MODE offers OAuth only when the matching client secret exists.
 */
export function simklAuthMode(): SimklAuthMode {
  const { getSetting } = require('./settingsService');
  const configured = String(getSetting('SIMKL_AUTH_MODE') || '').trim().toLowerCase();
  if (configured === 'oauth' || configured === 'pin' || configured === 'both') return configured;
  const v2 = simklV2Credentials();
  if (v2.clientId) return v2.clientSecret ? 'oauth' : 'pin';
  return String(getSetting('SIMKL_CLIENT_SECRET') || '').trim() ? 'oauth' : 'pin';
}

export function simklCodeFlowOffered(mode: SimklAuthMode = simklAuthMode()): boolean {
  return mode === 'pin' || mode === 'both';
}

export function simklClientIdFor(accessToken?: string | null): string {
  if (isSimklV2Token(accessToken)) return simklV2Credentials().clientId;
  return String(process.env.SIMKL_CLIENT_ID || '').trim() || simklV2Credentials().clientId;
}

async function postForm(path: string, form: Record<string, string>, clientSecret = ''): Promise<{ status: number; data: any }> {
  const body = new URLSearchParams(form);
  if (clientSecret) body.set('client_secret', clientSecret);
  const buildInfo = require('./buildInfo');
  const response = await fetch(`${SIMKL_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'User-Agent': `AIOMetadata/${buildInfo?.version || '1.0'}`,
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: 'invalid_response', error_description: text.slice(0, 200) };
  }
  return { status: response.status, data };
}

function readTokens(data: any): SimklV2Tokens {
  if (!data?.access_token || !data?.refresh_token) {
    throw new Error(`Simkl returned no token (${data?.error || 'empty response'})`);
  }
  return {
    access_token: String(data.access_token),
    refresh_token: String(data.refresh_token),
    expires_in: Number(data.expires_in) || 604800,
    scope: String(data.scope || ''),
  };
}

function oauthError(action: string, status: number, data: any): Error {
  const error: any = new Error(`Simkl ${action} failed (HTTP ${status}${data?.error ? `, ${data.error}` : ''})`);
  error.status = status;
  error.code = data?.error;
  return error;
}

export function simklV2AuthorizationUrl(clientId: string, redirectUri: string, state: string, codeVerifier: string): string {
  const crypto = require('crypto');
  const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SIMKL_V2_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${SIMKL_V2_ISSUER}/oauth2/authorize?${params.toString()}`;
}

export async function exchangeSimklV2Code(clientId: string, clientSecret: string, code: string, redirectUri: string, codeVerifier: string): Promise<SimklV2Tokens> {
  const { status, data } = await postForm('/oauth2/token', {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  }, clientSecret);
  if (status < 200 || status >= 300) throw oauthError('code exchange', status, data);
  return readTokens(data);
}

export async function refreshSimklV2Token(clientId: string, clientSecret: string, refreshToken: string): Promise<SimklV2Tokens> {
  const { status, data } = await postForm('/oauth2/token', {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  }, clientSecret);
  if (status < 200 || status >= 300) throw oauthError('token refresh', status, data);
  return readTokens(data);
}

// Simkl answers 200 whether or not anything was revoked.
export async function revokeSimklV2Token(clientId: string, clientSecret: string, token: string): Promise<void> {
  await postForm('/oauth2/revoke', { client_id: clientId, token }, clientSecret);
}

export function simklV2ScopeWrites(scope: string): boolean {
  return String(scope || '').split(/\s+/).includes('media:write');
}

// --- Code sign-in (V1 PIN and V2 device flow) ---

const SIMKL_PIN_PAGE = 'https://simkl.com/pin';

export interface SimklDeviceCode {
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
  /** Only the V2 flow has one; V1 polls by the user code. */
  deviceCode?: string;
}

export type SimklCodePoll =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  | { status: 'authorized'; accessToken: string; tokens?: SimklV2Tokens };

/** An error whose message is written for the person connecting, so a route may show it as is. */
export function userSafeError(message: string): Error {
  const error: any = new Error(message);
  error.userSafe = true;
  return error;
}

export function isUserSafeError(error: unknown): boolean {
  return Boolean(error && (error as any).userSafe === true);
}

/** Simkl's error bodies come back from the HTTP client as text. */
function readBody(data: unknown): any {
  if (typeof data !== 'string') return data ?? null;
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function positiveSeconds(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function rejectedClientIdError(): Error {
  return userSafeError('Simkl rejected the client id this instance is configured with. The instance owner should check SIMKL_CLIENT_ID.');
}

function v2ClientIdInV1SlotError(): Error {
  return userSafeError('This client id belongs to a Simkl AUTH V2 app. The instance owner should set it as SIMKL_V2_CLIENT_ID instead of SIMKL_CLIENT_ID.');
}

function failForPinError(status: number | undefined, body: any): void {
  if (status === 401 || status === 403 || body?.error === 'client_id_failed') {
    logger.error(`Simkl rejected the client credentials when asked for a PIN (HTTP ${status ?? 'n/a'}${body?.error ? `, ${body.error}` : ''})`);
    throw rejectedClientIdError();
  }
  if (body?.error === 'unauthorized_client') {
    logger.error('Simkl refused a PIN for SIMKL_CLIENT_ID: it is the id of an AUTH V2 app');
    throw v2ClientIdInV1SlotError();
  }
}

/** Asks Simkl's V1 PIN endpoint for a code the user enters at simkl.com/pin. */
export async function requestSimklPin(clientId: string): Promise<SimklDeviceCode> {
  let body: any;
  try {
    const response = await httpGet(`${SIMKL_API_BASE}/oauth/pin?client_id=${encodeURIComponent(clientId)}`);
    body = readBody(response.data);
  } catch (error: any) {
    failForPinError(error?.response?.status, readBody(error?.response?.data));
    throw error;
  }

  failForPinError(undefined, body);
  if (body?.result !== 'OK' || !body?.user_code) {
    logger.warn('Unexpected Simkl PIN response:', JSON.stringify(body));
    throw new Error('Simkl did not return a PIN');
  }
  return {
    userCode: String(body.user_code),
    verificationUrl: String(body.verification_url || body.verification_uri || SIMKL_PIN_PAGE),
    expiresIn: positiveSeconds(body.expires_in, 900),
    interval: positiveSeconds(body.interval, 5),
  };
}

/** Asks Simkl whether the V1 PIN has been approved yet. */
export async function pollSimklPin(clientId: string, userCode: string): Promise<SimklCodePoll> {
  let body: any;
  try {
    const response = await httpGet(`${SIMKL_API_BASE}/oauth/pin/${encodeURIComponent(userCode)}?client_id=${encodeURIComponent(clientId)}`);
    body = readBody(response.data);
  } catch (error: any) {
    const status = error?.response?.status;
    if (status === 401 || status === 403) {
      // A configuration problem, not a slow user: polling again cannot fix it.
      logger.error(`Simkl rejected the PIN status check (HTTP ${status}); check SIMKL_CLIENT_ID`);
      throw error;
    }
    if (status === 429) return { status: 'slow_down' };
    logger.debug(`Simkl PIN status check failed, still pending: ${error?.message || error}`);
    return { status: 'pending' };
  }

  // Simkl answers a code it no longer knows by minting a fresh one. Read as
  // pending, that would mint another code on every poll.
  if (body?.device_code) return { status: 'expired' };
  if (body?.result === 'OK' && body?.access_token) {
    return { status: 'authorized', accessToken: String(body.access_token) };
  }
  if (/slow down/i.test(String(body?.message || ''))) return { status: 'slow_down' };
  return { status: 'pending' };
}

/** Starts Simkl's V2 device flow. */
export async function requestSimklV2DeviceCode(clientId: string): Promise<SimklDeviceCode> {
  const { status, data } = await postForm('/oauth2/device', { client_id: clientId, scope: SIMKL_V2_SCOPE });
  if (status >= 200 && status < 300 && data?.device_code && data?.user_code) {
    return {
      deviceCode: String(data.device_code),
      userCode: String(data.user_code),
      verificationUrl: String(data.verification_uri_complete || data.verification_uri || SIMKL_PIN_PAGE),
      expiresIn: positiveSeconds(data.expires_in, 900),
      interval: positiveSeconds(data.interval, 5),
    };
  }
  logger.warn(`Simkl V2 device code request failed (HTTP ${status}):`, JSON.stringify(data));
  throw oauthError('device code request', status, data);
}

/** Asks Simkl whether the V2 device code has been approved yet. */
export async function pollSimklV2DeviceToken(clientId: string, deviceCode: string): Promise<SimklCodePoll> {
  let result: { status: number; data: any };
  try {
    result = await postForm('/oauth2/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: deviceCode,
    });
  } catch (error: any) {
    logger.debug(`Simkl V2 device token check failed, still pending: ${error?.message || error}`);
    return { status: 'pending' };
  }

  const { status, data } = result;
  if (status >= 200 && status < 300) {
    const tokens = readTokens(data);
    return { status: 'authorized', accessToken: tokens.access_token, tokens };
  }
  if (status === 401) throw oauthError('device token check', status, data);
  if (data?.error === 'slow_down' || status === 429) return { status: 'slow_down' };
  if (data?.error === 'expired_token') return { status: 'expired' };
  return { status: 'pending' };
}
