// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import crypto from 'crypto';
// @ts-ignore
import { cacheWrapGlobal } from '../lib/getCache';
// @ts-ignore
import anilist from '../lib/anilist';
// @ts-ignore
import database from '../lib/database';
// @ts-ignore
import { consola } from 'consola';
import { slotServiceOf } from '../lib/accounts';

const logger = consola.withTag('anilist-utils');

/** Whose list a catalog reads, and the token to read it with; on an AniList slot with no named user, whoever owns the token. */
export async function anilistListAccess(config: any, catalog: { id?: string; metadata?: any }): Promise<{ username?: string; accessToken?: string }> {
  const tokenId = config?.apiKeys?.anilistTokenId;
  const row = tokenId ? await database.getOAuthToken(tokenId).catch(() => null) : null;
  const accessToken = row?.access_token || undefined;
  const named = catalog?.metadata?.username;
  if (slotServiceOf(catalog) !== 'anilist' || (!config?.jellyfinAccounts && named)) return { username: named, accessToken };
  return { username: row?.provider === 'anilist' && row.user_id ? String(row.user_id) : undefined, accessToken };
}

export async function getAnilistAccessToken(config: any): Promise<string | undefined> {
  const tokenId = config?.apiKeys?.anilistTokenId;
  if (!tokenId) return undefined;
  try {
    const token = await database.getOAuthToken(tokenId);
    return token?.access_token || undefined;
  } catch {
    return undefined;
  }
}

/** A configuration that has never been saved has no row to load, so the browser
 *  passes the token id the connect flow handed it. */
export async function getAnilistAccessTokenById(tokenId?: string): Promise<string | undefined> {
  if (!tokenId) return undefined;
  try {
    const token = await database.getOAuthToken(tokenId);
    if (!token || token.provider !== 'anilist') return undefined;
    return token.access_token || undefined;
  } catch {
    return undefined;
  }
}

export async function resolveAnilistAccessToken(source: { tokenId?: string; userUUID?: string }): Promise<string | undefined> {
  const direct = await getAnilistAccessTokenById(source.tokenId);
  if (direct) return direct;
  if (!source.userUUID) return undefined;
  const { loadConfigFromDatabase }: any = require('../lib/configApi');
  const config = await loadConfigFromDatabase(source.userUUID).catch(() => null);
  return getAnilistAccessToken(config);
}

export async function getAnilistWatchedIds(config: any): Promise<{ anilistIds: Set<number>, malIds: Set<number> } | null> {
  try {
    const anilistTokenId = config.apiKeys?.anilistTokenId;
    if (!anilistTokenId) return null;

    const tokenData = await database.getOAuthToken(anilistTokenId);
    if (!tokenData || !tokenData.user_id) return null;
    
    const username = tokenData.user_id;

    const cacheKey = `anilist_completed_ids:${username}`;
    const watchedData = await cacheWrapGlobal(cacheKey, async () => {
      let page = 1;
      let hasMore = true;
      const anilistIds: number[] = [];
      const malIds: number[] = [];
      
      while (hasMore && page <= 10) {
        const response = await anilist.fetchListItems(username, 'Completed', page, 500, 'ADDED_TIME_DESC', tokenData.access_token);
        
        if (response && response.items) {
          for (const item of response.items) {
            if (item?.media?.id) anilistIds.push(item.media.id);
            if (item?.media?.idMal) malIds.push(item.media.idMal);
          }
        }
        
        hasMore = response?.hasMore || false;
        page++;
      }
      
      logger.info(`[Watched IDs] Fetched ${anilistIds.length} completed items from AniList for ${username}`);
      return { anilistIds, malIds };
    }, 86400);

    return {
      anilistIds: new Set(watchedData.anilistIds),
      malIds: new Set(watchedData.malIds)
    };
  } catch (err: any) {
    logger.warn(`[Watched IDs] Error fetching AniList completed IDs: ${err.message}`);
    return null;
  }
}
