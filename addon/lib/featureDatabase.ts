// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
//
// The storage behind the v4 feature modules (Jellyfin server, trackers,
// dashboard): their tables, migrations and queries, on top of the core store.
import consola from 'consola';
import { envInt } from '../utils/envNumber';
import { DatabaseCore, PLAYSTATE_KEY_BATCH } from './databaseCore';

const logger = consola.withTag('Database');

export class FeatureDatabase extends DatabaseCore {
  protected async deleteFeatureData(userUUID: string): Promise<void> {
    await this.deleteCalendarFeed(userUUID, null).catch(() => undefined);
    await this.deleteTrackerMatches(userUUID).catch(() => undefined);
    await this.deleteLeftOut(userUUID).catch(() => undefined);
    await this.deleteHistoryImport(userUUID).catch(() => undefined);
    await this.deleteTrackerTrail(userUUID).catch(() => undefined);
    await this.deleteYearReviews(userUUID).catch(() => undefined);
    await this.deleteViewingData(userUUID).catch((error: any) =>
      logger.error(`Viewing data of ${userUUID} was not fully deleted: ${error?.message || error}`)
    );
  }

  async createTables(): Promise<void> {
    await super.createTables();
    const queries = this.type === 'sqlite' ? FEATURE_SQLITE_TABLES : FEATURE_POSTGRES_TABLES;
    for (const query of queries) {
      await this.runQuery(query);
    }
    await this.ensurePlaystateKind();
    await this.ensureCopyJobColumns();
    await this.ensureLeftOutKey();
    await this.ensureFingerprintContributor();
  }

  async ensureFingerprintContributor(): Promise<void> {
    try {
      if (this.type === 'sqlite') {
        const existing = await this.allQuery(`PRAGMA table_info(jellyfin_fingerprints)`);
        if (existing.some((column: any) => column.name === 'contributor')) return;
        await this.runQuery(`ALTER TABLE jellyfin_fingerprints ADD COLUMN contributor TEXT`);
        logger.info('Migrated jellyfin_fingerprints: rows record who posted them');
      } else {
        await this.runQuery(`ALTER TABLE jellyfin_fingerprints ADD COLUMN IF NOT EXISTS contributor TEXT`);
      }
    } catch (error: any) {
      logger.warn(`Could not add jellyfin_fingerprints.contributor: ${error.message}`);
    }
  }

  /** A title left out is left out for one profile's import, which the first table did not key by. */
  async ensureLeftOutKey(): Promise<void> {
    try {
      const columns = this.type === 'sqlite'
        ? (await this.allQuery(`PRAGMA table_info(tracker_left_out)`)).map((c: any) => c.name)
        : (await this.allQuery(`SELECT column_name FROM information_schema.columns WHERE table_name = 'tracker_left_out'`)).map((c: any) => c.column_name);
      if (!columns.length || columns.includes('profile')) return;
      const sqlite = this.type === 'sqlite';
      await this.runQuery(`ALTER TABLE tracker_left_out RENAME TO tracker_left_out_v1`);
      if (!sqlite) await this.runQuery(`ALTER TABLE tracker_left_out_v1 RENAME CONSTRAINT tracker_left_out_pkey TO tracker_left_out_v1_pkey`);
      await this.runQuery(`CREATE TABLE tracker_left_out (
        user_uuid ${sqlite ? 'TEXT' : 'VARCHAR(64)'} NOT NULL,
        source_key ${sqlite ? 'TEXT' : 'VARCHAR(64)'} NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        origin ${sqlite ? 'TEXT' : 'VARCHAR(32)'} NOT NULL,
        video_id TEXT NOT NULL,
        left_at ${sqlite ? 'INTEGER' : 'BIGINT'} NOT NULL,
        PRIMARY KEY (user_uuid, source_key, profile, origin, video_id)
      )`);
      // A row goes to each profile that holds that title from that import, and to the main profile when none does.
      await this.runQuery(`INSERT INTO tracker_left_out (user_uuid, source_key, profile, origin, video_id, left_at)
        SELECT DISTINCT v.user_uuid, v.source_key, COALESCE(h.profile, ''), v.origin, v.video_id, v.left_at FROM tracker_left_out_v1 v
        LEFT JOIN (SELECT user_uuid, profile, video_id, origin FROM jellyfin_watches UNION SELECT user_uuid, profile, video_id, origin FROM jellyfin_playstate) h
          ON h.user_uuid = v.user_uuid AND h.video_id = v.video_id AND h.origin = v.origin`);
      await this.runQuery(`DROP TABLE tracker_left_out_v1`);
      logger.info('Migrated tracker_left_out: rows keyed by profile and import');
    } catch (error: any) {
      logger.warn(`Could not key tracker_left_out by profile: ${error.message}`);
    }
  }

  async ensurePlaystateKind(): Promise<void> {
    try {
      if (this.type === 'sqlite') {
        const existing = await this.allQuery(`PRAGMA table_info(jellyfin_playstate)`);
        if (!existing.some((column: any) => column.name === 'last_played_kind')) {
          await this.runQuery(`ALTER TABLE jellyfin_playstate ADD COLUMN last_played_kind TEXT`);
          logger.info('Migrated jellyfin_playstate: rows record whether their last played date is a viewing or a mark');
        }
      } else {
        await this.runQuery(`ALTER TABLE jellyfin_playstate ADD COLUMN IF NOT EXISTS last_played_kind TEXT`);
      }
    } catch (error: any) {
      logger.warn(`Could not add jellyfin_playstate.last_played_kind: ${error.message}`);
    }
  }

  async ensureCopyJobColumns(): Promise<void> {
    const added: Array<[string, string, string]> = [
      ['claimed_until', 'INTEGER NOT NULL DEFAULT 0', 'BIGINT NOT NULL DEFAULT 0'],
      ['stalls', 'INTEGER NOT NULL DEFAULT 0', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [name, sqliteType, postgresType] of added) {
      try {
        if (this.type === 'sqlite') {
          const existing = await this.allQuery(`PRAGMA table_info(tracker_copy_jobs)`);
          if (!existing.length || existing.some((column: any) => column.name === name)) continue;
          await this.runQuery(`ALTER TABLE tracker_copy_jobs ADD COLUMN ${name} ${sqliteType}`);
        } else {
          await this.runQuery(`ALTER TABLE tracker_copy_jobs ADD COLUMN IF NOT EXISTS ${name} ${postgresType}`);
        }
      } catch (error: any) {
        logger.warn(`Could not add tracker_copy_jobs.${name}: ${error.message}`);
      }
    }
  }

  /** The dated, played episodes of these shows, under the bases given. */
  async listPlayedAmong(userUUID: string, profile: string, bases: string[]): Promise<Array<{ video_id: string; last_played_at: number; last_played_kind: string | null }>> {
    const out: any[] = [];
    const escaped = (base: string) => `${base.replace(/[\\%_]/g, (c) => `\\${c}`)}:%`;
    for (let at = 0; at < bases.length; at += 100) {
      const chunk = bases.slice(at, at + 100);
      const p = this.type === 'sqlite' ? () => '?' : ((n = 0) => () => `$${++n}`)();
      const scope = `user_uuid = ${p()} AND profile = ${p()}`;
      // SQLite compares text by bytes, so a key range reads each show off the index; Postgres collations may not, so it matches by pattern.
      const sqlite = this.type === 'sqlite';
      const spelled = chunk.map(() => (sqlite ? `(video_id >= ${p()} AND video_id < ${p()})` : `video_id LIKE ${p()} ESCAPE '\\'`)).join(' OR ');
      const query = `SELECT video_id, last_played_at, last_played_kind FROM jellyfin_playstate WHERE ${scope} AND played = 1 AND last_played_at IS NOT NULL AND (${spelled})`;
      const params = sqlite ? chunk.flatMap((base) => [`${base}:`, `${base};`]) : chunk.map(escaped);
      out.push(...((await this.allQuery(query, [userUUID, profile, ...params])) || []));
    }
    return out;
  }

  /** Episodes played between two times. */
  async listPlayedBetween(userUUID: string, profile: string, from: number, to: number): Promise<Array<{ video_id: string; last_played_at: number }>> {
    const p = this.type === 'sqlite' ? () => '?' : ((n = 0) => () => `$${++n}`)();
    const query = `SELECT video_id, last_played_at, last_played_kind FROM jellyfin_playstate WHERE user_uuid = ${p()} AND profile = ${p()} AND played = 1 AND last_played_at >= ${p()} AND last_played_at <= ${p()} AND video_id LIKE '%:%:%'`;
    return (await this.allQuery(query, [userUUID, profile, from, to])) || [];
  }

  async latestWatchAt(userUUID: string): Promise<number> {
    const row = await this.getQuery(`SELECT MAX(watched_at) AS at FROM jellyfin_watches WHERE user_uuid = ${this.type === 'sqlite' ? '?' : '$1'}`, [userUUID]);
    return Number(row?.at) || 0;
  }

  async redateWatch(userUUID: string, profile: string, videoIds: string[], from: number | null, to: number, withinMs: number, merge = false): Promise<{ moved: number; latestBefore: number | null; latestAfter: number | null; apart: boolean }> {
    const sqlite = this.type === 'sqlite';
    const ids = [...new Set(videoIds)];
    const latestOf = (rows: Array<{ watched_at: number }>) => (rows.length ? Math.max(...rows.map((row) => row.watched_at)) : null);
    const before = await this.listWatchesFor(userUUID, profile, ids, true);
    let moved = 0;
    let apart = false;
    for (const id of ids) {
      const own = before.filter((row) => row.video_id === id);
      let origin: string | null;
      if (from === null) {
        const state = own.length ? null : await this.getPlaystate(userUUID, id, profile, true);
        if (!state || !Number(state.played)) continue;
        origin = state.origin ?? null;
      } else {
        const pick = own
          .filter((row) => Math.abs(row.watched_at - from) <= withinMs)
          .sort((a, b) => Math.abs(a.watched_at - from) - Math.abs(b.watched_at - from))[0];
        if (!pick || pick.watched_at === Math.round(to)) continue;
        if (merge && own.some((row) => row !== pick && Math.abs(row.watched_at - to) <= withinMs)) {
          const removed = await this.runQuery(
            sqlite
              ? 'DELETE FROM jellyfin_watches WHERE user_uuid = ? AND profile = ? AND video_id = ? AND watched_at = ?'
              : 'DELETE FROM jellyfin_watches WHERE user_uuid = $1 AND profile = $2 AND video_id = $3 AND watched_at = $4',
            [userUUID, profile, id, pick.watched_at]
          );
          if (Number(removed?.changes ?? removed?.rowCount ?? 0) > 0) {
            await this.runQuery(
              sqlite
                ? 'UPDATE jellyfin_playstate SET play_count = MAX(play_count - 1, 1) WHERE user_uuid = ? AND profile = ? AND video_id = ? AND played = 1'
                : 'UPDATE jellyfin_playstate SET play_count = GREATEST(play_count - 1, 1) WHERE user_uuid = $1 AND profile = $2 AND video_id = $3 AND played = 1',
              [userUUID, profile, id]
            );
            moved += 1;
          }
          continue;
        }
        // Another viewing already at that moment keeps its own row, one millisecond apart.
        if (own.some((row) => row !== pick && Math.abs(row.watched_at - to) <= withinMs)) apart = true;
        let at = Math.round(to);
        while (own.some((row) => row !== pick && row.watched_at === at)) at += 1;
        const result = await this.runQuery(
          sqlite
            ? 'UPDATE jellyfin_watches SET watched_at = ? WHERE user_uuid = ? AND profile = ? AND video_id = ? AND watched_at = ?'
            : 'UPDATE jellyfin_watches SET watched_at = $1 WHERE user_uuid = $2 AND profile = $3 AND video_id = $4 AND watched_at = $5',
          [at, userUUID, profile, id, pick.watched_at]
        );
        if (Number(result?.changes ?? result?.rowCount ?? 0) > 0) moved += 1;
        continue;
      }
      await this.runQuery(
        sqlite
          ? 'INSERT INTO jellyfin_watches (user_uuid, profile, video_id, watched_at, origin) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING'
          : 'INSERT INTO jellyfin_watches (user_uuid, profile, video_id, watched_at, origin) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
        [userUUID, profile, id, Math.round(to), origin]
      );
      moved += 1;
    }
    const after = moved ? await this.listWatchesFor(userUUID, profile, ids, true) : before;
    if (moved) {
      const now = Date.now();
      for (const id of ids) {
        const latest = latestOf(after.filter((row) => row.video_id === id));
        if (latest === null) continue;
        // Only the date set here is known to be a viewing; another watch now latest keeps the row's kind.
        const setHere = Math.abs(latest - Math.round(to)) < 1000 ? 1 : 0;
        await this.runQuery(
          sqlite
            ? "UPDATE jellyfin_playstate SET last_played_at = ?, last_played_kind = CASE WHEN ? = 1 THEN 'viewing' ELSE last_played_kind END, updated_at = ? WHERE user_uuid = ? AND profile = ? AND video_id = ? AND played = 1 AND position_ms = 0"
            : "UPDATE jellyfin_playstate SET last_played_at = $1, last_played_kind = CASE WHEN $2 = 1 THEN 'viewing' ELSE last_played_kind END, updated_at = $3 WHERE user_uuid = $4 AND profile = $5 AND video_id = $6 AND played = 1 AND position_ms = 0",
          [latest, setHere, now, userUUID, profile, id]
        );
      }
    }
    return { moved, latestBefore: latestOf(before), latestAfter: latestOf(after), apart };
  }

  async listWatchesByOrigin(userUUID: string, origins: string[]): Promise<Array<{ profile: string; video_id: string; watched_at: number; origin: string | null }>> {
    const sqlite = this.type === 'sqlite';
    const marks = origins.map((_, i) => (sqlite ? '?' : `$${i + 2}`)).join(', ');
    const rows = await this.allQuery(`SELECT profile, video_id, watched_at, origin FROM jellyfin_watches WHERE user_uuid = ${sqlite ? '?' : '$1'} AND origin IN (${marks})`, [userUUID, ...origins]);
    return (rows || []).map((row: any) => ({ profile: String(row.profile ?? ''), video_id: String(row.video_id), watched_at: Number(row.watched_at), origin: row.origin ?? null }));
  }

  async listUndatedPlaysByOrigin(userUUID: string, origins: string[]): Promise<Array<{ profile: string; video_id: string; origin: string | null; last_played_at: number | null; position_ms: number }>> {
    const sqlite = this.type === 'sqlite';
    const marks = origins.map((_, i) => (sqlite ? '?' : `$${i + 2}`)).join(', ');
    const rows = await this.allQuery(
      `SELECT p.profile, p.video_id, p.origin, p.last_played_at, p.position_ms FROM jellyfin_playstate p WHERE p.user_uuid = ${sqlite ? '?' : '$1'} AND p.played = 1 AND p.origin IN (${marks})
       AND NOT EXISTS (SELECT 1 FROM jellyfin_watches w WHERE w.user_uuid = p.user_uuid AND w.profile = p.profile AND w.video_id = p.video_id)`,
      [userUUID, ...origins]
    );
    return (rows || []).map((row: any) => ({
      profile: String(row.profile ?? ''),
      video_id: String(row.video_id),
      origin: row.origin ?? null,
      last_played_at: Number(row.last_played_at) || null,
      position_ms: Number(row.position_ms) || 0,
    }));
  }

  async watchStatsBetween(userUUID: string, profile: string, from: number, to: number): Promise<{ count: number; first: number | null; last: number | null; sum: string }> {
    const query = this.type === 'sqlite'
      ? 'SELECT COUNT(*) AS count, MIN(watched_at) AS first, MAX(watched_at) AS last, SUM(watched_at) AS total FROM jellyfin_watches WHERE user_uuid = ? AND profile = ? AND watched_at >= ? AND watched_at < ?'
      : 'SELECT COUNT(*) AS count, MIN(watched_at) AS first, MAX(watched_at) AS last, SUM(watched_at) AS total FROM jellyfin_watches WHERE user_uuid = $1 AND profile = $2 AND watched_at >= $3 AND watched_at < $4';
    const row = (await this.getQuery(query, [userUUID, profile, from, to])) || {};
    return { count: Number(row.count) || 0, first: row.first === null || row.first === undefined ? null : Number(row.first), last: row.last === null || row.last === undefined ? null : Number(row.last), sum: String(row.total ?? 0) };
  }

  async getYearReview(userUUID: string, profile: string, year: number): Promise<{ fingerprint: string; builtAt: number; data: any } | null> {
    const query = this.type === 'sqlite'
      ? 'SELECT fingerprint, built_at, data FROM jellyfin_year_review WHERE user_uuid = ? AND profile = ? AND year = ?'
      : 'SELECT fingerprint, built_at, data FROM jellyfin_year_review WHERE user_uuid = $1 AND profile = $2 AND year = $3';
    const row = await this.getQuery(query, [userUUID, profile, year]);
    if (!row) return null;
    try {
      return { fingerprint: String(row.fingerprint), builtAt: Number(row.built_at), data: JSON.parse(row.data) };
    } catch {
      return null;
    }
  }

  async listYearReviews(userUUID: string): Promise<Array<{ profile: string; year: number; fingerprint: string }>> {
    const rows = await this.allQuery(`SELECT profile, year, fingerprint FROM jellyfin_year_review WHERE user_uuid = ${this.type === 'sqlite' ? '?' : '$1'}`, [userUUID]);
    return rows.map((row: any) => ({ profile: String(row.profile ?? ''), year: Number(row.year), fingerprint: String(row.fingerprint) }));
  }

  async putYearReview(userUUID: string, profile: string, year: number, fingerprint: string, builtAt: number, data: any): Promise<void> {
    const query = this.type === 'sqlite'
      ? `INSERT INTO jellyfin_year_review (user_uuid, profile, year, fingerprint, built_at, data) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_uuid, profile, year) DO UPDATE SET fingerprint = excluded.fingerprint, built_at = excluded.built_at, data = excluded.data`
      : `INSERT INTO jellyfin_year_review (user_uuid, profile, year, fingerprint, built_at, data) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_uuid, profile, year) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, built_at = EXCLUDED.built_at, data = EXCLUDED.data`;
    await this.runQuery(query, [userUUID, profile, year, fingerprint, builtAt, JSON.stringify(data)]);
  }

  /**
   * What a configuration's people watched and kept. A tracker's mirror stays: it is keyed by the tracker account,
   * which another configuration can share.
   */
  async deleteViewingData(userUUID: string): Promise<void> {
    const sqlite = this.type === 'sqlite';
    const mark = sqlite ? '?' : '$1';
    for (const table of ['jellyfin_watchlist', 'jellyfin_favourites', 'jellyfin_ratings', 'jellyfin_dropped', 'jellyfin_preferences', 'jellyfin_playlists']) {
      await this.runQuery(`DELETE FROM ${table} WHERE user_uuid = ${mark}`, [userUUID]);
    }
    // One person can hold tens of thousands of these, so they go in batches with room to serve requests between.
    for (const table of ['jellyfin_playstate', 'jellyfin_watches']) {
      for (;;) {
        const result = await this.runQuery(
          `DELETE FROM ${table} WHERE user_uuid = ${mark} AND video_id IN (SELECT video_id FROM ${table} WHERE user_uuid = ${mark} LIMIT 2000)`,
          sqlite ? [userUUID, userUUID] : [userUUID]
        );
        if (!Number(sqlite ? result?.changes : result?.rowCount)) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }

  async deleteYearReviews(userUUID: string): Promise<void> {
    await this.runQuery(`DELETE FROM jellyfin_year_review WHERE user_uuid = ${this.type === 'sqlite' ? '?' : '$1'}`, [userUUID]);
  }

  async getTitleFacts(keys: string[], since: number): Promise<Map<string, any>> {
    const out = new Map<string, any>();
    const unique = [...new Set(keys)];
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500);
      const marks = chunk.map((_, n) => (this.type === 'sqlite' ? '?' : `$${n + 2}`)).join(', ');
      const rows = await this.allQuery(`SELECT facts_key, data FROM title_facts WHERE updated_at >= ${this.type === 'sqlite' ? '?' : '$1'} AND facts_key IN (${marks})`, [since, ...chunk]);
      for (const row of rows || []) {
        try {
          out.set(String(row.facts_key), JSON.parse(row.data));
        } catch {
          continue;
        }
      }
    }
    return out;
  }

  async putTitleFacts(rows: Array<{ key: string; data: any }>): Promise<void> {
    const now = Date.now();
    const size = this.type === 'sqlite' ? 150 : 500;
    const conflict = this.type === 'sqlite'
      ? 'ON CONFLICT (facts_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
      : 'ON CONFLICT (facts_key) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at';
    for (let i = 0; i < rows.length; i += size) {
      const params: any[] = [];
      const values = rows.slice(i, i + size).map((row) => {
        params.push(row.key, JSON.stringify(row.data), now);
        const at = params.length - 3;
        return this.type === 'sqlite' ? '(?, ?, ?)' : `($${at + 1}, $${at + 2}, $${at + 3})`;
      });
      await this.runQuery(`INSERT INTO title_facts (facts_key, data, updated_at) VALUES ${values.join(', ')} ${conflict}`, params);
    }
  }

  async pruneTitleFacts(before: number): Promise<number> {
    const result = await this.runQuery(`DELETE FROM title_facts WHERE updated_at < ${this.type === 'sqlite' ? '?' : '$1'}`, [before]);
    return Number(this.type === 'sqlite' ? result?.changes : result?.rowCount) || 0;
  }

  /** Episode watches before a moment of the shows spelled by these bases. */
  async listEpisodeWatchesBefore(userUUID: string, profile: string, bases: string[], to: number): Promise<Array<{ video_id: string; watched_at: number; origin: string | null }>> {
    if (!bases.length) return [];
    const rows = this.type === 'sqlite'
      ? (await Promise.all(bases.map((base) => this.allQuery(
          'SELECT video_id, watched_at, origin FROM jellyfin_watches WHERE user_uuid = ? AND profile = ? AND video_id >= ? AND video_id < ? AND watched_at < ?',
          [userUUID, profile, `${base}:`, `${base};`, to],
        )))).flat()
      : await this.allQuery(
          'SELECT video_id, watched_at, origin FROM jellyfin_watches WHERE user_uuid = $1 AND profile = $2 AND watched_at < $3 AND video_id LIKE ANY($4::text[])',
          [userUUID, profile, to, bases.map((base) => `${base}:%`)],
        );
    return (rows || []).map((row: any) => ({ video_id: String(row.video_id), watched_at: Number(row.watched_at), origin: row.origin ?? null }));
  }

  async listWatchesBetween(userUUID: string, profile: string, from: number, to: number): Promise<Array<{ video_id: string; watched_at: number; origin: string | null }>> {
    const query = this.type === 'sqlite'
      ? 'SELECT video_id, watched_at, origin FROM jellyfin_watches WHERE user_uuid = ? AND profile = ? AND watched_at >= ? AND watched_at < ?'
      : 'SELECT video_id, watched_at, origin FROM jellyfin_watches WHERE user_uuid = $1 AND profile = $2 AND watched_at >= $3 AND watched_at < $4';
    return ((await this.allQuery(query, [userUUID, profile, from, to])) || []).map((row: any) => ({ video_id: String(row.video_id), watched_at: Number(row.watched_at), origin: row.origin ?? null }));
  }

  async listRatingsForConfiguration(userUUID: string): Promise<any[]> {
    const query = this.type === 'sqlite'
      ? 'SELECT profile, meta_id, rating, meta_type, updated_at FROM jellyfin_ratings WHERE user_uuid = ?'
      : 'SELECT profile, meta_id, rating, meta_type, updated_at FROM jellyfin_ratings WHERE user_uuid = $1';
    return (await this.allQuery(query, [userUUID])) || [];
  }

  async listWatchlistForConfiguration(userUUID: string): Promise<any[]> {
    const query = this.type === 'sqlite'
      ? 'SELECT profile, meta_id, media_type, meta_type, listed, updated_at FROM jellyfin_watchlist WHERE user_uuid = ?'
      : 'SELECT profile, meta_id, media_type, meta_type, listed, updated_at FROM jellyfin_watchlist WHERE user_uuid = $1';
    return (await this.allQuery(query, [userUUID])) || [];
  }

  async listDroppedForConfiguration(userUUID: string): Promise<any[]> {
    const query = this.type === 'sqlite'
      ? 'SELECT profile, meta_id, updated_at FROM jellyfin_dropped WHERE user_uuid = ?'
      : 'SELECT profile, meta_id, updated_at FROM jellyfin_dropped WHERE user_uuid = $1';
    return (await this.allQuery(query, [userUUID])) || [];
  }

  async listTrackerMatchesForConfiguration(userUUID: string): Promise<any[]> {
    const query = this.type === 'sqlite'
      ? 'SELECT service, base, match_group, data, updated_at FROM tracker_matches WHERE user_uuid = ?'
      : 'SELECT service, base, match_group, data, updated_at FROM tracker_matches WHERE user_uuid = $1';
    return (await this.allQuery(query, [userUUID])) || [];
  }

  async writePlaystateRow(userUUID: string, profile: string, videoId: string, row: { positionMs: number; runtimeMs: number; played: boolean; playCount: number; lastPlayedAt: number | null; updatedAt: number; origin: string | null; lastPlayedKind?: 'viewing' | 'mark' | null }): Promise<void> {
    const query = this.type === 'sqlite'
      ? `INSERT INTO jellyfin_playstate (user_uuid, profile, video_id, position_ms, runtime_ms, played, play_count, last_played_at, updated_at, origin, last_played_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_uuid, profile, video_id) DO UPDATE SET
           position_ms = excluded.position_ms, runtime_ms = excluded.runtime_ms, played = excluded.played,
           play_count = excluded.play_count, last_played_at = excluded.last_played_at, updated_at = excluded.updated_at,
           origin = excluded.origin, last_played_kind = excluded.last_played_kind`
      : `INSERT INTO jellyfin_playstate (user_uuid, profile, video_id, position_ms, runtime_ms, played, play_count, last_played_at, updated_at, origin, last_played_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (user_uuid, profile, video_id) DO UPDATE SET
           position_ms = EXCLUDED.position_ms, runtime_ms = EXCLUDED.runtime_ms, played = EXCLUDED.played,
           play_count = EXCLUDED.play_count, last_played_at = EXCLUDED.last_played_at, updated_at = EXCLUDED.updated_at,
           origin = EXCLUDED.origin, last_played_kind = EXCLUDED.last_played_kind`;
    await this.runQuery(query, [userUUID, profile, videoId, row.positionMs, row.runtimeMs, row.played ? 1 : 0, row.playCount, row.lastPlayedAt, row.updatedAt, row.origin, row.lastPlayedAt === null ? null : row.lastPlayedKind ?? 'viewing']);
  }

  async insertWatch(userUUID: string, profile: string, videoId: string, watchedAt: number, origin: string | null): Promise<boolean> {
    const result = await this.runQuery(
      this.type === 'sqlite'
        ? 'INSERT INTO jellyfin_watches (user_uuid, profile, video_id, watched_at, origin) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING'
        : 'INSERT INTO jellyfin_watches (user_uuid, profile, video_id, watched_at, origin) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
      [userUUID, profile, videoId, Math.round(watchedAt), origin]
    );
    return (Number(this.type === 'sqlite' ? result?.changes : result?.rowCount) || 0) > 0;
  }

  async claimHistoryImport(userUUID: string, job: { fileName: string | null; total: number; counts: string; startedAt: number; staleBefore: number }): Promise<boolean> {
    const sqlite = this.type === 'sqlite';
    const marks = sqlite ? ['?', '?', '?', '?', '?', '?', '?'] : ['$1', '$2', '$3', '$4', '$5', '$6', '$7'];
    const result = await this.runQuery(
      `INSERT INTO history_import_jobs (user_uuid, status, file_name, done, total, counts, error, started_at, heartbeat_at, finished_at)
       VALUES (${marks[0]}, 'running', ${marks[1]}, 0, ${marks[2]}, ${marks[3]}, NULL, ${marks[4]}, ${marks[5]}, NULL)
       ON CONFLICT (user_uuid) DO UPDATE SET status = 'running', file_name = ${sqlite ? 'excluded' : 'EXCLUDED'}.file_name, done = 0,
         total = ${sqlite ? 'excluded' : 'EXCLUDED'}.total, counts = ${sqlite ? 'excluded' : 'EXCLUDED'}.counts, error = NULL,
         started_at = ${sqlite ? 'excluded' : 'EXCLUDED'}.started_at, heartbeat_at = ${sqlite ? 'excluded' : 'EXCLUDED'}.heartbeat_at, finished_at = NULL
       WHERE history_import_jobs.status <> 'running' OR history_import_jobs.heartbeat_at < ${marks[6]}`,
      [userUUID, job.fileName, job.total, job.counts, job.startedAt, job.startedAt, job.staleBefore]
    );
    return (Number(sqlite ? result?.changes : result?.rowCount) || 0) > 0;
  }

  async updateHistoryImport(userUUID: string, startedAt: number, patch: { status?: string; done?: number; error?: string | null; heartbeatAt: number; finishedAt?: number }): Promise<boolean> {
    const sqlite = this.type === 'sqlite';
    const sets: string[] = [];
    const params: any[] = [];
    const add = (column: string, value: any) => {
      params.push(value);
      sets.push(`${column} = ${sqlite ? '?' : `$${params.length}`}`);
    };
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.done !== undefined) add('done', patch.done);
    if (patch.error !== undefined) add('error', patch.error);
    if (patch.finishedAt !== undefined) add('finished_at', patch.finishedAt);
    add('heartbeat_at', patch.heartbeatAt);
    params.push(userUUID, startedAt);
    const result = await this.runQuery(
      `UPDATE history_import_jobs SET ${sets.join(', ')} WHERE user_uuid = ${sqlite ? '?' : `$${params.length - 1}`} AND started_at = ${sqlite ? '?' : `$${params.length}`} AND status = 'running'`,
      params
    );
    return (Number(sqlite ? result?.changes : result?.rowCount) || 0) > 0;
  }

  async getHistoryImport(userUUID: string): Promise<any | null> {
    const [row] = await this.allPrimaryQuery(`SELECT * FROM history_import_jobs WHERE user_uuid = ${this.type === 'sqlite' ? '?' : '$1'}`, [userUUID]);
    return row ?? null;
  }

  async deleteHistoryImport(userUUID: string): Promise<void> {
    await this.runQuery(`DELETE FROM history_import_jobs WHERE user_uuid = ${this.type === 'sqlite' ? '?' : '$1'}`, [userUUID]);
  }

  /** Copy jobs hold the titles they copied and activity the titles sent, so both go with the user. */
  async deleteTrackerTrail(userUUID: string): Promise<void> {
    const mark = this.type === 'sqlite' ? '?' : '$1';
    await this.runQuery(`DELETE FROM tracker_copy_jobs WHERE user_uuid = ${mark}`, [userUUID]);
    await this.runQuery(`DELETE FROM tracker_activity WHERE user_uuid = ${mark}`, [userUUID]);
  }

  async currentPlaystate(userUUID: string, profile: string, videoId: string): Promise<any | null> {
    const sqlite = this.type === 'sqlite';
    const [row] = await this.allPrimaryQuery(
      `SELECT * FROM jellyfin_playstate WHERE user_uuid = ${sqlite ? '?' : '$1'} AND profile = ${sqlite ? '?' : '$2'} AND video_id = ${sqlite ? '?' : '$3'}`,
      [userUUID, profile, videoId]
    );
    return row ?? null;
  }

  async hasWatchNear(userUUID: string, profile: string, videoId: string, at: number, withinMs: number, except: number[] = []): Promise<boolean> {
    const sqlite = this.type === 'sqlite';
    const rows = await this.allPrimaryQuery(
      `SELECT watched_at FROM jellyfin_watches WHERE user_uuid = ${sqlite ? '?' : '$1'} AND profile = ${sqlite ? '?' : '$2'} AND video_id = ${sqlite ? '?' : '$3'}
       AND watched_at >= ${sqlite ? '?' : '$4'} AND watched_at <= ${sqlite ? '?' : '$5'}`,
      [userUUID, profile, videoId, Math.round(at - withinMs), Math.round(at + withinMs)]
    );
    return rows.some((row: any) => !except.includes(Number(row.watched_at)));
  }

  async currentMark(table: 'jellyfin_ratings' | 'jellyfin_watchlist' | 'jellyfin_dropped', userUUID: string, profile: string, metaId: string): Promise<any | null> {
    const sqlite = this.type === 'sqlite';
    const [row] = await this.allPrimaryQuery(
      `SELECT * FROM ${table} WHERE user_uuid = ${sqlite ? '?' : '$1'} AND profile = ${sqlite ? '?' : '$2'} AND meta_id = ${sqlite ? '?' : '$3'}`,
      [userUUID, profile, metaId]
    );
    return row ?? null;
  }

  async trackerMatchHeld(userUUID: string, service: string, group: string, bases: string[]): Promise<boolean> {
    const sqlite = this.type === 'sqlite';
    const marks = bases.map((_, i) => (sqlite ? '?' : `$${i + 4}`)).join(', ');
    const rows = await this.allPrimaryQuery(
      `SELECT 1 AS held FROM tracker_matches WHERE user_uuid = ${sqlite ? '?' : '$1'} AND service = ${sqlite ? '?' : '$2'}
       AND (match_group = ${sqlite ? '?' : '$3'}${bases.length ? ` OR base IN (${marks})` : ''}) LIMIT 1`,
      [userUUID, service, group, ...bases]
    );
    return rows.length > 0;
  }

  /** One tracker account's waiting writes, oldest first up to `limit`, with how many wait in all. */
  async outboxRowsForLane(userUUID: string, service: string, profiles: string[], limit = 200): Promise<{ rows: any[]; total: number }> {
    if (!profiles.length) return { rows: [], total: 0 };
    const sqlite = this.type === 'sqlite';
    const marks = profiles.map((_, i) => (sqlite ? '?' : `$${i + 4}`)).join(', ');
    const where = `user_uuid = ${sqlite ? '?' : '$1'} AND service = ${sqlite ? '?' : '$2'} AND expires_at > ${sqlite ? '?' : '$3'} AND profile IN (${marks})`;
    const params = [userUUID, service, Date.now(), ...profiles];
    const [rows, count] = await Promise.all([
      this.allQuery(`SELECT id, profile, service, op, item_key, payload, attempts, next_at, claimed_until, created_at, last_error FROM tracker_outbox WHERE ${where} ORDER BY id LIMIT ${sqlite ? '?' : `$${profiles.length + 4}`}`, [...params, limit]),
      this.getQuery(`SELECT COUNT(*) AS n FROM tracker_outbox WHERE ${where}`, params),
    ]);
    return { rows: rows || [], total: Number(count?.n) || 0 };
  }

  async hurryTrackerOutbox(userUUID: string, ids: number[]): Promise<number> {
    if (!ids.length) return 0;
    const sqlite = this.type === 'sqlite';
    const marks = ids.map((_, i) => (sqlite ? '?' : `$${i + 4}`)).join(', ');
    const result = await this.runQuery(
      `UPDATE tracker_outbox SET next_at = ${sqlite ? '?' : '$1'} WHERE user_uuid = ${sqlite ? '?' : '$2'} AND claimed_until <= ${sqlite ? '?' : '$3'} AND id IN (${marks})`,
      [Date.now(), userUUID, Date.now(), ...ids]
    );
    return Number(result?.changes ?? result?.rowCount ?? 0);
  }

  async dropTrackerOutbox(userUUID: string, ids: number[]): Promise<any[]> {
    if (!ids.length) return [];
    const sqlite = this.type === 'sqlite';
    const marks = ids.map((_, i) => (sqlite ? '?' : `$${i + 3}`)).join(', ');
    const where = `user_uuid = ${sqlite ? '?' : '$1'} AND claimed_until <= ${sqlite ? '?' : '$2'} AND id IN (${marks})`;
    const params = [userUUID, Date.now(), ...ids];
    // Read on the primary, which the delete runs on, so a write a replica still shows unclaimed is not reported dropped.
    const rows = (await this.allPrimaryQuery(`SELECT id, profile, service, op, item_key, payload FROM tracker_outbox WHERE ${where}`, params)) || [];
    if (rows.length) await this.runQuery(`DELETE FROM tracker_outbox WHERE ${where}`, params);
    return rows;
  }

  async addTrackerActivity(row: { sourceKey: string; service: string; kind: string; userUUID?: string | null; profile?: string | null; op?: string | null; video?: string | null; detail?: unknown; at: number }): Promise<void> {
    const query = this.type === 'sqlite'
      ? 'INSERT INTO tracker_activity (source_key, service, kind, user_uuid, profile, op, video, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      : 'INSERT INTO tracker_activity (source_key, service, kind, user_uuid, profile, op, video, detail, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)';
    await this.runQuery(query, [row.sourceKey, row.service, row.kind, row.userUUID ?? null, row.profile ?? null, row.op ?? null, row.video ?? null, row.detail ? JSON.stringify(row.detail) : null, row.at]);
  }

  async listTrackerActivity(sourceKeys: string[], since: number, limit = 2000): Promise<any[]> {
    if (!sourceKeys.length) return [];
    const sqlite = this.type === 'sqlite';
    const marks = sourceKeys.map((_, i) => (sqlite ? '?' : `$${i + 3}`)).join(', ');
    const query = `SELECT id, source_key, service, kind, user_uuid, profile, op, video, detail, at FROM tracker_activity
      WHERE at >= ${sqlite ? '?' : '$1'} AND source_key IN (${marks}) ORDER BY at DESC, id DESC LIMIT ${sqlite ? '?' : '$2'}`;
    const params = sqlite ? [since, ...sourceKeys, limit] : [since, limit, ...sourceKeys];
    return (await this.allQuery(query, params)) || [];
  }

  async createCopyJob(job: { userUUID: string; profile: string; fromKey: string; fromService: string; toKey: string; toService: string; what: string; items: unknown[] }): Promise<number> {
    const now = Date.now();
    const params = [job.userUUID, job.profile, job.fromKey, job.fromService, job.toKey, job.toService, job.what, 'running', JSON.stringify(job.items), job.items.length, now, now];
    if (this.type === 'sqlite') {
      const result = await this.runQuery(
        'INSERT INTO tracker_copy_jobs (user_uuid, profile, from_key, from_service, to_key, to_service, what, status, items, total, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        params
      );
      return Number(result?.lastID);
    }
    const result = await this.runQuery(
      'INSERT INTO tracker_copy_jobs (user_uuid, profile, from_key, from_service, to_key, to_service, what, status, items, total, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id',
      params
    );
    return Number(result?.rows?.[0]?.id);
  }

  async getCopyJob(id: number): Promise<any | null> {
    const [row] = await this.allPrimaryQuery(`SELECT * FROM tracker_copy_jobs WHERE id = ${this.type === 'sqlite' ? '?' : '$1'}`, [id]);
    return row ? { ...row, items: JSON.parse(row.items || '[]') } : null;
  }

  async claimCopyJob(id: number, until: number): Promise<boolean> {
    const now = Date.now();
    const result = await this.runQuery(
      this.type === 'sqlite'
        ? "UPDATE tracker_copy_jobs SET claimed_until = ? WHERE id = ? AND status = 'running' AND claimed_until <= ?"
        : "UPDATE tracker_copy_jobs SET claimed_until = $1 WHERE id = $2 AND status = 'running' AND claimed_until <= $3",
      [until, id, now]
    );
    return Number(result?.changes ?? result?.rowCount ?? 0) > 0;
  }

  async copiedBefore(userUUID: string, fromKey: string, toKey: string, what: string, limit = 20): Promise<any[]> {
    const sqlite = this.type === 'sqlite';
    const rows = (await this.allQuery(
      `SELECT items, cursor FROM tracker_copy_jobs WHERE user_uuid = ${sqlite ? '?' : '$1'} AND from_key = ${sqlite ? '?' : '$2'} AND to_key = ${sqlite ? '?' : '$3'} AND what = ${sqlite ? '?' : '$4'} AND status IN ('done', 'stopped', 'failed') ORDER BY created_at DESC LIMIT ${sqlite ? '?' : '$5'}`,
      [userUUID, fromKey, toKey, what, limit]
    )) || [];
    return rows.flatMap((row: any) => {
      try {
        return (JSON.parse(row.items || '[]') as any[]).slice(0, Number(row.cursor) || 0);
      } catch {
        return [];
      }
    });
  }

  async listCopyJobs(userUUID: string, limit = 10): Promise<any[]> {
    const sqlite = this.type === 'sqlite';
    return (await this.allQuery(
      `SELECT id, user_uuid, profile, from_key, from_service, to_key, to_service, what, status, cursor, total, sent, skipped, failed, next_at, last_error, created_at, updated_at, finished_at
       FROM tracker_copy_jobs WHERE user_uuid = ${sqlite ? '?' : '$1'} ORDER BY created_at DESC LIMIT ${sqlite ? '?' : '$2'}`,
      [userUUID, limit]
    )) || [];
  }

  async hasRunningCopyJobs(): Promise<boolean> {
    const rows = await this.allPrimaryQuery(`SELECT 1 FROM tracker_copy_jobs WHERE status = 'running' LIMIT 1`);
    return (rows || []).length > 0;
  }

  async dueCopyJobs(now: number): Promise<number[]> {
    const at = this.type === 'sqlite' ? '?' : '$1';
    const rows = await this.allPrimaryQuery(`SELECT id FROM tracker_copy_jobs WHERE status = 'running' AND next_at <= ${at} AND claimed_until <= ${at} ORDER BY next_at`, this.type === 'sqlite' ? [now, now] : [now]);
    return (rows || []).map((row: any) => Number(row.id));
  }

  async updateCopyJob(id: number, patch: Partial<{ status: string; cursor: number; sent: number; skipped: number; failed: number; nextAt: number; claimedUntil: number; stalls: number; lastError: string | null; finishedAt: number | null }>, whileStatus?: string): Promise<boolean> {
    const columns: Record<string, string> = { status: 'status', cursor: 'cursor', sent: 'sent', skipped: 'skipped', failed: 'failed', nextAt: 'next_at', claimedUntil: 'claimed_until', stalls: 'stalls', lastError: 'last_error', finishedAt: 'finished_at' };
    const entries = Object.entries(patch).filter(([key]) => columns[key]);
    const sqlite = this.type === 'sqlite';
    const sets = entries.map(([key], i) => `${columns[key]} = ${sqlite ? '?' : `$${i + 1}`}`);
    sets.push(`updated_at = ${sqlite ? '?' : `$${entries.length + 1}`}`);
    const guard = whileStatus === undefined ? '' : ` AND status = ${sqlite ? '?' : `$${entries.length + 3}`}`;
    const result = await this.runQuery(
      `UPDATE tracker_copy_jobs SET ${sets.join(', ')} WHERE id = ${sqlite ? '?' : `$${entries.length + 2}`}${guard}`,
      [...entries.map(([, value]) => value), Date.now(), id, ...(whileStatus === undefined ? [] : [whileStatus])]
    );
    return Number(result?.changes ?? result?.rowCount ?? 0) > 0;
  }

  async pruneTrackerActivity(before: number, failedBefore = before): Promise<void> {
    const sqlite = this.type === 'sqlite';
    await this.runQuery(
      `DELETE FROM tracker_activity WHERE at < ${sqlite ? '?' : '$1'} AND (kind <> 'failed' OR at < ${sqlite ? '?' : '$2'})`,
      [before, failedBefore]
    );
  }

  async watchIndexSince(sourceKey: string, since: number): Promise<Array<{ video_id: string; kind: string; meta_id: string; at: number }>> {
    const sqlite = this.type === 'sqlite';
    const rows = await this.allQuery(
      `SELECT video_id, kind, meta_id, at FROM jellyfin_watch_index WHERE source_key = ${sqlite ? '?' : '$1'} AND listed = 1 AND at >= ${sqlite ? '?' : '$2'}`,
      [sourceKey, since]
    );
    return rows.map((row: any) => ({ ...row, at: Number(row.at) }));
  }

  async bumpTrackerSyncVersion(sourceKey: string): Promise<void> {
    const query = this.type === 'sqlite'
      ? 'UPDATE jellyfin_tracker_sync SET version = version + 1, updated_at = ? WHERE source_key = ? AND version > 0'
      : 'UPDATE jellyfin_tracker_sync SET version = version + 1, updated_at = $1 WHERE source_key = $2 AND version > 0';
    await this.runQuery(query, [Date.now(), sourceKey]);
  }

  async saveFingerprint(seriesId: string, season: number, episode: number, kind: string, startMs: number, points: string, contributor: string): Promise<void> {
    const query = this.type === 'sqlite'
      ? 'INSERT INTO jellyfin_fingerprints (series_id, season, episode, kind, start_ms, points, updated_at, contributor) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (series_id, season, episode, kind) DO UPDATE SET start_ms = excluded.start_ms, points = excluded.points, updated_at = excluded.updated_at, contributor = excluded.contributor WHERE jellyfin_fingerprints.contributor IS NULL OR jellyfin_fingerprints.contributor = excluded.contributor'
      : 'INSERT INTO jellyfin_fingerprints (series_id, season, episode, kind, start_ms, points, updated_at, contributor) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (series_id, season, episode, kind) DO UPDATE SET start_ms = EXCLUDED.start_ms, points = EXCLUDED.points, updated_at = EXCLUDED.updated_at, contributor = EXCLUDED.contributor WHERE jellyfin_fingerprints.contributor IS NULL OR jellyfin_fingerprints.contributor = EXCLUDED.contributor';
    await this.runQuery(query, [seriesId, season, episode, kind, Math.round(startMs), points, Date.now(), contributor]);
  }

  async listFingerprints(seriesId: string, season: number, kind: string, episode: number, limit: number): Promise<any[]> {
    const query = this.type === 'sqlite'
      ? 'SELECT episode, start_ms, points FROM jellyfin_fingerprints WHERE series_id = ? AND season = ? AND kind = ? AND episode <> ? ORDER BY ABS(episode - ?), episode LIMIT ?'
      : 'SELECT episode, start_ms, points FROM jellyfin_fingerprints WHERE series_id = $1 AND season = $2 AND kind = $3 AND episode <> $4 ORDER BY ABS(episode - $5), episode LIMIT $6';
    return this.allQuery(query, [seriesId, season, kind, episode, episode, limit]);
  }

  async fingerprintHeld(seriesId: string, season: number, episode: number, kind: string): Promise<{ held: boolean; count: number }> {
    const sqlite = this.type === 'sqlite';
    const row: any = await this.getQuery(
      `SELECT COUNT(*) AS count, SUM(CASE WHEN episode = ${sqlite ? '?' : '$4'} THEN 1 ELSE 0 END) AS held FROM jellyfin_fingerprints WHERE series_id = ${sqlite ? '?' : '$1'} AND season = ${sqlite ? '?' : '$2'} AND kind = ${sqlite ? '?' : '$3'}`,
      sqlite ? [episode, seriesId, season, kind] : [seriesId, season, kind, episode]
    );
    return { held: Number(row?.held) > 0, count: Number(row?.count) || 0 };
  }

  async pruneFingerprints(before: number): Promise<void> {
    const query = this.type === 'sqlite'
      ? 'DELETE FROM jellyfin_fingerprints WHERE updated_at < ?'
      : 'DELETE FROM jellyfin_fingerprints WHERE updated_at < $1';
    await this.runQuery(query, [before]);
  }

  // Read from the primary, so a client reading a playlist straight after changing it sees the change.
  async listPlaylists(userUUID: string, profile: string): Promise<any[]> {
    const query = this.type === 'sqlite'
      ? 'SELECT id, name, items, created_at, updated_at FROM jellyfin_playlists WHERE user_uuid = ? AND profile = ? ORDER BY created_at'
      : 'SELECT id, name, items, created_at, updated_at FROM jellyfin_playlists WHERE user_uuid = $1 AND profile = $2 ORDER BY created_at';
    return this.allPrimaryQuery(query, [userUUID, profile]);
  }

  async listAllPlaylists(userUUID: string): Promise<any[]> {
    const query = this.type === 'sqlite'
      ? 'SELECT profile, id, name, items, created_at, updated_at FROM jellyfin_playlists WHERE user_uuid = ? ORDER BY created_at'
      : 'SELECT profile, id, name, items, created_at, updated_at FROM jellyfin_playlists WHERE user_uuid = $1 ORDER BY created_at';
    return this.allPrimaryQuery(query, [userUUID]);
  }

  async countPlaylists(userUUID: string, profile: string): Promise<number> {
    const query = this.type === 'sqlite'
      ? 'SELECT COUNT(*) AS n FROM jellyfin_playlists WHERE user_uuid = ? AND profile = ?'
      : 'SELECT COUNT(*) AS n FROM jellyfin_playlists WHERE user_uuid = $1 AND profile = $2';
    return Number((await this.allPrimaryQuery(query, [userUUID, profile]))[0]?.n) || 0;
  }

  /** A playlist by its id in any of the user's profiles. */
  async findPlaylist(userUUID: string, id: string): Promise<any | null> {
    const query = this.type === 'sqlite'
      ? 'SELECT id, name, items, created_at, updated_at FROM jellyfin_playlists WHERE user_uuid = ? AND id = ? LIMIT 1'
      : 'SELECT id, name, items, created_at, updated_at FROM jellyfin_playlists WHERE user_uuid = $1 AND id = $2 LIMIT 1';
    return (await this.allQuery(query, [userUUID, id]))[0] ?? null;
  }

  async hasPlaylists(userUUID: string, profile: string): Promise<boolean> {
    const query = this.type === 'sqlite'
      ? 'SELECT 1 FROM jellyfin_playlists WHERE user_uuid = ? AND profile = ? LIMIT 1'
      : 'SELECT 1 FROM jellyfin_playlists WHERE user_uuid = $1 AND profile = $2 LIMIT 1';
    return (await this.allPrimaryQuery(query, [userUUID, profile])).length > 0;
  }

  async getPlaylist(userUUID: string, profile: string, id: string): Promise<any | null> {
    const query = this.type === 'sqlite'
      ? 'SELECT id, name, items, created_at, updated_at FROM jellyfin_playlists WHERE user_uuid = ? AND profile = ? AND id = ?'
      : 'SELECT id, name, items, created_at, updated_at FROM jellyfin_playlists WHERE user_uuid = $1 AND profile = $2 AND id = $3';
    return (await this.allPrimaryQuery(query, [userUUID, profile, id]))[0] ?? null;
  }

  async savePlaylist(userUUID: string, profile: string, playlist: { id: string; name: string; items: string[]; createdAt: number; updatedAt: number }): Promise<void> {
    const query = this.type === 'sqlite'
      ? 'INSERT INTO jellyfin_playlists (user_uuid, profile, id, name, items, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_uuid, profile, id) DO UPDATE SET name = excluded.name, items = excluded.items, updated_at = excluded.updated_at'
      : 'INSERT INTO jellyfin_playlists (user_uuid, profile, id, name, items, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (user_uuid, profile, id) DO UPDATE SET name = EXCLUDED.name, items = EXCLUDED.items, updated_at = EXCLUDED.updated_at';
    await this.runQuery(query, [userUUID, profile, playlist.id, playlist.name, JSON.stringify(playlist.items), playlist.createdAt, playlist.updatedAt]);
  }

  async updatePlaylist(userUUID: string, profile: string, playlist: { id: string; name: string; items: string[]; updatedAt: number }, readAt: number): Promise<boolean> {
    const query = this.type === 'sqlite'
      ? 'UPDATE jellyfin_playlists SET name = ?, items = ?, updated_at = ? WHERE user_uuid = ? AND profile = ? AND id = ? AND updated_at = ?'
      : 'UPDATE jellyfin_playlists SET name = $1, items = $2, updated_at = $3 WHERE user_uuid = $4 AND profile = $5 AND id = $6 AND updated_at = $7';
    const result = await this.runQuery(query, [playlist.name, JSON.stringify(playlist.items), playlist.updatedAt, userUUID, profile, playlist.id, readAt]);
    return Number(result?.changes ?? result?.rowCount ?? 0) > 0;
  }

  async deletePlaylist(userUUID: string, profile: string, id: string): Promise<boolean> {
    const query = this.type === 'sqlite'
      ? 'DELETE FROM jellyfin_playlists WHERE user_uuid = ? AND profile = ? AND id = ?'
      : 'DELETE FROM jellyfin_playlists WHERE user_uuid = $1 AND profile = $2 AND id = $3';
    const result = await this.runQuery(query, [userUUID, profile, id]);
    return Number(result?.changes ?? result?.rowCount ?? 0) > 0;
  }

  /** The runtimes listPlayedForProfile would give for these videos, read by key. */
  async listPlayedRuntimes(userUUID: string, profile: string, videoIds: string[]): Promise<Array<{ video_id: string; runtime_ms: number }>> {
    const sqlite = this.type === 'sqlite';
    const out: Array<{ video_id: string; runtime_ms: number }> = [];
    for (let at = 0; at < videoIds.length; at += PLAYSTATE_KEY_BATCH) {
      const ids = videoIds.slice(at, at + PLAYSTATE_KEY_BATCH);
      const marks = ids.map((_, i) => (sqlite ? '?' : `$${i + 3}`)).join(', ');
      const query = sqlite
        ? `SELECT video_id, runtime_ms FROM jellyfin_playstate WHERE user_uuid = ? AND profile = ? AND video_id IN (${marks}) AND runtime_ms > 0 AND (played = 1 OR position_ms > 0)`
        : `SELECT video_id, runtime_ms FROM jellyfin_playstate WHERE user_uuid = $1 AND profile = $2 AND video_id IN (${marks}) AND runtime_ms > 0 AND (played = 1 OR position_ms > 0)`;
      out.push(...((await this.allQuery(query, [userUUID, profile, ...ids])) || []));
    }
    return out;
  }

  /** Records the kind of a rating saved before kinds were stored, leaving its date alone. */
  async setRatingType(userUUID: string, profile: string, metaIds: string[], metaType: 'movie' | 'series'): Promise<void> {
    if (!metaIds.length) return;
    const sqlite = this.type === 'sqlite';
    const marks = metaIds.map((_, i) => (sqlite ? '?' : `$${i + 4}`)).join(', ');
    await this.runQuery(
      `UPDATE jellyfin_ratings SET meta_type = ${sqlite ? '?' : '$1'} WHERE user_uuid = ${sqlite ? '?' : '$2'} AND profile = ${sqlite ? '?' : '$3'} AND meta_type IS NULL AND meta_id IN (${marks})`,
      [metaType, userUUID, profile, ...metaIds]
    );
  }

  async listRemoteRatings(userUUID: string, limit: number): Promise<any[]> {
    const query = this.type === 'sqlite'
      ? "SELECT meta_id, meta_type, pmdb_id FROM jellyfin_ratings WHERE user_uuid = ? AND pmdb_id IS NOT NULL AND meta_id LIKE 'tmdb:%' ORDER BY updated_at DESC LIMIT ?"
      : "SELECT meta_id, meta_type, pmdb_id FROM jellyfin_ratings WHERE user_uuid = $1 AND pmdb_id IS NOT NULL AND meta_id LIKE 'tmdb:%' ORDER BY updated_at DESC LIMIT $2";
    return (await this.allQuery(query, [userUUID, limit])) || [];
  }

  async getCalendarFeed(userUUID: string, profile: string): Promise<string | null> {
    const query = this.type === 'sqlite'
      ? 'SELECT secret FROM jellyfin_calendar_feeds WHERE user_uuid = ? AND profile = ?'
      : 'SELECT secret FROM jellyfin_calendar_feeds WHERE user_uuid = $1 AND profile = $2';
    const row = await this.getQuery(query, [userUUID, profile]);
    return row?.secret ? String(row.secret) : null;
  }

  async findCalendarFeed(secret: string): Promise<{ user_uuid: string; profile: string } | null> {
    const query = this.type === 'sqlite'
      ? 'SELECT user_uuid, profile FROM jellyfin_calendar_feeds WHERE secret = ?'
      : 'SELECT user_uuid, profile FROM jellyfin_calendar_feeds WHERE secret = $1';
    return (await this.getQuery(query, [secret])) ?? null;
  }

  async saveCalendarFeed(userUUID: string, profile: string, secret: string): Promise<void> {
    const query = this.type === 'sqlite'
      ? `INSERT INTO jellyfin_calendar_feeds (user_uuid, profile, secret, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_uuid, profile) DO UPDATE SET secret = excluded.secret, created_at = excluded.created_at`
      : `INSERT INTO jellyfin_calendar_feeds (user_uuid, profile, secret, created_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_uuid, profile) DO UPDATE SET secret = EXCLUDED.secret, created_at = EXCLUDED.created_at`;
    await this.runQuery(query, [userUUID, profile, secret, Date.now()]);
  }

  async deleteCalendarFeed(userUUID: string, profile: string | null): Promise<void> {
    if (profile === null) {
      const query = this.type === 'sqlite'
        ? 'DELETE FROM jellyfin_calendar_feeds WHERE user_uuid = ?'
        : 'DELETE FROM jellyfin_calendar_feeds WHERE user_uuid = $1';
      await this.runQuery(query, [userUUID]);
      return;
    }
    const query = this.type === 'sqlite'
      ? 'DELETE FROM jellyfin_calendar_feeds WHERE user_uuid = ? AND profile = ?'
      : 'DELETE FROM jellyfin_calendar_feeds WHERE user_uuid = $1 AND profile = $2';
    await this.runQuery(query, [userUUID, profile]);
  }

  async listTrackerMatches(userUUID: string, service: string, primary = false): Promise<Array<{ base: string; match_group: string; data: string }>> {
    const query = this.type === 'sqlite'
      ? 'SELECT base, match_group, data FROM tracker_matches WHERE user_uuid = ? AND service = ?'
      : 'SELECT base, match_group, data FROM tracker_matches WHERE user_uuid = $1 AND service = $2';
    return (await (primary ? this.allPrimaryQuery(query, [userUUID, service]) : this.allQuery(query, [userUUID, service]))) || [];
  }

  async saveTrackerMatch(userUUID: string, service: string, group: string, bases: string[], data: string): Promise<void> {
    await this.deleteTrackerMatch(userUUID, service, group, bases);
    const query = this.type === 'sqlite'
      ? 'INSERT INTO tracker_matches (user_uuid, service, base, match_group, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      : 'INSERT INTO tracker_matches (user_uuid, service, base, match_group, data, updated_at) VALUES ($1, $2, $3, $4, $5, $6)';
    const now = Date.now();
    for (const base of bases) await this.runQuery(query, [userUUID, service, base, group, data, now]);
  }

  async deleteTrackerMatch(userUUID: string, service: string, group: string, bases: string[] = []): Promise<void> {
    const byGroup = this.type === 'sqlite'
      ? 'DELETE FROM tracker_matches WHERE user_uuid = ? AND service = ? AND match_group = ?'
      : 'DELETE FROM tracker_matches WHERE user_uuid = $1 AND service = $2 AND match_group = $3';
    await this.runQuery(byGroup, [userUUID, service, group]);
    const byBase = this.type === 'sqlite'
      ? 'DELETE FROM tracker_matches WHERE user_uuid = ? AND service = ? AND base = ?'
      : 'DELETE FROM tracker_matches WHERE user_uuid = $1 AND service = $2 AND base = $3';
    for (const base of bases) await this.runQuery(byBase, [userUUID, service, base]);
  }

  async listLeftOut(userUUID: string, sourceKey: string): Promise<Array<{ profile: string; video_id: string; origin: string }>> {
    const query = this.type === 'sqlite'
      ? 'SELECT profile, video_id, origin FROM tracker_left_out WHERE user_uuid = ? AND source_key = ?'
      : 'SELECT profile, video_id, origin FROM tracker_left_out WHERE user_uuid = $1 AND source_key = $2';
    return ((await this.allQuery(query, [userUUID, sourceKey])) || []).map((row: any) => ({ profile: String(row.profile ?? ''), video_id: String(row.video_id), origin: String(row.origin) }));
  }

  async leaveOut(userUUID: string, sourceKey: string, origin: string, entries: Array<{ profile: string; videoId: string }>): Promise<void> {
    const sqlite = this.type === 'sqlite';
    const now = Date.now();
    const rows = [...new Map(entries.map((entry) => [`${entry.profile}|${entry.videoId}`, entry])).values()];
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const values = chunk.map((_, j) => (sqlite ? '(?, ?, ?, ?, ?, ?)' : `(${[1, 2, 3, 4, 5, 6].map((k) => `$${j * 6 + k}`).join(', ')})`)).join(', ');
      await this.runQuery(
        `INSERT INTO tracker_left_out (user_uuid, source_key, profile, origin, video_id, left_at) VALUES ${values} ON CONFLICT (user_uuid, source_key, profile, origin, video_id) DO NOTHING`,
        chunk.flatMap((entry) => [userUUID, sourceKey, entry.profile, origin, entry.videoId, now])
      );
    }
  }

  async restoreLeftOut(userUUID: string, sourceKey: string, origin: string, profiles: string[]): Promise<number> {
    if (!profiles.length) return 0;
    const sqlite = this.type === 'sqlite';
    const marks = profiles.map((_, i) => (sqlite ? '?' : `$${i + 4}`)).join(', ');
    const result = await this.runQuery(
      `DELETE FROM tracker_left_out WHERE user_uuid = ${sqlite ? '?' : '$1'} AND source_key = ${sqlite ? '?' : '$2'} AND origin = ${sqlite ? '?' : '$3'} AND profile IN (${marks})`,
      [userUUID, sourceKey, origin, ...profiles]
    );
    return Number(sqlite ? result?.changes : result?.rowCount) || 0;
  }

  async deleteLeftOut(userUUID: string): Promise<void> {
    const query = this.type === 'sqlite'
      ? 'DELETE FROM tracker_left_out WHERE user_uuid = ?'
      : 'DELETE FROM tracker_left_out WHERE user_uuid = $1';
    await this.runQuery(query, [userUUID]);
  }

  async deleteTrackerMatches(userUUID: string): Promise<void> {
    const query = this.type === 'sqlite'
      ? 'DELETE FROM tracker_matches WHERE user_uuid = ?'
      : 'DELETE FROM tracker_matches WHERE user_uuid = $1';
    await this.runQuery(query, [userUUID]);
  }
}

const FEATURE_SQLITE_TABLES = [
      `CREATE TABLE IF NOT EXISTS tracker_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_key TEXT NOT NULL,
        service TEXT NOT NULL,
        kind TEXT NOT NULL,
        user_uuid TEXT,
        profile TEXT,
        op TEXT,
        video TEXT,
        detail TEXT,
        at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tracker_activity_source ON tracker_activity(source_key, at)`,
      `CREATE INDEX IF NOT EXISTS idx_tracker_activity_user ON tracker_activity(user_uuid, at)`,
      `CREATE TABLE IF NOT EXISTS tracker_copy_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_uuid TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        from_key TEXT NOT NULL,
        from_service TEXT NOT NULL,
        to_key TEXT NOT NULL,
        to_service TEXT NOT NULL,
        what TEXT NOT NULL DEFAULT 'watches',
        status TEXT NOT NULL,
        items TEXT NOT NULL,
        cursor INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        sent INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0,
        claimed_until INTEGER NOT NULL DEFAULT 0,
        stalls INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tracker_copy_jobs_user ON tracker_copy_jobs(user_uuid, created_at)`,
      `CREATE TABLE IF NOT EXISTS history_import_jobs (
        user_uuid TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        file_name TEXT,
        done INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        counts TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        finished_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_year_review (
        user_uuid TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        year INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        built_at INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (user_uuid, profile, year)
      )`,
      `CREATE TABLE IF NOT EXISTS title_facts (
        facts_key TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_title_facts_updated ON title_facts(updated_at)`,
      `CREATE TABLE IF NOT EXISTS jellyfin_playlists (
        user_uuid TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        items TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_uuid, profile, id)
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_fingerprints (
        series_id TEXT NOT NULL,
        season INTEGER NOT NULL,
        episode INTEGER NOT NULL,
        kind TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        points TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        contributor TEXT,
        PRIMARY KEY (series_id, season, episode, kind)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_jellyfin_fingerprints_updated ON jellyfin_fingerprints(updated_at)`,
      `CREATE TABLE IF NOT EXISTS jellyfin_calendar_feeds (
        user_uuid TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        secret TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_uuid, profile)
      )`,
      `CREATE TABLE IF NOT EXISTS tracker_matches (
        user_uuid TEXT NOT NULL,
        service TEXT NOT NULL,
        base TEXT NOT NULL,
        match_group TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_uuid, service, base)
      )`,
      `CREATE TABLE IF NOT EXISTS tracker_left_out (
        user_uuid TEXT NOT NULL,
        source_key TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL,
        video_id TEXT NOT NULL,
        left_at INTEGER NOT NULL,
        PRIMARY KEY (user_uuid, source_key, profile, origin, video_id)
      )`
    ];

const FEATURE_POSTGRES_TABLES = [
      `CREATE TABLE IF NOT EXISTS tracker_activity (
        id BIGSERIAL PRIMARY KEY,
        source_key VARCHAR(64) NOT NULL,
        service TEXT NOT NULL,
        kind VARCHAR(16) NOT NULL,
        user_uuid VARCHAR(64),
        profile TEXT,
        op TEXT,
        video TEXT,
        detail TEXT,
        at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tracker_activity_source ON tracker_activity(source_key, at)`,
      `CREATE INDEX IF NOT EXISTS idx_tracker_activity_user ON tracker_activity(user_uuid, at)`,
      `CREATE TABLE IF NOT EXISTS tracker_copy_jobs (
        id BIGSERIAL PRIMARY KEY,
        user_uuid VARCHAR(64) NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        from_key VARCHAR(64) NOT NULL,
        from_service TEXT NOT NULL,
        to_key VARCHAR(64) NOT NULL,
        to_service TEXT NOT NULL,
        what VARCHAR(16) NOT NULL DEFAULT 'watches',
        status VARCHAR(16) NOT NULL,
        items TEXT NOT NULL,
        cursor INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        sent INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        next_at BIGINT NOT NULL DEFAULT 0,
        claimed_until BIGINT NOT NULL DEFAULT 0,
        stalls INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        finished_at BIGINT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tracker_copy_jobs_user ON tracker_copy_jobs(user_uuid, created_at)`,
      `CREATE TABLE IF NOT EXISTS history_import_jobs (
        user_uuid VARCHAR(64) PRIMARY KEY,
        status VARCHAR(16) NOT NULL,
        file_name TEXT,
        done INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        counts TEXT,
        error TEXT,
        started_at BIGINT NOT NULL,
        heartbeat_at BIGINT NOT NULL,
        finished_at BIGINT
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_year_review (
        user_uuid VARCHAR(64) NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        year INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        built_at BIGINT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (user_uuid, profile, year)
      )`,
      `CREATE TABLE IF NOT EXISTS title_facts (
        facts_key TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_title_facts_updated ON title_facts(updated_at)`,
      `CREATE TABLE IF NOT EXISTS jellyfin_playlists (
        user_uuid VARCHAR(64) NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        items TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, profile, id)
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_fingerprints (
        series_id TEXT NOT NULL,
        season INTEGER NOT NULL,
        episode INTEGER NOT NULL,
        kind VARCHAR(16) NOT NULL,
        start_ms BIGINT NOT NULL,
        points TEXT NOT NULL,
        updated_at BIGINT NOT NULL,
        contributor TEXT,
        PRIMARY KEY (series_id, season, episode, kind)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_jellyfin_fingerprints_updated ON jellyfin_fingerprints(updated_at)`,
      `CREATE TABLE IF NOT EXISTS jellyfin_calendar_feeds (
        user_uuid VARCHAR(64) NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        secret VARCHAR(64) NOT NULL UNIQUE,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, profile)
      )`,
      `CREATE TABLE IF NOT EXISTS tracker_matches (
        user_uuid VARCHAR(64) NOT NULL,
        service VARCHAR(32) NOT NULL,
        base TEXT NOT NULL,
        match_group TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, service, base)
      )`,
      `CREATE TABLE IF NOT EXISTS tracker_left_out (
        user_uuid VARCHAR(64) NOT NULL,
        source_key VARCHAR(64) NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        origin VARCHAR(32) NOT NULL,
        video_id TEXT NOT NULL,
        left_at BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, source_key, profile, origin, video_id)
      )`
    ];
