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
      
      logger.debug('Simkl token exchange response:', JSON.stringify(data, null, 2));

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