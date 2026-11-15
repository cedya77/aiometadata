// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
const database: any = require('./database');
const movielens: any = require('./movielens');
const imp: any = require('./movielensImport');
const mdbList: any = require('../utils/mdbList');
const traktUtils: any = require('../utils/traktUtils');
const simklUtils: any = require('../utils/simklUtils');
const consola: any = require('consola');
const crypto: any = require('crypto');

const logger = consola.withTag('movielens-sync');

/**
 * Bumped when a fix means older cursors have holes in them. The next sync on an
 * older cursor runs full, then resumes incrementally.
 */
const CURSOR_VERSION = 2;

/**
 * Identifies what a source contributed, so we only make MovieLens swallow an
 * import when something actually moved. A source that threw or was skipped
 * reports null, and its previous print carries forward rather than a degraded
 * pull looking like a change and costing an import in both directions.
 */
/** Every source must hand back a full snapshot for its print to compare across runs. */
function fingerprint(ratings: any[]): string {
  const pairs = ratings.map((r: any) => `${r.imdb}:${r.rating}`).sort();
  return crypto.createHash('sha1').update(pairs.join('|')).digest('hex');
}

function stablePrints(prints: Record<string, string>): string {
  return Object.keys(prints).sort().map((k) => `${k}=${prints[k]}`).join(',');
}

async function getCursor(credId: string): Promise<any> {
  const row = await database.getOAuthToken(credId);
  if (!row) return null;
  try { return JSON.parse(row.scope || '{}'); } catch { return {}; }
}

async function setCursor(credId: string, cursor: any): Promise<void> {
  const row = await database.getOAuthToken(credId);
  if (!row) return;
  await database.saveOAuthToken(
    credId, 'movielens', row.user_id, row.access_token, row.refresh_token, row.expires_at, JSON.stringify(cursor)
  );
}

async function gatherRatings(
  config: any,
  since?: string,
): Promise<{ merged: any[]; perSource: Record<string, number>; prints: Record<string, string | null> }> {
  const lists: any[][] = [];
  const perSource: Record<string, number> = {};
  const prints: Record<string, string | null> = {};

  const traktTokenId = config?.apiKeys?.traktTokenId;
  if (traktTokenId) {
    prints.trakt = null;
    try {
      const tok = await database.getOAuthToken(traktTokenId);
      if (tok?.access_token) {
        let pull = true;
        if (since) {
          const activity = await traktUtils.fetchTraktLastActivity(tok.access_token);
          const ratedAt = activity?.movies?.rated_at;
          pull = !ratedAt || ratedAt > since;
        }
        if (pull) {
          const norm = imp.fromMovieRatingItems(await traktUtils.getTraktRatings(tok.access_token));
          lists.push(norm);
          perSource.trakt = norm.length;
          prints.trakt = fingerprint(norm);
        } else {
          perSource.trakt = 0;
        }
      }
    } catch (e: any) { logger.warn(`Trakt ratings fetch failed: ${e.message}`); }
  }

  const simklTokenId = config?.apiKeys?.simklTokenId;
  if (simklTokenId) {
    prints.simkl = null;
    try {
      const tok = await simklUtils.getSimklToken(simklTokenId);
      if (tok?.access_token) {
        const [movies, anime] = await Promise.all([
          simklUtils.getSimklRatings(tok.access_token, 'movies'),
          simklUtils.getSimklRatings(tok.access_token, 'anime'),
        ]);
        const norm = [...imp.fromSimklRatings(movies), ...imp.fromSimklRatings(anime)];
        lists.push(norm);
        perSource.simkl = norm.length;
        prints.simkl = norm.length ? fingerprint(norm) : null;
      }
    } catch (e: any) { logger.warn(`Simkl ratings fetch failed: ${e.message}`); }
  }

  const mdblistKey = config?.apiKeys?.mdblist;
  if (mdblistKey) {
    prints.mdblist = null;
    try {
      const norm = imp.fromMovieRatingItems(await mdbList.getRatingsFromMDBList(mdblistKey));
      lists.push(norm);
      perSource.mdblist = norm.length;
      prints.mdblist = fingerprint(norm);
    } catch (e: any) { logger.warn(`MDBList ratings fetch failed: ${e.message}`); }
  }

  return { merged: imp.mergeRatings(...lists), perSource, prints };
}

async function syncMovieLensAccount(config: any, opts: { full?: boolean; cooldownSeconds?: number } = {}): Promise<any> {
  const credId = config?.apiKeys?.movieLensCredId;
  if (!credId) return { ok: false, reason: 'not-connected' };

  const cursor = (await getCursor(credId)) || {};

  if (opts.cooldownSeconds && cursor.lastSyncAt) {
    const elapsed = (Date.now() - new Date(cursor.lastSyncAt).getTime()) / 1000;
    if (elapsed < opts.cooldownSeconds) {
      return { ok: false, reason: 'cooldown', nextAllowedInSeconds: Math.ceil(opts.cooldownSeconds - elapsed) };
    }
  }

  const stale = cursor.version !== CURSOR_VERSION;
  const since = (opts.full || stale) ? undefined : cursor.lastSyncAt;
  if (stale && cursor.lastSyncAt) {
    logger.info(`Cursor for ${credId} predates version ${CURSOR_VERSION}, running a full pull`);
  }

  const { merged, perSource, prints } = await gatherRatings(config, since);

  const previous = cursor.ratingsPrints || {};
  const current: Record<string, string> = {};
  for (const [source, print] of Object.entries(prints)) {
    const resolved = print ?? previous[source];
    if (resolved) current[source] = resolved;
  }
  const failed = Object.keys(prints).filter((s) => prints[s] === null && previous[s]);
  if (failed.length) {
    logger.warn(`Carrying forward the last known state for ${failed.join(', ')} on ${credId}`);
  }

  const unchanged = !opts.full && stablePrints(current) === stablePrints(previous);
  const nextCursor = {
    ...cursor, version: CURSOR_VERSION, ratingsPrints: current, lastSyncAt: new Date().toISOString(),
  };

  if (!merged.length || unchanged) {
    await setCursor(credId, nextCursor);
    return { ok: true, imported: 0, perSource, note: 'no new ratings' };
  }

  const { csv, count } = imp.normalizedToImdbCsv(merged);
  const result = await movielens.importImdbCsv(credId, csv);
  await setCursor(credId, nextCursor);

  const rejected = Number.isFinite(result.errorCount) ? `, ${result.errorCount} rejected` : '';
  logger.info(
    `Synced ${credId}: sent ${count} ratings, MovieLens reports ${result.successCount} new, ` +
    `${result.alreadyRatedCount} already rated${rejected}`
  );
  return { ok: true, sent: count, ...result, perSource };
}

async function bootstrapMovieLensAccount(config: any): Promise<any> {
  return syncMovieLensAccount(config, { full: true });
}

async function syncAllMovieLensAccounts(): Promise<{ processed: number; synced: number }> {
  const uuids: string[] = await database.getAllUserUUIDs();
  let processed = 0;
  let synced = 0;
  for (const uuid of uuids) {
    try {
      const raw = await database.getUserConfig(uuid);
      const config = raw?.config_data ? JSON.parse(raw.config_data) : raw;
      if (!config?.apiKeys?.movieLensCredId) continue;
      processed++;
      const res = await syncMovieLensAccount(config, { full: false });
      if (res.ok && (res.successCount || 0) > 0) synced++;
    } catch (e: any) {
      logger.warn(`MovieLens sync failed for ${uuid}: ${e.message}`);
    }
  }
  logger.info(`MovieLens re-sync pass: ${processed} accounts checked, ${synced} received new ratings`);
  return { processed, synced };
}

export {
  gatherRatings,
  syncMovieLensAccount,
  bootstrapMovieLensAccount,
  syncAllMovieLensAccounts,
};
module.exports = {
  gatherRatings,
  syncMovieLensAccount,
  bootstrapMovieLensAccount,
  syncAllMovieLensAccounts,
};
