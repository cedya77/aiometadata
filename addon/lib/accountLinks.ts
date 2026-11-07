import consola from 'consola';
import { ACCOUNT_SERVICES, type AccountService } from './accounts';

const database: any = require('./database');
const logger = consola.withTag('AccountLinks');

// Where a configuration keeps an id into the token table.
const TOKEN_FIELDS = ['simklTokenId', 'malTokenId', 'anilistTokenId', 'traktTokenId', 'movieLensCredId'];

export function revokeSimklGrant(token: string): void {
  const simklAuth = require('./simkl');
  const { clientId, clientSecret } = simklAuth.simklV2Credentials();
  if (!clientId || !token) return;
  simklAuth.revokeSimklV2Token(clientId, clientSecret, token)
    .catch((error: any) => logger.debug(`Could not revoke a replaced Simkl grant: ${error?.message}`));
}

/** Deletes a token row once no configuration or user refers to it. */
export async function releaseTokenIfUnused(service: AccountService, tokenId: string, revoke?: (refreshToken: string) => void): Promise<boolean> {
  return releaseFieldToken(ACCOUNT_SERVICES[service].key, tokenId, revoke);
}

export async function releaseFieldToken(field: string, tokenId: string, revoke?: (refreshToken: string) => void): Promise<boolean> {
  let refs;
  try {
    refs = await database.findTokenReferences(field, [tokenId]);
  } catch (error: any) {
    logger.warn(`Kept ${field} token: could not check who still uses it: ${error?.message}`);
    return false;
  }
  if (refs.length) return false;
  const held = await database.getOAuthToken(tokenId).catch(() => null);
  if (held?.refresh_token && revoke) revoke(held.refresh_token);
  await database.deleteOAuthToken(tokenId);
  return true;
}

/** After a configuration is deleted: its tokens go, and those another configuration shares stay. */
export async function releaseConfigTokens(config: any): Promise<void> {
  const cards = Array.isArray(config?.jellyfinUsers) ? config.jellyfinUsers : [];
  for (const field of TOKEN_FIELDS) {
    const ids = new Set<string>([config?.apiKeys?.[field], ...cards.map((card: any) => card?.accounts?.apiKeys?.[field])].filter((id) => typeof id === 'string' && id));
    for (const id of ids) await releaseFieldToken(field, id, field === 'simklTokenId' ? revokeSimklGrant : undefined);
  }
  const managers = Array.isArray(config?.managerAccounts) ? config.managerAccounts : [];
  for (const account of managers) {
    if (typeof account?.keyId === 'string' && account.keyId) await database.deleteOAuthToken(account.keyId);
  }
}
