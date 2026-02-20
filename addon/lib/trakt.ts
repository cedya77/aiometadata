const consola = require('consola');
const { httpGet, httpPost } = require('../utils/httpClient.js');

const logger = consola.withTag('Trakt');

export const TRAKT_API_BASE = 'https://api.trakt.tv';
export const TRAKT_API_VERSION = '2';

export interface TraktTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  token_type: string;
}

export interface TraktUser {
  username: string;
  private: boolean;
  name: string;
  vip: boolean;
  vip_ep: boolean;
}

export class TraktClient {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor(clientId: string, clientSecret: string, redirectUri: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
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

    return `https://trakt.tv/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code: string): Promise<TraktTokens> {
    try {
      const response = await httpPost('https://api.trakt.tv/oauth/token', {
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
      }, {
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': TRAKT_API_VERSION,
          'trakt-api-key': this.clientId,
          'User-Agent': `AIOMetadata/${process.env.npm_package_version || '1.0.0'}`
        }
      });

      const data = response.data;

      // Calculate expires_at timestamp
      const expiresAt = Date.now() + (data.expires_in * 1000);

      return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: expiresAt,
        scope: data.scope,
        token_type: data.token_type,
      };
    } catch (error) {
      if (error.response?.data) {
        logger.error(`Trakt OAuth Error Body: ${typeof error.response.data === 'object' ? JSON.stringify(error.response.data) : error.response.data}`);
      }
      logger.error('Failed to exchange code for token:', error);
      throw error;
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(refreshToken: string): Promise<TraktTokens> {
    try {
      const response = await httpPost('https://api.trakt.tv/oauth/token', {
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: 'refresh_token',
      }, {
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': TRAKT_API_VERSION,
          'trakt-api-key': this.clientId,
          'User-Agent': `AIOMetadata/${process.env.npm_package_version || '1.0.0'}`
        }
      });

      const data = response.data;

      // Calculate expires_at timestamp
      const expiresAt = Date.now() + (data.expires_in * 1000);

      return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: expiresAt,
        scope: data.scope,
        token_type: data.token_type,
      };
    } catch (error) {
      logger.error('Failed to refresh access token:', error);
      throw error;
    }
  }

  /**
   * Get current user information
   */
  async getMe(accessToken: string): Promise<TraktUser> {
    try {
      const headers = {
        'Content-Type': 'application/json',
        'trakt-api-version': TRAKT_API_VERSION,
        'trakt-api-key': this.clientId,
        'Authorization': `Bearer ${accessToken}`,
      };

      const response = await httpGet(`${TRAKT_API_BASE}/users/me`, { headers });
      const data = response.data;

      return {
        username: data.username,
        private: data.private,
        name: data.name,
        vip: data.vip,
        vip_ep: data.vip_ep,
      };
    } catch (error) {
      logger.error('Failed to get user info:', error);
      throw error;
    }
  }

  /**
   * Revoke access token
   */
  async revokeToken(accessToken: string): Promise<void> {
    try {
      await httpPost('https://api.trakt.tv/oauth/revoke', {
        token: accessToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      });
    } catch (error) {
      logger.error('Failed to revoke token:', error);
      throw error;
    }
  }

  /**
   * Get list information by username and slug
   */
  async getListBySlug(username: string, listSlug: string, accessToken?: string): Promise<any> {
    try {
      const headers = {
        'Content-Type': 'application/json',
        'trakt-api-version': TRAKT_API_VERSION,
        'trakt-api-key': this.clientId,
        ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {}),
      };

      const response = await httpGet(`${TRAKT_API_BASE}/users/${username}/lists/${listSlug}`, { headers });
      return response.data;
    } catch (error) {
      logger.error(`Failed to get list ${username}/${listSlug}:`, error);
      throw error;
    }
  }

  /**
   * Get list information by list ID (integer)
   */
  async getList(listId: string | number, accessToken?: string): Promise<any> {
    try {
      const headers = {
        'Content-Type': 'application/json',
        'trakt-api-version': TRAKT_API_VERSION,
        'trakt-api-key': this.clientId,
        ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {}),
      };

      const response = await httpGet(`${TRAKT_API_BASE}/lists/${listId}`, { headers });
      return response.data;
    } catch (error) {
      logger.error(`Failed to get list ${listId}:`, error);
      throw error;
    }
  }

  /**
   * Get all lists from a Trakt user
   */
  async getUserLists(username: string, accessToken?: string): Promise<any[]> {
    try {
      const headers = {
        'Content-Type': 'application/json',
        'trakt-api-version': TRAKT_API_VERSION,
        'trakt-api-key': this.clientId,
        ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {}),
      };

      const response = await httpGet(`${TRAKT_API_BASE}/users/${username}/lists`, { headers });
      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      logger.error(`Failed to get lists for user ${username}:`, error);
      throw error;
    }
  }
}
