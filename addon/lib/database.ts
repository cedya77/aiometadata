import { Pool } from 'pg';
import BetterSqlite3 from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
const redisIdCache: any = require('./redis-id-cache');
import consola from 'consola';

const logger = consola.withTag('Database');

export interface WatchPatch {
  at: number;
  kind: 'finish' | 'first' | 'dated';
  gapMs?: number;
}

type DbType = 'sqlite' | 'postgres';

// A row a tracker sync wrote rather than a play here: a tracker's origin, or an
// unmarked row whose last play is not when it was written.
const IMPORTED_PLAYSTATE = `(origin IS NOT NULL AND origin NOT IN ('server', 'play'))
      OR ((origin IS NULL OR origin = 'play') AND (played = 1 OR position_ms > 0)
        AND (last_played_at IS NULL OR ABS(updated_at - last_played_at) >= 2000))`;

function dbTypeFromUri(uri: string | undefined): DbType | null {
  if (!uri) return null;
  if (uri.startsWith('sqlite://')) return 'sqlite';
  if (uri.startsWith('postgres://') || uri.startsWith('postgresql://')) return 'postgres';
  return null;
}

class Database {
  db: any;
  readDb: any;
  private connectedType: DbType | null;
  initialized: boolean;

  constructor() {
    this.db = null;
    this.readDb = null;
    this.connectedType = null;
    this.initialized = false;
  }

  get type(): DbType | null {
    return this.connectedType ?? dbTypeFromUri(process.env.DATABASE_URI);
  }

  set type(value: DbType | null) {
    this.connectedType = value;
  }

  executeSQLiteStatement(statement: any, method: string, params: any = []) {
    if (params == null) {
      return statement[method]();
    }

    if (Array.isArray(params)) {
      return params.length > 0 ? statement[method](params) : statement[method]();
    }

    return statement[method](params);
  }

  async hashPassword(password: string): Promise<string> {
    const saltRounds = 12;
    return await bcrypt.hash(password, saltRounds);
  }

  async verifyPasswordHash(password: string, storedHash: string): Promise<boolean> {
    try {
      const bcryptMatch = await bcrypt.compare(password, storedHash);
      if (bcryptMatch) return true;
    } catch (error) {
      // Not a bcrypt hash, continue to SHA-256 check
    }

    const hashRaw = crypto.createHash('sha256').update(password).digest('hex');
    const hashTrim = crypto.createHash('sha256').update((password || '').trim()).digest('hex');

    return storedHash === hashRaw || storedHash === hashTrim;
  }

  isBcryptHash(hash: string): boolean {
    return hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const databaseUri = process.env.DATABASE_URI;
    if (!databaseUri) {
      throw new Error('DATABASE_URI environment variable is required');
    }

    const uriType = dbTypeFromUri(databaseUri);
    if (uriType === 'sqlite') {
      await this.initializeSQLite(databaseUri);
    } else if (uriType === 'postgres') {
      await this.initializePostgreSQL(databaseUri);
    } else {
      throw new Error('Unsupported database URI format. Use sqlite:// or postgres://');
    }

    // Mark initialized BEFORE creating tables to avoid recursive initialize() calls
    // from runQuery/getQuery during table creation.
    this.initialized = true;

    const runMigrations = String(process.env.RUN_MIGRATIONS ?? 'true').toLowerCase() !== 'false';
    if (runMigrations) {
      await this.createTables();
    } else {
      logger.info('RUN_MIGRATIONS=false, skipping schema creation (expecting an already-migrated database)');
    }

    const usingReplica = this.readDb && this.readDb !== this.db;
    logger.info(`Initialized ${this.type} database${usingReplica ? ' with a separate read replica' : ''}`);
  }

  async initializeSQLite(uri: string): Promise<void> {
    const dbPath = uri.replace('sqlite://', '');
    const fullPath = path.resolve(dbPath);

    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new BetterSqlite3(fullPath, {
      timeout: 5000,
    });
    this.type = 'sqlite';

    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = 10000');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('mmap_size = 268435456');

    this.readDb = this.db;
  }

  async initializePostgreSQL(uri: string): Promise<void> {
    this.db = new Pool({ connectionString: uri });
    this.type = 'postgres';

    await this.db.query('SELECT 1');

    const readUri = process.env.DATABASE_READ_URI;
    if (readUri && readUri !== uri) {
      try {
        this.readDb = new Pool({ connectionString: readUri });
        await this.readDb.query('SELECT 1');
        logger.info('Connected to read replica (DATABASE_READ_URI)');
      } catch (error: any) {
        logger.warn(`Read replica unreachable, falling back to primary for reads: ${error.message}`);
        if (this.readDb && this.readDb !== this.db) {
          try { await this.readDb.end(); } catch { /* ignore */ }
        }
        this.readDb = this.db;
      }
    } else {
      this.readDb = this.db;
    }
  }

  async createTables(): Promise<void> {
    if (this.type === 'sqlite') {
      await this.createSQLiteTables();
    } else {
      await this.createPostgreSQLTables();
    }
    await this.ensureAccountColumns();
    await this.ensurePlaystateProfile();
    await this.ensurePlaystateOrigin();
    await this.ensureWatches();
    await this.ensureWatchlistMetaType();
    await this.ensureTrackerOutboxProfile();
    await this.ensureCopyJobColumns();
    await this.ensureRatingsMetaType();
  }

  /** The profile is part of the key, which neither dialect can add in place. */
  async ensurePlaystateProfile(): Promise<void> {
    try {
      const columns = this.type === 'sqlite'
        ? (await this.allQuery(`PRAGMA table_info(jellyfin_playstate)`)).map((c: any) => c.name)
        : (await this.allQuery(`SELECT column_name FROM information_schema.columns WHERE table_name = 'jellyfin_playstate'`)).map((c: any) => c.column_name);
      if (columns.includes('profile')) return;

      const keyType = this.type === 'sqlite' ? 'INTEGER' : 'BIGINT';
      const playedType = this.type === 'sqlite' ? 'INTEGER' : 'SMALLINT';
      const uuidType = this.type === 'sqlite' ? 'TEXT' : 'VARCHAR(64)';

      await this.runQuery(`ALTER TABLE jellyfin_playstate RENAME TO jellyfin_playstate_v1`);
      if (this.type !== 'sqlite') {
        await this.runQuery(`ALTER TABLE jellyfin_playstate_v1 RENAME CONSTRAINT jellyfin_playstate_pkey TO jellyfin_playstate_v1_pkey`);
      }
      await this.runQuery(`DROP INDEX IF EXISTS idx_jellyfin_playstate_recent`);
      await this.runQuery(`CREATE TABLE jellyfin_playstate (
        user_uuid ${uuidType} NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        video_id TEXT NOT NULL,
        position_ms ${keyType} NOT NULL DEFAULT 0,
        runtime_ms ${keyType} NOT NULL DEFAULT 0,
        played ${playedType} NOT NULL DEFAULT 0,
        play_count INTEGER NOT NULL DEFAULT 0,
        last_played_at ${keyType},
        updated_at ${keyType} NOT NULL,
        PRIMARY KEY (user_uuid, profile, video_id)
      )`);
      await this.runQuery(`INSERT INTO jellyfin_playstate (user_uuid, profile, video_id, position_ms, runtime_ms, played, play_count, last_played_at, updated_at)
        SELECT user_uuid, '', video_id, position_ms, runtime_ms, played, play_count, last_played_at, updated_at FROM jellyfin_playstate_v1`);
      await this.runQuery(`DROP TABLE jellyfin_playstate_v1`);
      await this.runQuery(`CREATE INDEX IF NOT EXISTS idx_jellyfin_playstate_recent ON jellyfin_playstate(user_uuid, profile, updated_at DESC)`);
      logger.info('Migrated jellyfin_playstate: rows keyed by profile');
    } catch (error: any) {
      logger.warn(`Could not add jellyfin_playstate.profile: ${error.message}`);
    }
  }

  /**
   * The accounts table predates the columns that record what an identity
   * presented and whether it is barred, and CREATE TABLE IF NOT EXISTS leaves
   * an existing one untouched.
   */
  async ensureAccountColumns(): Promise<void> {
    const columns: Array<[string, string]> = [
      ['groups_json', 'TEXT'],
      ['blocked', 'INTEGER NOT NULL DEFAULT 0'],
    ];

    for (const [name, definition] of columns) {
      try {
        if (this.type === 'sqlite') {
          const existing = await this.allQuery(`PRAGMA table_info(accounts)`);
          if (existing.some((column: any) => column.name === name)) continue;
          await this.runQuery(`ALTER TABLE accounts ADD COLUMN ${name} ${definition}`);
        } else {
          await this.runQuery(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ${name} ${definition}`);
        }
        logger.info(`Migrated accounts schema: added ${name}`);
      } catch (error: any) {
        logger.warn(`Could not add accounts.${name}: ${error.message}`);
      }
    }
  }

  async ensurePlaystateOrigin(): Promise<void> {
    try {
      if (this.type === 'sqlite') {
        const existing = await this.allQuery(`PRAGMA table_info(jellyfin_playstate)`);
        if (existing.some((column: any) => column.name === 'origin')) return;
        await this.runQuery(`ALTER TABLE jellyfin_playstate ADD COLUMN origin TEXT`);
        logger.info('Migrated jellyfin_playstate: rows record their origin');
      } else {
        await this.runQuery(`ALTER TABLE jellyfin_playstate ADD COLUMN IF NOT EXISTS origin TEXT`);
      }
    } catch (error: any) {
      logger.warn(`Could not add jellyfin_playstate.origin: ${error.message}`);
    }
  }

  async ensureWatches(): Promise<void> {
    try {
      const sqlite = this.type === 'sqlite';
      const existing = sqlite
        ? await this.getQuery(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jellyfin_watches'`)
        : await this.getQuery(`SELECT table_name FROM information_schema.tables WHERE table_name = 'jellyfin_watches'`);
      await this.runQuery(`CREATE TABLE IF NOT EXISTS jellyfin_watches (
        user_uuid ${sqlite ? 'TEXT' : 'VARCHAR(64)'} NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        video_id TEXT NOT NULL,
        watched_at ${sqlite ? 'INTEGER' : 'BIGINT'} NOT NULL,
        origin TEXT,
        PRIMARY KEY (user_uuid, profile, video_id, watched_at)
      )`);
      await this.runQuery(`CREATE INDEX IF NOT EXISTS idx_jellyfin_watches_recent ON jellyfin_watches(user_uuid, profile, watched_at DESC)`);
      await this.runQuery(`CREATE INDEX IF NOT EXISTS idx_jellyfin_watches_at ON jellyfin_watches(watched_at)`);
      if (existing) return;
      const result = await this.runQuery(`INSERT INTO jellyfin_watches (user_uuid, profile, video_id, watched_at, origin)
        SELECT user_uuid, profile, video_id, last_played_at, origin FROM jellyfin_playstate
        WHERE played = 1 AND last_played_at IS NOT NULL AND position_ms = 0
        ON CONFLICT DO NOTHING`);
      logger.info(`Created jellyfin_watches with ${Number(sqlite ? result?.changes : result?.rowCount) || 0} watches from the play state`);
    } catch (error: any) {
      logger.warn(`Could not create jellyfin_watches: ${error.message}`);
    }
  }

  async ensureWatchlistMetaType(): Promise<void> {
    for (const table of ['jellyfin_watchlist', 'jellyfin_favourites']) {
      try {
        if (this.type === 'sqlite') {
          const existing = await this.allQuery(`PRAGMA table_info(${table})`);
          if (existing.some((column: any) => column.name === 'meta_type')) continue;
          await this.runQuery(`ALTER TABLE ${table} ADD COLUMN meta_type TEXT`);
          logger.info(`Migrated ${table}: rows record their meta type`);
        } else {
          await this.runQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS meta_type TEXT`);
        }
      } catch (error: any) {
        logger.warn(`Could not add ${table}.meta_type: ${error.message}`);
      }
    }
  }

  async ensureRatingsMetaType(): Promise<void> {
    try {
      if (this.type === 'sqlite') {
        const existing = await this.allQuery(`PRAGMA table_info(jellyfin_ratings)`);
        if (existing.some((column: any) => column.name === 'meta_type')) return;
        await this.runQuery(`ALTER TABLE jellyfin_ratings ADD COLUMN meta_type TEXT`);
        logger.info('Migrated jellyfin_ratings: rows record their meta type');
      } else {
        await this.runQuery(`ALTER TABLE jellyfin_ratings ADD COLUMN IF NOT EXISTS meta_type TEXT`);
      }
    } catch (error: any) {
      logger.warn(`Could not add jellyfin_ratings.meta_type: ${error.message}`);
    }
  }

  async ensureTrackerOutboxProfile(): Promise<void> {
    try {
      if (this.type === 'sqlite') {
        const existing = await this.allQuery(`PRAGMA table_info(tracker_outbox)`);
        if (existing.some((column: any) => column.name === 'profile')) return;
        await this.runQuery(`ALTER TABLE tracker_outbox ADD COLUMN profile TEXT NOT NULL DEFAULT ''`);
        logger.info('Migrated tracker_outbox: rows keyed by profile');
      } else {
        await this.runQuery(`ALTER TABLE tracker_outbox ADD COLUMN IF NOT EXISTS profile TEXT NOT NULL DEFAULT ''`);
      }
    } catch (error: any) {
      logger.warn(`Could not add tracker_outbox.profile: ${error.message}`);
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

  async createSQLiteTables(): Promise<void> {
    const queries = [
      `CREATE TABLE IF NOT EXISTS user_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_uuid TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        config_data TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS id_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_type TEXT NOT NULL,
        tmdb_id TEXT,
        tvdb_id TEXT,
        imdb_id TEXT,
        tvmaze_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(content_type, tmdb_id, tvdb_id, imdb_id, tvmaze_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_user_configs_created_at ON user_configs(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_id_mappings_tmdb ON id_mappings(tmdb_id)`,
      `CREATE INDEX IF NOT EXISTS idx_id_mappings_tvdb ON id_mappings(tvdb_id)`,
      `CREATE INDEX IF NOT EXISTS idx_id_mappings_imdb ON id_mappings(imdb_id)`,
      `CREATE INDEX IF NOT EXISTS idx_id_mappings_tvmaze ON id_mappings(tvmaze_id)`,
      `CREATE INDEX IF NOT EXISTS idx_id_mappings_content_type ON id_mappings(content_type)`,
      `CREATE TABLE IF NOT EXISTS jellyfin_ids (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        codec_version INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_playstate (
        user_uuid TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        video_id TEXT NOT NULL,
        position_ms INTEGER NOT NULL DEFAULT 0,
        runtime_ms INTEGER NOT NULL DEFAULT 0,
        played INTEGER NOT NULL DEFAULT 0,
        play_count INTEGER NOT NULL DEFAULT 0,
        last_played_at INTEGER,
        updated_at INTEGER NOT NULL,
        origin TEXT,
        PRIMARY KEY (user_uuid, profile, video_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_jellyfin_playstate_recent ON jellyfin_playstate(user_uuid, profile, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_jellyfin_playstate_played ON jellyfin_playstate(last_played_at)`,
      `CREATE INDEX IF NOT EXISTS idx_jellyfin_playstate_user_played ON jellyfin_playstate(user_uuid, profile, played, last_played_at DESC, video_id)`,
      `CREATE TABLE IF NOT EXISTS jellyfin_preferences (
        user_uuid TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        pref_id TEXT NOT NULL,
        client TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_uuid, profile, pref_id, client)
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_watchlist (
        user_uuid TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        meta_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        meta_type TEXT,
        listed INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_uuid, profile, meta_id)
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_tracker_mirror (
        source_key TEXT NOT NULL,
        item_key TEXT NOT NULL,
        group_key TEXT NOT NULL DEFAULT '',
        sub_key TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source_key, item_key)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_jellyfin_tracker_mirror_group ON jellyfin_tracker_mirror(source_key, group_key, sub_key)`,
      `CREATE TABLE IF NOT EXISTS jellyfin_id_resolutions (
        resolution_key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        resolved_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_tracker_sync (
        source_key TEXT PRIMARY KEY,
        service TEXT NOT NULL,
        watermark TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 0,
        synced_at INTEGER NOT NULL DEFAULT 0,
        full_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tracker_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lane TEXT NOT NULL,
        user_uuid TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        service TEXT NOT NULL,
        op TEXT NOT NULL,
        item_key TEXT NOT NULL DEFAULT '',
        coalesce_key TEXT,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        claimed_until INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_error TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tracker_outbox_coalesce ON tracker_outbox(lane, coalesce_key)`,
      `CREATE INDEX IF NOT EXISTS idx_tracker_outbox_title ON tracker_outbox(lane, item_key, id)`,
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
      `CREATE TABLE IF NOT EXISTS jellyfin_watch_index (
        source_key TEXT NOT NULL,
        video_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        meta_id TEXT NOT NULL DEFAULT '',
        media_type TEXT NOT NULL DEFAULT '',
        at INTEGER NOT NULL DEFAULT 0,
        listed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source_key, video_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_jellyfin_watch_index_listed ON jellyfin_watch_index(source_key, listed, at)`,
      `CREATE TABLE IF NOT EXISTS jellyfin_watch_series (
        source_key TEXT NOT NULL,
        series_key TEXT NOT NULL,
        group_key TEXT NOT NULL DEFAULT '',
        watched INTEGER NOT NULL,
        total INTEGER NOT NULL,
        at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source_key, series_key)
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_watch_summary (
        source_key TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_favourites (
        user_uuid TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        meta_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        meta_type TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_uuid, profile, meta_id)
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_dropped (
        user_uuid TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        meta_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_uuid, profile, meta_id)
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_ratings (
        user_uuid TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        meta_id TEXT NOT NULL,
        rating INTEGER NOT NULL,
        pmdb_id TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_uuid, profile, meta_id)
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_fingerprints (
        series_id TEXT NOT NULL,
        season INTEGER NOT NULL,
        episode INTEGER NOT NULL,
        kind TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        points TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (series_id, season, episode, kind)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_jellyfin_fingerprints_updated ON jellyfin_fingerprints(updated_at)`,
      `CREATE TABLE IF NOT EXISTS jellyfin_tokens (
        token_hash TEXT PRIMARY KEY,
        user_uuid TEXT NOT NULL,
        profile_id TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_jellyfin_tokens_user ON jellyfin_tokens(user_uuid)`,
      `CREATE INDEX IF NOT EXISTS idx_jellyfin_tokens_used ON jellyfin_tokens(last_used_at)`,
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
      `CREATE TABLE IF NOT EXISTS trusted_uuids (
        user_uuid TEXT UNIQUE NOT NULL,
        trusted_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS user_aliases (
        alias_lower TEXT PRIMARY KEY,
        alias TEXT NOT NULL,
        user_uuid TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS oauth_tokens (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        user_id TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        scope TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON oauth_tokens(provider)`,
      `CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_id ON oauth_tokens(user_id)`,
      `CREATE TABLE IF NOT EXISTS addon_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        username TEXT NOT NULL,
        email TEXT,
        groups_json TEXT,
        blocked INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_identity ON accounts(issuer, subject)`,
      `CREATE TABLE IF NOT EXISTS account_configs (
        account_id TEXT NOT NULL,
        user_uuid TEXT NOT NULL,
        label TEXT NOT NULL,
        linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_opened_at DATETIME,
        PRIMARY KEY (account_id, user_uuid),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_account_configs_uuid ON account_configs(user_uuid)`
    ];

    for (const query of queries) {
      await this.runQuery(query);
    }
  }

  async createPostgreSQLTables(): Promise<void> {
    const queries = [
      `CREATE TABLE IF NOT EXISTS user_configs (
        id SERIAL PRIMARY KEY,
        user_uuid VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        config_data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS id_mappings (
        id SERIAL PRIMARY KEY,
        content_type VARCHAR(50) NOT NULL,
        tmdb_id VARCHAR(255),
        tvdb_id VARCHAR(255),
        imdb_id VARCHAR(255),
        tvmaze_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(content_type, tmdb_id, tvdb_id, imdb_id, tvmaze_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_user_configs_created_at ON user_configs(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_id_mappings_tmdb ON id_mappings(tmdb_id)`,
      `CREATE INDEX IF NOT EXISTS idx_id_mappings_tvdb ON id_mappings(tvdb_id)`,
      `CREATE INDEX IF NOT EXISTS idx_id_mappings_imdb ON id_mappings(imdb_id)`,
      `CREATE INDEX IF NOT EXISTS idx_id_mappings_tvmaze ON id_mappings(tvmaze_id)`,
      `CREATE INDEX IF NOT EXISTS idx_id_mappings_content_type ON id_mappings(content_type)`,
      `CREATE TABLE IF NOT EXISTS jellyfin_ids (
        id VARCHAR(32) PRIMARY KEY,
        payload TEXT NOT NULL,
        codec_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_playstate (
        user_uuid VARCHAR(64) NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        video_id TEXT NOT NULL,
        position_ms BIGINT NOT NULL DEFAULT 0,
        runtime_ms BIGINT NOT NULL DEFAULT 0,
        played SMALLINT NOT NULL DEFAULT 0,
        play_count INTEGER NOT NULL DEFAULT 0,
        last_played_at BIGINT,
        updated_at BIGINT NOT NULL,
        origin TEXT,
        PRIMARY KEY (user_uuid, profile, video_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_jellyfin_playstate_recent ON jellyfin_playstate(user_uuid, profile, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_jellyfin_playstate_played ON jellyfin_playstate(last_played_at)`,
      `CREATE INDEX IF NOT EXISTS idx_jellyfin_playstate_user_played ON jellyfin_playstate(user_uuid, profile, played, last_played_at DESC, video_id)`,
      `CREATE TABLE IF NOT EXISTS jellyfin_preferences (
        user_uuid VARCHAR(64) NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        pref_id TEXT NOT NULL,
        client TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, profile, pref_id, client)
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_watchlist (
        user_uuid VARCHAR(64) NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        meta_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        meta_type TEXT,
        listed INTEGER NOT NULL DEFAULT 1,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, profile, meta_id)
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_tracker_mirror (
        source_key VARCHAR(64) NOT NULL,
        item_key TEXT NOT NULL,
        group_key TEXT NOT NULL DEFAULT '',
        sub_key TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (source_key, item_key)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_jellyfin_tracker_mirror_group ON jellyfin_tracker_mirror(source_key, group_key, sub_key)`,
      `CREATE TABLE IF NOT EXISTS jellyfin_id_resolutions (
        resolution_key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        resolved_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_tracker_sync (
        source_key VARCHAR(64) PRIMARY KEY,
        service TEXT NOT NULL,
        watermark TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 0,
        synced_at BIGINT NOT NULL DEFAULT 0,
        full_at BIGINT NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tracker_outbox (
        id BIGSERIAL PRIMARY KEY,
        lane VARCHAR(64) NOT NULL,
        user_uuid VARCHAR(64) NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        service VARCHAR(32) NOT NULL,
        op VARCHAR(32) NOT NULL,
        item_key TEXT NOT NULL DEFAULT '',
        coalesce_key TEXT,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        claimed_until BIGINT NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        last_error TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tracker_outbox_coalesce ON tracker_outbox(lane, coalesce_key)`,
      `CREATE INDEX IF NOT EXISTS idx_tracker_outbox_title ON tracker_outbox(lane, item_key, id)`,
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
      `CREATE TABLE IF NOT EXISTS jellyfin_watch_index (
        source_key VARCHAR(64) NOT NULL,
        video_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        meta_id TEXT NOT NULL DEFAULT '',
        media_type TEXT NOT NULL DEFAULT '',
        at BIGINT NOT NULL DEFAULT 0,
        listed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source_key, video_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_jellyfin_watch_index_listed ON jellyfin_watch_index(source_key, listed, at)`,
      `CREATE TABLE IF NOT EXISTS jellyfin_watch_series (
        source_key VARCHAR(64) NOT NULL,
        series_key TEXT NOT NULL,
        group_key TEXT NOT NULL DEFAULT '',
        watched INTEGER NOT NULL,
        total INTEGER NOT NULL,
        at BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (source_key, series_key)
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_watch_summary (
        source_key VARCHAR(64) PRIMARY KEY,
        version INTEGER NOT NULL,
        data TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_favourites (
        user_uuid VARCHAR(64) NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        meta_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        meta_type TEXT,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, profile, meta_id)
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_dropped (
        user_uuid VARCHAR(64) NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        meta_id TEXT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, profile, meta_id)
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_ratings (
        user_uuid VARCHAR(64) NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        meta_id TEXT NOT NULL,
        rating SMALLINT NOT NULL,
        pmdb_id TEXT,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, profile, meta_id)
      )`,
      `CREATE TABLE IF NOT EXISTS jellyfin_fingerprints (
        series_id TEXT NOT NULL,
        season INTEGER NOT NULL,
        episode INTEGER NOT NULL,
        kind VARCHAR(16) NOT NULL,
        start_ms BIGINT NOT NULL,
        points TEXT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (series_id, season, episode, kind)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_jellyfin_fingerprints_updated ON jellyfin_fingerprints(updated_at)`,
      `CREATE TABLE IF NOT EXISTS jellyfin_tokens (
        token_hash VARCHAR(64) PRIMARY KEY,
        user_uuid VARCHAR(64) NOT NULL,
        profile_id TEXT,
        created_at BIGINT NOT NULL,
        last_used_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_jellyfin_tokens_user ON jellyfin_tokens(user_uuid)`,
      `CREATE INDEX IF NOT EXISTS idx_jellyfin_tokens_used ON jellyfin_tokens(last_used_at)`,
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
      `CREATE TABLE IF NOT EXISTS trusted_uuids (
        user_uuid VARCHAR(255) UNIQUE NOT NULL,
        trusted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS user_aliases (
        alias_lower VARCHAR(64) PRIMARY KEY,
        alias VARCHAR(64) NOT NULL,
        user_uuid VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS oauth_tokens (
        id VARCHAR(255) PRIMARY KEY,
        provider VARCHAR(50) NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        scope TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON oauth_tokens(provider)`,
      `CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_id ON oauth_tokens(user_id)`,
      `CREATE TABLE IF NOT EXISTS addon_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS accounts (
        id VARCHAR(64) PRIMARY KEY,
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        username VARCHAR(255) NOT NULL,
        email VARCHAR(320),
        groups_json TEXT,
        blocked INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_identity ON accounts(issuer, subject)`,
      `CREATE TABLE IF NOT EXISTS account_configs (
        account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        user_uuid VARCHAR(255) NOT NULL,
        label VARCHAR(64) NOT NULL,
        linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_opened_at TIMESTAMP,
        PRIMARY KEY (account_id, user_uuid)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_account_configs_uuid ON account_configs(user_uuid)`
    ];

    for (const query of queries) {
      await this.runQuery(query);
    }
  }

  async runQuery(query: string, params: any[] = []): Promise<any> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (this.type === 'sqlite') {
      const statement = this.db.prepare(query);
      const result = this.executeSQLiteStatement(statement, 'run', params);
      return {
        lastID: Number(result.lastInsertRowid),
        changes: result.changes,
      };
    } else {
      const result = await this.db.query(query, params);
      return result;
    }
  }

  async getQuery(query: string, params: any[] = []): Promise<any> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (this.type === 'sqlite') {
      const statement = this.readDb.prepare(query);
      return this.executeSQLiteStatement(statement, 'get', params) || null;
    } else {
      const result = await this.readDb.query(query, params);
      return result.rows[0] || null;
    }
  }

  async allQuery(query: string, params: any[] = []): Promise<any[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (this.type === 'sqlite') {
      const statement = this.readDb.prepare(query);
      return this.executeSQLiteStatement(statement, 'all', params);
    } else {
      const result = await this.readDb.query(query, params);
      return result.rows;
    }
  }

  async allPrimaryQuery(query: string, params: any[] = []): Promise<any[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (this.type === 'sqlite') {
      return this.executeSQLiteStatement(this.db.prepare(query), 'all', params);
    }
    const result = await this.db.query(query, params);
    return result.rows;
  }

  generateUserUUID(): string {
    return crypto.randomUUID();
  }

  async saveUserConfig(userUUID: string, passwordHash: string, configData: any): Promise<any> {
    require('./signinGate').assertConfigWriteAllowed();

    let normalizedConfig = configData;

    if (typeof normalizedConfig === 'string') {
      try {
        normalizedConfig = JSON.parse(normalizedConfig);
      } catch (error) {
        normalizedConfig = null;
      }
    }

    const newAppPassword = typeof normalizedConfig?.jellyfinAppPassword === 'string' ? normalizedConfig.jellyfinAppPassword : '';
    const hasUsers = (Array.isArray(normalizedConfig?.jellyfinUsers) && normalizedConfig.jellyfinUsers.length > 0)
      || Boolean(normalizedConfig && 'jellyfinUserPin' in normalizedConfig);
    const previousConfig = newAppPassword || hasUsers ? await this.getUserConfig(userUUID).catch(() => null) : null;
    const previousAppPassword = newAppPassword ? previousConfig?.jellyfinAppPassword : undefined;
    const pinChanged = hasUsers ? await require('./jellyfin/pins').securePins(normalizedConfig, previousConfig) : [];

    let configJson: string;
    if (normalizedConfig && typeof normalizedConfig === 'object' && !Array.isArray(normalizedConfig)) {
      const configForHash = { ...normalizedConfig };
      delete configForHash.configHash;
      const configHash = crypto.createHash('md5').update(JSON.stringify(configForHash)).digest('hex').substring(0, 16);
      configJson = JSON.stringify({
        ...normalizedConfig,
        configHash
      });
    } else {
      configJson = typeof configData === 'string' ? configData : JSON.stringify(configData);
    }

    if (this.type === 'sqlite') {
      try {
        await this.runQuery(
          `INSERT INTO user_configs (user_uuid, password_hash, config_data, created_at, updated_at)
           VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [userUUID, passwordHash, configJson]
        );
      } catch (error: any) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.message.includes('UNIQUE constraint failed')) {
          await this.runQuery(
            `UPDATE user_configs SET password_hash = ?, config_data = ?, updated_at = CURRENT_TIMESTAMP
             WHERE user_uuid = ?`,
            [passwordHash, configJson, userUUID]
          );
        } else {
          throw error;
        }
      }
    } else {
      await this.runQuery(
        `INSERT INTO user_configs (user_uuid, password_hash, config_data, created_at, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (user_uuid)
         DO UPDATE SET password_hash = $2, config_data = $3, updated_at = CURRENT_TIMESTAMP`,
        [userUUID, passwordHash, configJson]
      );
    }

    await require('./configCache').del(userUUID).catch(() => undefined);

    // A replaced client password signs every client out.
    if (previousAppPassword && previousAppPassword !== newAppPassword) {
      await require('./jellyfin/tokens').revokeUserTokens(userUUID).catch((error: any) => logger.warn(`Signing out clients for ${userUUID} failed: ${error.message}`));
    }
    // A new or changed PIN signs that user out, so a device already signed in as them asks for it.
    for (const profileId of pinChanged) {
      await require('./jellyfin/tokens').revokeUserTokens(userUUID, profileId).catch((error: any) => logger.warn(`Signing out ${userUUID} user ${profileId ?? 'main'} failed: ${error.message}`));
    }

    try {
      return JSON.parse(configJson);
    } catch {
      return null;
    }
  }

  async getUserConfig(userUUID: string): Promise<any> {
    const query = this.type === 'sqlite'
      ? 'SELECT config_data FROM user_configs WHERE user_uuid = ?'
      : 'SELECT config_data FROM user_configs WHERE user_uuid = $1';
    const row = await this.getQuery(query, [userUUID]);

    if (!row) return null;

    try {
      return typeof row.config_data === 'string'
        ? JSON.parse(row.config_data)
        : row.config_data;
    } catch (error) {
      logger.error('Error parsing config data:', error);
      return null;
    }
  }

  async getUser(userUUID: string): Promise<any> {
    const query = this.type === 'sqlite'
      ? 'SELECT user_uuid, password_hash, created_at FROM user_configs WHERE user_uuid = ?'
      : 'SELECT user_uuid, password_hash, created_at FROM user_configs WHERE user_uuid = $1';
    const row = await this.getQuery(query, [userUUID]);
    return row;
  }

  async getAllUserUUIDs(): Promise<string[]> {
    const query = 'SELECT user_uuid FROM user_configs';
    const rows = await this.allQuery(query);
    return rows ? rows.map(row => row.user_uuid) : [];
  }


  async getUsersCreatedToday(): Promise<number> {
    const today = new Date().toISOString().substring(0, 10);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().substring(0, 10);
    const query = this.type === 'sqlite'
      ? 'SELECT COUNT(*) as count FROM user_configs WHERE created_at >= ? AND created_at < ?'
      : 'SELECT COUNT(*) as count FROM user_configs WHERE created_at >= $1 AND created_at < $2';
    const row = await this.getQuery(query, [today, tomorrow]);
    return row ? parseInt(row.count) : 0;
  }

  async getCachedIdMapping(contentType: string, tmdbId: string | null = null, tvdbId: string | null = null, imdbId: string | null = null, tvmazeId: string | null = null): Promise<any> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;
    const nextParam = () => `$${paramIndex++}`;

    params.push(contentType);
    const contentTypeCondition = this.type === 'sqlite' ? 'content_type = ?' : `content_type = ${nextParam()}`;

    if (tmdbId) {
      conditions.push(this.type === 'sqlite' ? 'tmdb_id = ?' : `tmdb_id = ${nextParam()}`);
      params.push(tmdbId);
    }
    if (tvdbId) {
      conditions.push(this.type === 'sqlite' ? 'tvdb_id = ?' : `tvdb_id = ${nextParam()}`);
      params.push(tvdbId);
    }
    if (imdbId) {
      conditions.push(this.type === 'sqlite' ? 'imdb_id = ?' : `imdb_id = ${nextParam()}`);
      params.push(imdbId);
    }
    if (tvmazeId) {
      conditions.push(this.type === 'sqlite' ? 'tvmaze_id = ?' : `tvmaze_id = ${nextParam()}`);
      params.push(tvmazeId);
    }

    if (conditions.length === 0) {
      return null;
    }

    const query = `
      SELECT tmdb_id, tvdb_id, imdb_id, tvmaze_id
      FROM id_mappings
      WHERE ${contentTypeCondition} AND (${conditions.join(' OR ')})
      LIMIT 1
    `;

    const result = await this.getQuery(query, params);
    return result;
  }

  async saveIdMapping(contentType: string, tmdbId: string | null = null, tvdbId: string | null = null, imdbId: string | null = null, tvmazeId: string | null = null): Promise<void> {
    if (!tmdbId && !tvdbId && !imdbId && !tvmazeId) return;
    const ids = [tmdbId, tvdbId, imdbId, tvmazeId].filter(Boolean);
    if (ids.length <= 1) return;

    if (this.type === 'sqlite') {
      await this.runQuery(
        `INSERT OR REPLACE INTO id_mappings (content_type, tmdb_id, tvdb_id, imdb_id, tvmaze_id, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [contentType, tmdbId, tvdbId, imdbId, tvmazeId]
      );
    } else {
      await this.runQuery(
        `INSERT INTO id_mappings (content_type, tmdb_id, tvdb_id, imdb_id, tvmaze_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
         ON CONFLICT (content_type, tmdb_id, tvdb_id, imdb_id, tvmaze_id)
         DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
        [contentType, tmdbId, tvdbId, imdbId, tvmazeId]
      );
    }
  }

  async getCachedMappingByAnyId(contentType: string, tmdbId: string | null = null, tvdbId: string | null = null, imdbId: string | null = null, tvmazeId: string | null = null): Promise<any> {
    const redisCached = await redisIdCache.searchByAnyId(contentType, tmdbId, tvdbId, imdbId, tvmazeId);
    if (redisCached) {
      return redisCached;
    }

    return null;
  }

  async verifyUserAndGetConfig(userUUID: string, password: string): Promise<any> {
    const query = this.type === 'sqlite'
      ? 'SELECT password_hash, config_data FROM user_configs WHERE user_uuid = ?'
      : 'SELECT password_hash, config_data FROM user_configs WHERE user_uuid = $1';
    const row = await this.getQuery(query, [userUUID]);
    if (!row) return null;

    const storedHash = row.password_hash;

    const isValidPassword = await this.verifyPasswordHash(password, storedHash);
    if (!isValidPassword) {
      return null;
    }

    if (!this.isBcryptHash(storedHash)) {
      try {
        const newBcryptHash = await this.hashPassword(password);
        const updateQuery = this.type === 'sqlite'
          ? 'UPDATE user_configs SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE user_uuid = ?'
          : 'UPDATE user_configs SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE user_uuid = $2';

        await this.runQuery(updateQuery, [newBcryptHash, userUUID]);
        logger.info(`Migrated user ${userUUID} from SHA-256 to bcrypt hash`);
      } catch (error) {
        logger.error(`Failed to migrate user ${userUUID} to bcrypt:`, error);
      }
    }

    try {
      return typeof row.config_data === 'string'
        ? JSON.parse(row.config_data)
        : row.config_data;
    } catch (error) {
      logger.error('Error parsing user config:', error);
      return null;
    }
  }

  async verifyPassword(userUUID: string, password: string): Promise<boolean> {
    const query = this.type === 'sqlite'
      ? 'SELECT password_hash FROM user_configs WHERE user_uuid = ?'
      : 'SELECT password_hash FROM user_configs WHERE user_uuid = $1';
    const row = await this.getQuery(query, [userUUID]);
    if (!row) return false;

    const storedHash = row.password_hash;
    return await this.verifyPasswordHash(password, storedHash);
  }

  async deleteUserConfig(userUUID: string): Promise<void> {
    const query = this.type === 'sqlite'
      ? 'DELETE FROM user_configs WHERE user_uuid = ?'
      : 'DELETE FROM user_configs WHERE user_uuid = $1';
    await this.runQuery(query, [userUUID]);
    await this.unlinkConfigFromAllAccounts(userUUID);
    await require('./configCache').del(userUUID).catch(() => undefined);
    await require('./jellyfin/context').forgetSeen([userUUID]).catch(() => undefined);
  }

  async deleteUser(userUUID: string): Promise<boolean> {
    try {
      const query = this.type === 'sqlite'
        ? 'DELETE FROM user_configs WHERE user_uuid = ?'
        : 'DELETE FROM user_configs WHERE user_uuid = $1';
      const result = await this.runQuery(query, [userUUID]);
      const userDeleted = this.type === 'sqlite' ? result.changes > 0 : result.rowCount > 0;

      const deleteTrustedQuery = this.type === 'sqlite'
        ? 'DELETE FROM trusted_uuids WHERE user_uuid = ?'
        : 'DELETE FROM trusted_uuids WHERE user_uuid = $1';
      await this.runQuery(deleteTrustedQuery, [userUUID]);
      await require('./jellyfin/tokens').revokeUserTokens(userUUID).catch(() => undefined);
      await require('./jellyfin/context').forgetSeen([userUUID]).catch(() => undefined);
      await this.deleteCalendarFeed(userUUID, null).catch(() => undefined);
      await this.deleteTrackerMatches(userUUID).catch(() => undefined);
      await this.deleteHistoryImport(userUUID).catch(() => undefined);

      const deleteAliasQuery = this.type === 'sqlite'
        ? 'DELETE FROM user_aliases WHERE user_uuid = ?'
        : 'DELETE FROM user_aliases WHERE user_uuid = $1';
      await this.runAliasCleanup(deleteAliasQuery, [userUUID]);
      await this.unlinkConfigFromAllAccounts(userUUID);

      // After the row is gone: clearing first lets a concurrent read cache it again.
      await require('./configCache').del(userUUID).catch(() => undefined);

      logger.info(`Successfully deleted user ${userUUID} and all associated data`);
      return userDeleted;
    } catch (error) {
      logger.error(`Error deleting user ${userUUID}:`, error);
      throw error;
    }
  }

  async trustUUID(userUUID: string): Promise<void> {
    if (this.type === 'sqlite') {
      await this.runQuery(
        `INSERT OR REPLACE INTO trusted_uuids (user_uuid, trusted_at) VALUES (?, CURRENT_TIMESTAMP)`,
        [userUUID]
      );
    } else {
      await this.runQuery(
        `INSERT INTO trusted_uuids (user_uuid, trusted_at) VALUES ($1, CURRENT_TIMESTAMP)
         ON CONFLICT (user_uuid) DO UPDATE SET trusted_at = CURRENT_TIMESTAMP`,
        [userUUID]
      );
    }
  }

  async isUUIDTrusted(userUUID: string): Promise<boolean> {
    const query = this.type === 'sqlite'
      ? 'SELECT trusted_at FROM trusted_uuids WHERE user_uuid = ?'
      : 'SELECT trusted_at FROM trusted_uuids WHERE user_uuid = $1';
    const row = await this.getQuery(query, [userUUID]);
    return !!row;
  }

  async untrustUUID(userUUID: string): Promise<void> {
    const query = this.type === 'sqlite'
      ? 'DELETE FROM trusted_uuids WHERE user_uuid = ?'
      : 'DELETE FROM trusted_uuids WHERE user_uuid = $1';
    await this.runQuery(query, [userUUID]);
  }

  private async runAliasCleanup(query: string, params: any[] = []): Promise<void> {
    try {
      await this.runQuery(query, params);
    } catch (error: any) {
      logger.warn(`Alias cleanup skipped: ${error.message}`);
    }
  }

  async getAllUserAliases(): Promise<Array<{ alias: string; alias_lower: string; user_uuid: string }>> {
    try {
      return await this.allQuery('SELECT alias, alias_lower, user_uuid FROM user_aliases');
    } catch (error) {
      logger.error('Error loading user aliases:', error);
      return [];
    }
  }

  async setUserAlias(userUUID: string, alias: string, aliasLower: string): Promise<void> {
    // Check the alias is free BEFORE touching this user's existing row. Without
    // this, claiming a taken alias would delete the user's current alias and
    // then fail on the insert, leaving them with no alias at all.
    const ownerQuery = this.type === 'sqlite'
      ? 'SELECT user_uuid FROM user_aliases WHERE alias_lower = ?'
      : 'SELECT user_uuid FROM user_aliases WHERE alias_lower = $1';
    const owner = await this.getQuery(ownerQuery, [aliasLower]);
    if (owner && owner.user_uuid !== userUUID) {
      const error: any = new Error(`UNIQUE constraint failed: alias "${alias}" is already taken`);
      error.code = 'ALIAS_TAKEN';
      throw error;
    }

    // One alias per user: drop any existing row for this user before claiming
    // the new alias, so reassigning does not leave the old alias resolvable.
    const deleteQuery = this.type === 'sqlite'
      ? 'DELETE FROM user_aliases WHERE user_uuid = ?'
      : 'DELETE FROM user_aliases WHERE user_uuid = $1';
    await this.runQuery(deleteQuery, [userUUID]);

    if (this.type === 'sqlite') {
      await this.runQuery(
        `INSERT INTO user_aliases (alias_lower, alias, user_uuid, created_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
        [aliasLower, alias, userUUID]
      );
    } else {
      await this.runQuery(
        `INSERT INTO user_aliases (alias_lower, alias, user_uuid, created_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
        [aliasLower, alias, userUUID]
      );
    }
  }

  async deleteUserAlias(userUUID: string): Promise<boolean> {
    const query = this.type === 'sqlite'
      ? 'DELETE FROM user_aliases WHERE user_uuid = ?'
      : 'DELETE FROM user_aliases WHERE user_uuid = $1';
    const result = await this.runQuery(query, [userUUID]);
    return this.type === 'sqlite' ? result.changes > 0 : result.rowCount > 0;
  }

  async pruneAllIdMappings(): Promise<void> {
    const query = 'DELETE FROM id_mappings';
    await this.runQuery(query);
    logger.info('Pruned all id_mappings.');
  }

  async getTotalIdMappingCount(): Promise<number> {
    const query = 'SELECT COUNT(*) as count FROM id_mappings';
    const result = await this.getQuery(query);
    return result ? result.count : 0;
  }

  async rememberJellyfinIds(
    rows: Array<{ id: string; payload: any; codecVersion: number }>
  ): Promise<void> {
    if (!rows.length) return;

    // One statement per chunk, so a page of new ids is a few commits rather than hundreds.
    const size = this.type === 'sqlite' ? 150 : 500;
    for (let i = 0; i < rows.length; i += size) {
      const chunk = rows.slice(i, i + size);
      const params: any[] = [];
      const values = chunk.map((row) => {
        params.push(row.id, JSON.stringify(row.payload), row.codecVersion);
        const at = params.length - 3;
        return this.type === 'sqlite' ? '(?, ?, ?)' : `($${at + 1}, $${at + 2}, $${at + 3})`;
      });
      const query = this.type === 'sqlite'
        ? `INSERT OR IGNORE INTO jellyfin_ids (id, payload, codec_version) VALUES ${values.join(', ')}`
        : `INSERT INTO jellyfin_ids (id, payload, codec_version) VALUES ${values.join(', ')} ON CONFLICT (id) DO NOTHING`;
      await this.runQuery(query, params);
    }
  }

  // The authority for what a client sees; trackers are told afterwards.
  async getPlaystate(userUUID: string, videoId: string, profile = ''): Promise<any | null> {
    const query = this.type === 'sqlite'
      ? 'SELECT * FROM jellyfin_playstate WHERE user_uuid = ? AND profile = ? AND video_id = ?'
      : 'SELECT * FROM jellyfin_playstate WHERE user_uuid = $1 AND profile = $2 AND video_id = $3';
    return (await this.getQuery(query, [userUUID, profile, videoId])) || null;
  }

  async getPlaystates(userUUID: string, videoIds: string[], profile = ''): Promise<Map<string, any>> {
    const out = new Map<string, any>();
    if (!videoIds.length) return out;

    const slice = 500;
    for (let at = 0; at < videoIds.length; at += slice) {
      const ids = videoIds.slice(at, at + slice);
      const marks = ids.map((_, i) => (this.type === 'sqlite' ? '?' : `$${i + 3}`)).join(', ');
      const query = this.type === 'sqlite'
        ? `SELECT * FROM jellyfin_playstate WHERE user_uuid = ? AND profile = ? AND video_id IN (${marks})`
        : `SELECT * FROM jellyfin_playstate WHERE user_uuid = $1 AND profile = $2 AND video_id IN (${marks})`;
      const rows = await this.allQuery(query, [userUUID, profile, ...ids]);
      for (const row of rows || []) out.set(row.video_id, row);
    }
    return out;
  }

  // A finished title with a position is a rewatch under way, so it belongs here.
  // Ordered by when it was played, not when the row was written: a sync writes
  // a whole history at once and would put it all at the top.
  async listResume(userUUID: string, limit: number, profile = ''): Promise<any[]> {
    const query = this.type === 'sqlite'
      ? 'SELECT * FROM jellyfin_playstate WHERE user_uuid = ? AND profile = ? AND position_ms > 0 ORDER BY COALESCE(last_played_at, updated_at) DESC LIMIT ?'
      : 'SELECT * FROM jellyfin_playstate WHERE user_uuid = $1 AND profile = $2 AND position_ms > 0 ORDER BY COALESCE(last_played_at, updated_at) DESC LIMIT $3';
    return (await this.allQuery(query, [userUUID, profile, limit])) || [];
  }

  // Only plays with a time: history a sync copied from a tracker carries none.
  async latestOwnPlayAmong(userUUID: string, profile: string, bases: string[]): Promise<{ videoId: string; at: number } | null> {
    if (!bases.length) return null;
    const p = this.type === 'sqlite' ? () => '?' : ((n = 0) => () => `$${++n}`)();
    const params: any[] = [userUUID, profile];
    const scope = `user_uuid = ${p()} AND profile = ${p()}`;
    const spelled = bases.map((base) => {
      params.push(`${base}:%`);
      return `video_id LIKE ${p()}`;
    });
    const query = `SELECT video_id, last_played_at FROM jellyfin_playstate WHERE ${scope}
      AND (origin = 'server' OR ((origin IS NULL OR origin = 'play') AND ABS(updated_at - last_played_at) < 2000))
      AND last_played_at IS NOT NULL AND (played = 1 OR position_ms > 0) AND (${spelled.join(' OR ')})
      ORDER BY last_played_at DESC, updated_at, video_id LIMIT 1`;
    const row = await this.getQuery(query, params);
    return row?.video_id ? { videoId: String(row.video_id), at: Number(row.last_played_at) } : null;
  }

  async listRecentlyPlayed(
    userUUID: string,
    since: number,
    limit: number,
    profile = '',
    after: { at: number; videoId: string } | null = null
  ): Promise<Array<{ video_id: string; last_played_at: number; updated_at: number; origin: string | null }>> {
    const p = this.type === 'sqlite' ? () => '?' : ((n = 0) => () => `$${++n}`)();
    const params: any[] = [userUUID, profile, since];
    let query = `SELECT video_id, last_played_at, updated_at, origin FROM jellyfin_playstate WHERE user_uuid = ${p()} AND profile = ${p()} AND played = 1 AND last_played_at >= ${p()} AND video_id LIKE '%:%:%'`;
    if (after) {
      query += ` AND (last_played_at < ${p()} OR (last_played_at = ${p()} AND video_id > ${p()}))`;
      params.push(after.at, after.at, after.videoId);
    }
    query += ` ORDER BY last_played_at DESC, video_id LIMIT ${p()}`;
    params.push(limit);
    return (await this.allQuery(query, params)) || [];
  }

  async countPlayedSince(since: number): Promise<number> {
    const query = this.type === 'sqlite'
      ? 'SELECT COUNT(*) AS count FROM jellyfin_playstate WHERE last_played_at >= ? AND played = 1'
      : 'SELECT COUNT(*) AS count FROM jellyfin_playstate WHERE last_played_at >= $1 AND played = 1';
    const row = await this.getQuery(query, [since]);
    return Number(row?.count) || 0;
  }

  async playstateForConfiguration(userUUID: string): Promise<any[]> {
    const query = this.type === 'sqlite'
      ? `SELECT profile, COUNT(*) AS rows_total,
                SUM(CASE WHEN position_ms > 0 THEN 1 ELSE 0 END) AS in_progress,
                SUM(CASE WHEN played = 1 THEN 1 ELSE 0 END) AS played,
                MAX(last_played_at) AS last_played_at, MAX(updated_at) AS updated_at
         FROM jellyfin_playstate WHERE user_uuid = ? GROUP BY profile`
      : `SELECT profile, COUNT(*) AS rows_total,
                SUM(CASE WHEN position_ms > 0 THEN 1 ELSE 0 END) AS in_progress,
                SUM(CASE WHEN played = 1 THEN 1 ELSE 0 END) AS played,
                MAX(last_played_at) AS last_played_at, MAX(updated_at) AS updated_at
         FROM jellyfin_playstate WHERE user_uuid = $1 GROUP BY profile`;
    return (await this.allQuery(query, [userUUID])) || [];
  }

  async watchedRowsForConfiguration(userUUID: string): Promise<any[]> {
    const query = this.type === 'sqlite'
      ? `SELECT profile, video_id, played, position_ms, last_played_at, origin FROM jellyfin_playstate
         WHERE user_uuid = ? AND (played = 1 OR position_ms > 0)`
      : `SELECT profile, video_id, played, position_ms, last_played_at, origin FROM jellyfin_playstate
         WHERE user_uuid = $1 AND (played = 1 OR position_ms > 0)`;
    return (await this.allQuery(query, [userUUID])) || [];
  }

  async outboxForConfiguration(userUUID: string, limit = 500): Promise<any[]> {
    const query = this.type === 'sqlite'
      ? 'SELECT profile, service, attempts, created_at, last_error FROM tracker_outbox WHERE user_uuid = ? AND expires_at > ? ORDER BY id LIMIT ?'
      : 'SELECT profile, service, attempts, created_at, last_error FROM tracker_outbox WHERE user_uuid = $1 AND expires_at > $2 ORDER BY id LIMIT $3';
    return (await this.allQuery(query, [userUUID, Date.now(), limit])) || [];
  }

  async findUserUUIDsByPrefix(prefix: string, limit: number): Promise<string[]> {
    const query = this.type === 'sqlite'
      ? 'SELECT user_uuid FROM user_configs WHERE user_uuid LIKE ? LIMIT ?'
      : 'SELECT user_uuid FROM user_configs WHERE user_uuid LIKE $1 LIMIT $2';
    const rows = await this.allQuery(query, [`${prefix}%`, limit]);
    return rows ? rows.map((row: any) => row.user_uuid) : [];
  }

  async listPlaystateInProgressFor(userUUID: string, limit: number, profile: string | null = null): Promise<any[]> {
    const scoped = profile === null ? '' : (this.type === 'sqlite' ? ' AND profile = ?' : ' AND profile = $3');
    const query = this.type === 'sqlite'
      ? `SELECT * FROM jellyfin_playstate WHERE user_uuid = ? AND position_ms > 0${scoped} ORDER BY COALESCE(last_played_at, updated_at) DESC, updated_at, video_id LIMIT ?`
      : `SELECT * FROM jellyfin_playstate WHERE user_uuid = $1 AND position_ms > 0${scoped} ORDER BY COALESCE(last_played_at, updated_at) DESC, updated_at, video_id LIMIT $2`;
    return (await this.allQuery(query, profile === null ? [userUUID, limit] : this.type === 'sqlite' ? [userUUID, profile, limit] : [userUUID, limit, profile])) || [];
  }

  async listPlaystatePlayedFor(userUUID: string, limit: number, profile: string | null = null): Promise<any[]> {
    const scoped = profile === null ? '' : (this.type === 'sqlite' ? ' AND profile = ?' : ' AND profile = $3');
    const query = this.type === 'sqlite'
      ? `SELECT * FROM jellyfin_playstate WHERE user_uuid = ? AND played = 1 AND last_played_at IS NOT NULL${scoped} ORDER BY last_played_at DESC LIMIT ?`
      : `SELECT * FROM jellyfin_playstate WHERE user_uuid = $1 AND played = 1 AND last_played_at IS NOT NULL${scoped} ORDER BY last_played_at DESC LIMIT $2`;
    return (await this.allQuery(query, profile === null ? [userUUID, limit] : this.type === 'sqlite' ? [userUUID, profile, limit] : [userUUID, limit, profile])) || [];
  }

  async listPlayedVideoIds(userUUID: string, limit: number, profile = ''): Promise<string[]> {
    const query = this.type === 'sqlite'
      ? 'SELECT video_id FROM jellyfin_playstate WHERE user_uuid = ? AND profile = ? AND played = 1 ORDER BY COALESCE(last_played_at, updated_at) DESC LIMIT ?'
      : 'SELECT video_id FROM jellyfin_playstate WHERE user_uuid = $1 AND profile = $2 AND played = 1 ORDER BY COALESCE(last_played_at, updated_at) DESC LIMIT $3';
    const rows = (await this.allQuery(query, [userUUID, profile, limit])) || [];
    return rows.map((row: any) => String(row.video_id));
  }

  async listUnwatchedVideoIds(userUUID: string, limit: number, profile = ''): Promise<Array<{ video_id: string; updated_at: number }>> {
    const query = this.type === 'sqlite'
      ? 'SELECT video_id, updated_at FROM jellyfin_playstate WHERE user_uuid = ? AND profile = ? AND played = 0 AND play_count > 0 ORDER BY updated_at DESC LIMIT ?'
      : 'SELECT video_id, updated_at FROM jellyfin_playstate WHERE user_uuid = $1 AND profile = $2 AND played = 0 AND play_count > 0 ORDER BY updated_at DESC LIMIT $3';
    return (await this.allQuery(query, [userUUID, profile, limit])) || [];
  }

  async listPlaystateFor(userUUID: string): Promise<any[]> {
    const query = this.type === 'sqlite'
      ? 'SELECT * FROM jellyfin_playstate WHERE user_uuid = ? ORDER BY profile, COALESCE(last_played_at, updated_at) DESC'
      : 'SELECT * FROM jellyfin_playstate WHERE user_uuid = $1 ORDER BY profile, COALESCE(last_played_at, updated_at) DESC';
    return (await this.allQuery(query, [userUUID])) || [];
  }

  async upsertPlaystate(
    userUUID: string,
    videoId: string,
    patch: { positionMs?: number; runtimeMs?: number; played?: boolean; lastPlayedAt?: number | null; origin?: string | null; watch?: WatchPatch },
    profile = '',
    writtenAt?: number
  ): Promise<void> {
    const existing = await this.getPlaystate(userUUID, videoId, profile);
    const now = writtenAt ?? Date.now();

    const positionMs = patch.positionMs ?? existing?.position_ms ?? 0;
    const runtimeMs = patch.runtimeMs ?? existing?.runtime_ms ?? 0;
    const played = patch.played ?? Boolean(existing?.played);
    const becamePlayed = patch.played === true && !existing?.played;
    const origin = patch.origin === undefined ? (existing?.origin ?? null) : patch.origin;

    let logged = false;
    if (patch.played === false) {
      await this.deleteWatches(userUUID, profile, videoId);
    } else if (patch.watch && Number.isFinite(patch.watch.at) && patch.watch.at > 0) {
      logged = await this.logWatch(userUUID, profile, videoId, patch.watch, Boolean(existing?.played), origin);
    }
    const playCount = (existing?.play_count ?? 0) + (becamePlayed || (logged && patch.watch?.kind === 'finish') ? 1 : 0);
    const lastPlayedAt = patch.lastPlayedAt === undefined ? (existing?.last_played_at ?? null) : patch.lastPlayedAt;

    const query = this.type === 'sqlite'
      ? `INSERT INTO jellyfin_playstate (user_uuid, profile, video_id, position_ms, runtime_ms, played, play_count, last_played_at, updated_at, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_uuid, profile, video_id) DO UPDATE SET
           position_ms = excluded.position_ms, runtime_ms = excluded.runtime_ms, played = excluded.played,
           play_count = excluded.play_count, last_played_at = excluded.last_played_at, updated_at = excluded.updated_at,
           origin = excluded.origin`
      : `INSERT INTO jellyfin_playstate (user_uuid, profile, video_id, position_ms, runtime_ms, played, play_count, last_played_at, updated_at, origin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (user_uuid, profile, video_id) DO UPDATE SET
           position_ms = EXCLUDED.position_ms, runtime_ms = EXCLUDED.runtime_ms, played = EXCLUDED.played,
           play_count = EXCLUDED.play_count, last_played_at = EXCLUDED.last_played_at, updated_at = EXCLUDED.updated_at,
           origin = EXCLUDED.origin`;

    await this.runQuery(query, [userUUID, profile, videoId, positionMs, runtimeMs, played ? 1 : 0, playCount, lastPlayedAt, now, origin]);
  }

  async logWatch(userUUID: string, profile: string, videoId: string, watch: WatchPatch, wasPlayed: boolean, origin: string | null): Promise<boolean> {
    if (watch.kind === 'first' && wasPlayed) return false;
    const sqlite = this.type === 'sqlite';
    if (watch.kind !== 'first') {
      const since = watch.kind === 'dated' ? 0 : Math.round(watch.at - Math.max(0, watch.gapMs ?? 0));
      const held = await this.getQuery(
        sqlite
          ? 'SELECT 1 AS held FROM jellyfin_watches WHERE user_uuid = ? AND profile = ? AND video_id = ? AND watched_at >= ? LIMIT 1'
          : 'SELECT 1 AS held FROM jellyfin_watches WHERE user_uuid = $1 AND profile = $2 AND video_id = $3 AND watched_at >= $4 LIMIT 1',
        [userUUID, profile, videoId, since]
      );
      if (held) return false;
    }
    const result = await this.runQuery(
      sqlite
        ? 'INSERT INTO jellyfin_watches (user_uuid, profile, video_id, watched_at, origin) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING'
        : 'INSERT INTO jellyfin_watches (user_uuid, profile, video_id, watched_at, origin) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
      [userUUID, profile, videoId, Math.round(watch.at), origin]
    );
    return (Number(sqlite ? result?.changes : result?.rowCount) || 0) > 0;
  }

  async deleteWatches(userUUID: string, profile: string, videoId: string): Promise<void> {
    const query = this.type === 'sqlite'
      ? 'DELETE FROM jellyfin_watches WHERE user_uuid = ? AND profile = ? AND video_id = ?'
      : 'DELETE FROM jellyfin_watches WHERE user_uuid = $1 AND profile = $2 AND video_id = $3';
    await this.runQuery(query, [userUUID, profile, videoId]);
  }

  async redateWatch(userUUID: string, profile: string, videoIds: string[], from: number | null, to: number, withinMs: number, merge = false): Promise<{ moved: number; latestBefore: number | null; latestAfter: number | null }> {
    const sqlite = this.type === 'sqlite';
    const ids = [...new Set(videoIds)];
    const latestOf = (rows: Array<{ watched_at: number }>) => (rows.length ? Math.max(...rows.map((row) => row.watched_at)) : null);
    const before = await this.listWatchesFor(userUUID, profile, ids);
    let moved = 0;
    for (const id of ids) {
      const own = before.filter((row) => row.video_id === id);
      let origin: string | null;
      if (from === null) {
        const state = own.length ? null : await this.getPlaystate(userUUID, id, profile);
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
    const after = moved ? await this.listWatchesFor(userUUID, profile, ids) : before;
    if (moved) {
      const now = Date.now();
      for (const id of ids) {
        const latest = latestOf(after.filter((row) => row.video_id === id));
        if (latest === null) continue;
        await this.runQuery(
          sqlite
            ? 'UPDATE jellyfin_playstate SET last_played_at = ?, updated_at = ? WHERE user_uuid = ? AND profile = ? AND video_id = ? AND played = 1 AND position_ms = 0'
            : 'UPDATE jellyfin_playstate SET last_played_at = $1, updated_at = $2 WHERE user_uuid = $3 AND profile = $4 AND video_id = $5 AND played = 1 AND position_ms = 0',
          [latest, now, userUUID, profile, id]
        );
      }
    }
    return { moved, latestBefore: latestOf(before), latestAfter: latestOf(after) };
  }

  async listWatchesFor(userUUID: string, profile: string, videoIds: string[]): Promise<Array<{ video_id: string; watched_at: number; origin: string | null }>> {
    const out: any[] = [];
    const ids = [...new Set(videoIds)];
    for (let at = 0; at < ids.length; at += 500) {
      const chunk = ids.slice(at, at + 500);
      const marks = chunk.map((_, i) => (this.type === 'sqlite' ? '?' : `$${i + 3}`)).join(', ');
      const query = this.type === 'sqlite'
        ? `SELECT video_id, watched_at, origin FROM jellyfin_watches WHERE user_uuid = ? AND profile = ? AND video_id IN (${marks})`
        : `SELECT video_id, watched_at, origin FROM jellyfin_watches WHERE user_uuid = $1 AND profile = $2 AND video_id IN (${marks})`;
      out.push(...((await this.allQuery(query, [userUUID, profile, ...chunk])) || []));
    }
    return out.map((row) => ({ video_id: String(row.video_id), watched_at: Number(row.watched_at), origin: row.origin ?? null }));
  }

  async watchedVideoIds(userUUID: string, profile = ''): Promise<Set<string>> {
    const query = this.type === 'sqlite'
      ? 'SELECT DISTINCT video_id FROM jellyfin_watches WHERE user_uuid = ? AND profile = ?'
      : 'SELECT DISTINCT video_id FROM jellyfin_watches WHERE user_uuid = $1 AND profile = $2';
    return new Set(((await this.allQuery(query, [userUUID, profile])) || []).map((row: any) => String(row.video_id)));
  }

  async listViewingHistory(userUUID: string, limit: number, profile: string | null = null): Promise<any[]> {
    const sqlite = this.type === 'sqlite';
    const scoped = profile === null ? '' : ` AND w.profile = ${sqlite ? '?' : '$3'}`;
    const query = `SELECT w.profile, w.video_id, w.watched_at, w.origin,
        p.position_ms, p.runtime_ms, p.played, p.last_played_at, p.updated_at,
        (SELECT COUNT(*) FROM jellyfin_watches e WHERE e.user_uuid = w.user_uuid AND e.profile = w.profile AND e.video_id = w.video_id AND e.watched_at < w.watched_at) AS earlier
      FROM jellyfin_watches w
      LEFT JOIN jellyfin_playstate p ON p.user_uuid = w.user_uuid AND p.profile = w.profile AND p.video_id = w.video_id
      WHERE w.user_uuid = ${sqlite ? '?' : '$1'}${scoped}
      ORDER BY w.watched_at DESC, p.updated_at IS NULL, p.updated_at, w.video_id LIMIT ${sqlite ? '?' : '$2'}`;
    const params = profile === null ? [userUUID, limit] : sqlite ? [userUUID, profile, limit] : [userUUID, limit, profile];
    return (await this.allQuery(query, params)) || [];
  }

  async listWatchesByOrigin(userUUID: string, origins: string[]): Promise<Array<{ profile: string; video_id: string; watched_at: number; origin: string | null }>> {
    const sqlite = this.type === 'sqlite';
    const marks = origins.map((_, i) => (sqlite ? '?' : `$${i + 2}`)).join(', ');
    const rows = await this.allQuery(`SELECT profile, video_id, watched_at, origin FROM jellyfin_watches WHERE user_uuid = ${sqlite ? '?' : '$1'} AND origin IN (${marks})`, [userUUID, ...origins]);
    return (rows || []).map((row: any) => ({ profile: String(row.profile ?? ''), video_id: String(row.video_id), watched_at: Number(row.watched_at), origin: row.origin ?? null }));
  }

  async listWatchesSince(userUUID: string, since: number): Promise<Array<{ profile: string; video_id: string; watched_at: number; origin: string | null }>> {
    const query = this.type === 'sqlite'
      ? 'SELECT profile, video_id, watched_at, origin FROM jellyfin_watches WHERE user_uuid = ? AND watched_at >= ?'
      : 'SELECT profile, video_id, watched_at, origin FROM jellyfin_watches WHERE user_uuid = $1 AND watched_at >= $2';
    return ((await this.allQuery(query, [userUUID, since])) || []).map((row: any) => ({ profile: String(row.profile ?? ''), video_id: String(row.video_id), watched_at: Number(row.watched_at), origin: row.origin ?? null }));
  }

  async listWatchesForConfiguration(userUUID: string): Promise<any[]> {
    const query = this.type === 'sqlite'
      ? 'SELECT profile, video_id, watched_at, origin FROM jellyfin_watches WHERE user_uuid = ? ORDER BY profile, watched_at DESC'
      : 'SELECT profile, video_id, watched_at, origin FROM jellyfin_watches WHERE user_uuid = $1 ORDER BY profile, watched_at DESC';
    return (await this.allQuery(query, [userUUID])) || [];
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

  async writePlaystateRow(userUUID: string, profile: string, videoId: string, row: { positionMs: number; runtimeMs: number; played: boolean; playCount: number; lastPlayedAt: number | null; updatedAt: number; origin: string | null }): Promise<void> {
    const query = this.type === 'sqlite'
      ? `INSERT INTO jellyfin_playstate (user_uuid, profile, video_id, position_ms, runtime_ms, played, play_count, last_played_at, updated_at, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_uuid, profile, video_id) DO UPDATE SET
           position_ms = excluded.position_ms, runtime_ms = excluded.runtime_ms, played = excluded.played,
           play_count = excluded.play_count, last_played_at = excluded.last_played_at, updated_at = excluded.updated_at,
           origin = excluded.origin`
      : `INSERT INTO jellyfin_playstate (user_uuid, profile, video_id, position_ms, runtime_ms, played, play_count, last_played_at, updated_at, origin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (user_uuid, profile, video_id) DO UPDATE SET
           position_ms = EXCLUDED.position_ms, runtime_ms = EXCLUDED.runtime_ms, played = EXCLUDED.played,
           play_count = EXCLUDED.play_count, last_played_at = EXCLUDED.last_played_at, updated_at = EXCLUDED.updated_at,
           origin = EXCLUDED.origin`;
    await this.runQuery(query, [userUUID, profile, videoId, row.positionMs, row.runtimeMs, row.played ? 1 : 0, row.playCount, row.lastPlayedAt, row.updatedAt, row.origin]);
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

  async currentPlaystate(userUUID: string, profile: string, videoId: string): Promise<any | null> {
    const sqlite = this.type === 'sqlite';
    const [row] = await this.allPrimaryQuery(
      `SELECT * FROM jellyfin_playstate WHERE user_uuid = ${sqlite ? '?' : '$1'} AND profile = ${sqlite ? '?' : '$2'} AND video_id = ${sqlite ? '?' : '$3'}`,
      [userUUID, profile, videoId]
    );
    return row ?? null;
  }

  async hasWatchNear(userUUID: string, profile: string, videoId: string, at: number, withinMs: number): Promise<boolean> {
    const sqlite = this.type === 'sqlite';
    const rows = await this.allPrimaryQuery(
      `SELECT 1 AS held FROM jellyfin_watches WHERE user_uuid = ${sqlite ? '?' : '$1'} AND profile = ${sqlite ? '?' : '$2'} AND video_id = ${sqlite ? '?' : '$3'}
       AND watched_at >= ${sqlite ? '?' : '$4'} AND watched_at <= ${sqlite ? '?' : '$5'} LIMIT 1`,
      [userUUID, profile, videoId, Math.round(at - withinMs), Math.round(at + withinMs)]
    );
    return rows.length > 0;
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

  async countWatchesSince(since: number): Promise<number> {
    const query = this.type === 'sqlite'
      ? 'SELECT COUNT(*) AS count FROM (SELECT DISTINCT user_uuid, profile, watched_at FROM jellyfin_watches WHERE watched_at >= ?) w'
      : 'SELECT COUNT(*) AS count FROM (SELECT DISTINCT user_uuid, profile, watched_at FROM jellyfin_watches WHERE watched_at >= $1) w';
    const row = await this.getQuery(query, [since]);
    return Number(row?.count) || 0;
  }

  /** A title's play state, newest first, for the profiles given; imported rows left out for localOnly. */
  async listHistoryRows(
    userUUID: string,
    profiles: string[],
    opts: { limit: number; after?: { sortAt: number; profile: string; videoId: string }; localOnly?: boolean }
  ): Promise<any[]> {
    if (!profiles.length) return [];
    const params: any[] = [];
    const mark = (value: any) => {
      params.push(value);
      return this.type === 'sqlite' ? '?' : `$${params.length}`;
    };
    const sortAt = 'COALESCE(last_played_at, updated_at)';
    const where = [
      `user_uuid = ${mark(userUUID)}`,
      `profile IN (${profiles.map((profile) => mark(profile)).join(', ')})`,
      '(played = 1 OR position_ms > 0)',
    ];
    if (opts.localOnly) where.push(`NOT (${IMPORTED_PLAYSTATE})`);
    if (opts.after) {
      const at = mark(opts.after.sortAt);
      const at2 = mark(opts.after.sortAt);
      const profile = mark(opts.after.profile);
      const profile2 = mark(opts.after.profile);
      const videoId = mark(opts.after.videoId);
      where.push(`(${sortAt} < ${at} OR (${sortAt} = ${at2} AND (profile > ${profile} OR (profile = ${profile2} AND video_id > ${videoId}))))`);
    }
    const limit = mark(opts.limit);
    const query = `SELECT profile, video_id, position_ms, runtime_ms, played, play_count, last_played_at, updated_at, origin, ${sortAt} AS sort_at
      FROM jellyfin_playstate WHERE ${where.join(' AND ')}
      ORDER BY sort_at DESC, profile, video_id LIMIT ${limit}`;
    return (await this.allQuery(query, params)) || [];
  }

  /** The profiles' played and started rows in key order, a page at a time, for an export. */
  async listPlaystatePage(userUUID: string, profiles: string[], limit: number, after?: { profile: string; videoId: string }): Promise<any[]> {
    if (!profiles.length) return [];
    const params: any[] = [];
    const mark = (value: any) => {
      params.push(value);
      return this.type === 'sqlite' ? '?' : `$${params.length}`;
    };
    const where = [
      `user_uuid = ${mark(userUUID)}`,
      `profile IN (${profiles.map((profile) => mark(profile)).join(', ')})`,
      '(played = 1 OR position_ms > 0)',
    ];
    if (after) {
      const profile = mark(after.profile);
      const profile2 = mark(after.profile);
      const videoId = mark(after.videoId);
      where.push(`(profile > ${profile} OR (profile = ${profile2} AND video_id > ${videoId}))`);
    }
    const query = `SELECT profile, video_id, position_ms, runtime_ms, played, play_count, last_played_at, updated_at, origin
      FROM jellyfin_playstate WHERE ${where.join(' AND ')} ORDER BY profile, video_id LIMIT ${mark(limit)}`;
    return (await this.allQuery(query, params)) || [];
  }

  /** Removes a profile's play state and watches, for the titles given or all of them. */
  async clearHistory(userUUID: string, profile: string, videoIds?: string[]): Promise<number> {
    const sqlite = this.type === 'sqlite';
    const scoped = (table: string, ids: string[] | undefined) => {
      const params: any[] = [userUUID, profile, ...(ids ?? [])];
      const marks = (ids ?? []).map((_, i) => (sqlite ? '?' : `$${i + 3}`)).join(', ');
      const where = `user_uuid = ${sqlite ? '?' : '$1'} AND profile = ${sqlite ? '?' : '$2'}${ids ? ` AND video_id IN (${marks})` : ''}`;
      return { sql: `DELETE FROM ${table} WHERE ${where}`, params };
    };
    let cleared = 0;
    const chunks = videoIds ? Array.from({ length: Math.ceil(videoIds.length / 500) }, (_, i) => videoIds.slice(i * 500, i * 500 + 500)) : [undefined];
    for (const ids of chunks) {
      const playstate = scoped('jellyfin_playstate', ids);
      const result = await this.runQuery(playstate.sql, playstate.params);
      cleared += Number(sqlite ? result?.changes : result?.rowCount) || 0;
      const watches = scoped('jellyfin_watches', ids);
      await this.runQuery(watches.sql, watches.params);
    }
    return cleared;
  }

  async deleteImportedPlaystate(userUUID: string, profile: string): Promise<number> {
    const [a, b] = this.type === 'sqlite' ? ['?', '?'] : ['$1', '$2'];
    const where = `user_uuid = ${a} AND profile = ${b} AND (${IMPORTED_PLAYSTATE})`;
    const counted: any = await this.getQuery(`SELECT COUNT(*) AS count FROM jellyfin_playstate WHERE ${where}`, [userUUID, profile]);
    await this.runQuery(`DELETE FROM jellyfin_playstate WHERE ${where}`, [userUUID, profile]);
    await this.runQuery(`DELETE FROM jellyfin_watches WHERE user_uuid = ${a} AND profile = ${b} AND (
      (origin IS NOT NULL AND origin NOT IN ('server', 'play'))
      OR NOT EXISTS (SELECT 1 FROM jellyfin_playstate p WHERE p.user_uuid = jellyfin_watches.user_uuid AND p.profile = jellyfin_watches.profile AND p.video_id = jellyfin_watches.video_id))`, [userUUID, profile]);
    return Number(counted?.count) || 0;
  }

  async getPreferences(userUUID: string, profile: string, prefId: string, client: string): Promise<any | null> {
    const query = this.type === 'sqlite'
      ? 'SELECT data FROM jellyfin_preferences WHERE user_uuid = ? AND profile = ? AND pref_id = ? AND client = ?'
      : 'SELECT data FROM jellyfin_preferences WHERE user_uuid = $1 AND profile = $2 AND pref_id = $3 AND client = $4';
    const row = await this.getQuery(query, [userUUID, profile, prefId, client]);
    if (!row?.data) return null;
    try {
      return JSON.parse(row.data);
    } catch {
      return null;
    }
  }

  async savePreferences(userUUID: string, profile: string, prefId: string, client: string, data: any): Promise<void> {
    const query = this.type === 'sqlite'
      ? `INSERT INTO jellyfin_preferences (user_uuid, profile, pref_id, client, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_uuid, profile, pref_id, client) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      : `INSERT INTO jellyfin_preferences (user_uuid, profile, pref_id, client, data, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_uuid, profile, pref_id, client) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`;
    await this.runQuery(query, [userUUID, profile, prefId, client, JSON.stringify(data), Date.now()]);
  }

  async listWatchlist(userUUID: string, profile = ''): Promise<any[]> {
    const query = this.type === 'sqlite'
      ? 'SELECT meta_id, media_type, meta_type, listed, updated_at FROM jellyfin_watchlist WHERE user_uuid = ? AND profile = ? ORDER BY updated_at DESC'
      : 'SELECT meta_id, media_type, meta_type, listed, updated_at FROM jellyfin_watchlist WHERE user_uuid = $1 AND profile = $2 ORDER BY updated_at DESC';
    return this.allQuery(query, [userUUID, profile]);
  }

  // listed=0 is a removal kept until the trackers stop listing the title.
  async setWatchlisted(userUUID: string, profile: string, metaId: string, mediaType: string, listed: boolean, metaType: string | null = null, updatedAt = Date.now()): Promise<void> {
    const query = this.type === 'sqlite'
      ? `INSERT INTO jellyfin_watchlist (user_uuid, profile, meta_id, media_type, meta_type, listed, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_uuid, profile, meta_id) DO UPDATE SET media_type = excluded.media_type, meta_type = COALESCE(excluded.meta_type, jellyfin_watchlist.meta_type), listed = excluded.listed, updated_at = excluded.updated_at`
      : `INSERT INTO jellyfin_watchlist (user_uuid, profile, meta_id, media_type, meta_type, listed, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_uuid, profile, meta_id) DO UPDATE SET media_type = EXCLUDED.media_type, meta_type = COALESCE(EXCLUDED.meta_type, jellyfin_watchlist.meta_type), listed = EXCLUDED.listed, updated_at = EXCLUDED.updated_at`;
    await this.runQuery(query, [userUUID, profile, metaId, mediaType, metaType, listed ? 1 : 0, updatedAt]);
  }

  async setMetaType(table: 'jellyfin_watchlist', userUUID: string, profile: string, metaId: string, metaType: string): Promise<void> {
    const query = this.type === 'sqlite'
      ? `UPDATE ${table} SET meta_type = ? WHERE user_uuid = ? AND profile = ? AND meta_id = ?`
      : `UPDATE ${table} SET meta_type = $1 WHERE user_uuid = $2 AND profile = $3 AND meta_id = $4`;
    await this.runQuery(query, [metaType, userUUID, profile, metaId]);
  }

  // How a tracker names an episode or film, resolved to the ids this server publishes.
  // The same for every user, so one user's lookups serve the next.
  async getIdResolutions(keys: string[]): Promise<Array<{ resolution_key: string; value: string; resolved_at: number }>> {
    const out: any[] = [];
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500);
      const marks = chunk.map((_, n) => (this.type === 'sqlite' ? '?' : `$${n + 1}`)).join(', ');
      out.push(...(await this.allQuery(`SELECT resolution_key, value, resolved_at FROM jellyfin_id_resolutions WHERE resolution_key IN (${marks})`, chunk)));
    }
    return out;
  }

  async putIdResolutions(entries: Array<{ key: string; value: string }>): Promise<void> {
    const now = Date.now();
    const size = this.type === 'sqlite' ? 150 : 500;
    for (let i = 0; i < entries.length; i += size) {
      const chunk = entries.slice(i, i + size);
      const params: any[] = [];
      const values = chunk.map((entry) => {
        params.push(entry.key, entry.value, now);
        const at = params.length - 3;
        return this.type === 'sqlite' ? '(?, ?, ?)' : `($${at + 1}, $${at + 2}, $${at + 3})`;
      });
      const conflict = this.type === 'sqlite'
        ? 'ON CONFLICT (resolution_key) DO UPDATE SET value = excluded.value, resolved_at = excluded.resolved_at'
        : 'ON CONFLICT (resolution_key) DO UPDATE SET value = EXCLUDED.value, resolved_at = EXCLUDED.resolved_at';
      await this.runQuery(`INSERT INTO jellyfin_id_resolutions (resolution_key, value, resolved_at) VALUES ${values.join(', ')} ${conflict}`, params);
    }
  }

  // Writes waiting for a tracker, delivered in order per account and retried until they land.
  async enqueueTrackerOutbox(rows: Array<{ lane: string; userUUID: string; profile: string; service: string; op: string; item: string; coalesce: string | null; payload: any; expiresAt: number }>): Promise<void> {
    const sqlite = this.type === 'sqlite';
    const now = Date.now();
    for (const row of rows) {
      // A newer write for the same thing replaces one still waiting, never one being sent.
      if (row.coalesce) {
        await this.runQuery(
          sqlite
            ? 'DELETE FROM tracker_outbox WHERE lane = ? AND coalesce_key = ? AND claimed_until <= ?'
            : 'DELETE FROM tracker_outbox WHERE lane = $1 AND coalesce_key = $2 AND claimed_until <= $3',
          [row.lane, row.coalesce, now]
        );
      }
      await this.runQuery(
        sqlite
          ? `INSERT INTO tracker_outbox (lane, user_uuid, profile, service, op, item_key, coalesce_key, payload, next_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          : `INSERT INTO tracker_outbox (lane, user_uuid, profile, service, op, item_key, coalesce_key, payload, next_at, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [row.lane, row.userUUID, row.profile || '', row.service, row.op, row.item, row.coalesce, JSON.stringify(row.payload), now, Math.round(row.expiresAt), now]
      );
    }
  }

  async readyTrackerOutbox(now: number, limit: number): Promise<any[]> {
    const sqlite = this.type === 'sqlite';
    const at = sqlite ? '?' : '$1';
    const rows = await this.allPrimaryQuery(
      `SELECT id, lane, user_uuid, profile, service, op, item_key, payload, attempts, next_at, expires_at, claimed_until, created_at FROM (
         SELECT o.*, ROW_NUMBER() OVER (PARTITION BY o.lane ORDER BY o.id) AS lane_rank
         FROM tracker_outbox o
         WHERE o.next_at <= ${at} AND o.claimed_until <= ${at}
           AND NOT EXISTS (SELECT 1 FROM tracker_outbox c WHERE c.lane = o.lane AND c.claimed_until > ${at})
           AND NOT EXISTS (SELECT 1 FROM tracker_outbox w WHERE w.lane = o.lane AND w.item_key = o.item_key AND w.id < o.id AND w.next_at > ${at})
       ) ready WHERE lane_rank = 1 ORDER BY id LIMIT ${sqlite ? '?' : '$2'}`,
      sqlite ? [now, now, now, now, limit] : [now, limit]
    );
    // Postgres hands BIGINT back as a string.
    return rows.map((row: any) => ({
      ...row,
      id: Number(row.id),
      attempts: Number(row.attempts),
      next_at: Number(row.next_at),
      expires_at: Number(row.expires_at),
      claimed_until: Number(row.claimed_until),
      created_at: Number(row.created_at),
    }));
  }

  async trackerOutboxWakeAt(now: number): Promise<number | null> {
    const sqlite = this.type === 'sqlite';
    const at = sqlite ? '?' : '$1';
    const [row] = await this.allPrimaryQuery(
      `SELECT MIN(CASE WHEN claimed_until > ${at} THEN claimed_until ELSE next_at END) AS wake_at FROM tracker_outbox WHERE claimed_until > ${at} OR next_at > ${at}`,
      sqlite ? [now, now, now] : [now]
    );
    const wakeAt = Number(row?.wake_at);
    return Number.isFinite(wakeAt) && wakeAt > 0 ? wakeAt : null;
  }

  async purgeTrackerOutbox(now: number): Promise<Array<{ user_uuid: string; profile: string; service: string; op: string }>> {
    const sqlite = this.type === 'sqlite';
    const rows = (await this.allPrimaryQuery(
      sqlite
        ? 'SELECT id, user_uuid, profile, service, op FROM tracker_outbox WHERE expires_at <= ? AND claimed_until <= ?'
        : 'SELECT id, user_uuid, profile, service, op FROM tracker_outbox WHERE expires_at <= $1 AND claimed_until <= $1',
      sqlite ? [now, now] : [now]
    )) || [];
    for (let at = 0; at < rows.length; at += 500) {
      const ids = rows.slice(at, at + 500).map((row: any) => Number(row.id));
      const marks = ids.map((_, i) => (sqlite ? '?' : `$${i + 2}`)).join(', ');
      await this.runQuery(`DELETE FROM tracker_outbox WHERE claimed_until <= ${sqlite ? '?' : '$1'} AND id IN (${marks})`, [now, ...ids]);
    }
    return rows;
  }

  async claimTrackerOutbox(id: number, until: number): Promise<boolean> {
    const result = await this.runQuery(
      this.type === 'sqlite'
        ? 'UPDATE tracker_outbox SET claimed_until = ? WHERE id = ? AND claimed_until <= ?'
        : 'UPDATE tracker_outbox SET claimed_until = $1 WHERE id = $2 AND claimed_until <= $3',
      [until, id, Date.now()]
    );
    return Number(result?.changes ?? result?.rowCount ?? 0) === 1;
  }

  async retryTrackerOutbox(id: number, attempts: number, nextAt: number, error: string): Promise<void> {
    await this.runQuery(
      this.type === 'sqlite'
        ? 'UPDATE tracker_outbox SET attempts = ?, next_at = ?, last_error = ?, claimed_until = 0 WHERE id = ?'
        : 'UPDATE tracker_outbox SET attempts = $1, next_at = $2, last_error = $3, claimed_until = 0 WHERE id = $4',
      [attempts, Math.round(nextAt), error.slice(0, 500), id]
    );
  }

  async listTrackerOutboxLane(lane: string): Promise<Array<{ op: string; item_key: string; payload: string; created_at: number }>> {
    const sqlite = this.type === 'sqlite';
    const rows = await this.allQuery(
      `SELECT op, item_key, payload, created_at FROM tracker_outbox WHERE lane = ${sqlite ? '?' : '$1'} AND expires_at > ${sqlite ? '?' : '$2'} ORDER BY id`,
      [lane, Date.now()]
    );
    return rows.map((row: any) => ({ ...row, created_at: Number(row.created_at) }));
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
    const rows = (await this.allQuery(`SELECT id, profile, service, op, item_key, payload FROM tracker_outbox WHERE ${where}`, params)) || [];
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

  async deleteTrackerOutbox(id: number): Promise<void> {
    await this.runQuery(`DELETE FROM tracker_outbox WHERE id = ${this.type === 'sqlite' ? '?' : '$1'}`, [id]);
  }

  // A tracker account's watched titles as this server publishes them, built from its mirror,
  // so a page asks for its own titles rather than holding the whole library.
  async getWatchSummary(sourceKey: string): Promise<{ version: number; data: any } | null> {
    const row = await this.getQuery(`SELECT version, data FROM jellyfin_watch_summary WHERE source_key = ${this.type === 'sqlite' ? '?' : '$1'}`, [sourceKey]);
    if (!row) return null;
    try {
      return { version: Number(row.version), data: JSON.parse(row.data) };
    } catch {
      return null;
    }
  }

  async putWatchSummary(sourceKey: string, version: number, data: any): Promise<void> {
    const query = this.type === 'sqlite'
      ? `INSERT INTO jellyfin_watch_summary (source_key, version, data, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (source_key) DO UPDATE SET version = excluded.version, data = excluded.data, updated_at = excluded.updated_at`
      : `INSERT INTO jellyfin_watch_summary (source_key, version, data, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (source_key) DO UPDATE SET version = EXCLUDED.version, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`;
    await this.runQuery(query, [sourceKey, version, JSON.stringify(data), Date.now()]);
  }

  private async selectAmong(query: (marks: string) => string, sourceKey: string, keys: string[]): Promise<any[]> {
    const out: any[] = [];
    const unique = [...new Set(keys)];
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500);
      const marks = chunk.map((_, n) => (this.type === 'sqlite' ? '?' : `$${n + 2}`)).join(', ');
      out.push(...(await this.allQuery(query(marks), [sourceKey, ...chunk])));
    }
    return out;
  }

  async listWatchIndex(sourceKey: string): Promise<Array<{ video_id: string; kind: string; meta_id: string; media_type: string; at: number; listed: number }>> {
    const rows = await this.allQuery(`SELECT video_id, kind, meta_id, media_type, at, listed FROM jellyfin_watch_index WHERE source_key = ${this.type === 'sqlite' ? '?' : '$1'}`, [sourceKey]);
    return rows.map((row: any) => ({ ...row, at: Number(row.at), listed: Number(row.listed) }));
  }

  async watchIndexAmong(sourceKey: string, videoIds: string[]): Promise<Array<{ video_id: string; kind: string; at: number }>> {
    const rows = await this.selectAmong(
      (marks) => `SELECT video_id, kind, at FROM jellyfin_watch_index WHERE source_key = ${this.type === 'sqlite' ? '?' : '$1'} AND video_id IN (${marks})`,
      sourceKey,
      videoIds
    );
    return rows.map((row: any) => ({ ...row, at: Number(row.at) }));
  }

  async watchIndexSince(sourceKey: string, since: number): Promise<Array<{ video_id: string; kind: string; meta_id: string; at: number }>> {
    const sqlite = this.type === 'sqlite';
    const rows = await this.allQuery(
      `SELECT video_id, kind, meta_id, at FROM jellyfin_watch_index WHERE source_key = ${sqlite ? '?' : '$1'} AND listed = 1 AND at >= ${sqlite ? '?' : '$2'}`,
      [sourceKey, since]
    );
    return rows.map((row: any) => ({ ...row, at: Number(row.at) }));
  }

  /** One row per title, newest first. */
  async listWatchHistory(sourceKey: string, kinds: string[], limit: number): Promise<Array<{ video_id: string; kind: string; meta_id: string; media_type: string; at: number }>> {
    const sqlite = this.type === 'sqlite';
    const marks = kinds.map((_, n) => (sqlite ? '?' : `$${n + 2}`)).join(', ');
    const rows = await this.allQuery(
      `SELECT video_id, kind, meta_id, media_type, at FROM jellyfin_watch_index WHERE source_key = ${sqlite ? '?' : '$1'} AND listed = 1 AND kind IN (${marks}) ORDER BY at DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
      [sourceKey, ...kinds]
    );
    return rows.map((row: any) => ({ ...row, at: Number(row.at) }));
  }

  async upsertWatchIndex(sourceKey: string, rows: Array<{ video_id: string; kind: string; meta_id: string; media_type: string; at: number; listed: number }>): Promise<void> {
    const sqlite = this.type === 'sqlite';
    const size = sqlite ? 100 : 500;
    for (let i = 0; i < rows.length; i += size) {
      const chunk = rows.slice(i, i + size);
      const params: any[] = [];
      const values = chunk.map((row) => {
        params.push(sourceKey, row.video_id, row.kind, row.meta_id, row.media_type, Math.round(row.at), row.listed);
        const at = params.length - 7;
        return sqlite ? '(?, ?, ?, ?, ?, ?, ?)' : `($${at + 1}, $${at + 2}, $${at + 3}, $${at + 4}, $${at + 5}, $${at + 6}, $${at + 7})`;
      });
      const ex = sqlite ? 'excluded' : 'EXCLUDED';
      await this.runQuery(
        `INSERT INTO jellyfin_watch_index (source_key, video_id, kind, meta_id, media_type, at, listed) VALUES ${values.join(', ')}
         ON CONFLICT (source_key, video_id) DO UPDATE SET kind = ${ex}.kind, meta_id = ${ex}.meta_id, media_type = ${ex}.media_type, at = ${ex}.at, listed = ${ex}.listed`,
        params
      );
      if (rows.length > size) await new Promise((resolve) => setImmediate(resolve));
    }
  }

  async deleteWatchIndex(sourceKey: string, videoIds: string[]): Promise<void> {
    for (let i = 0; i < videoIds.length; i += 200) {
      const chunk = videoIds.slice(i, i + 200);
      const marks = chunk.map((_, n) => (this.type === 'sqlite' ? '?' : `$${n + 2}`)).join(', ');
      await this.runQuery(`DELETE FROM jellyfin_watch_index WHERE source_key = ${this.type === 'sqlite' ? '?' : '$1'} AND video_id IN (${marks})`, [sourceKey, ...chunk]);
    }
  }

  private seriesRow(row: any): { series_key: string; group_key: string; watched: number; total: number; at: number } {
    return { series_key: row.series_key, group_key: row.group_key, watched: Number(row.watched), total: Number(row.total), at: Number(row.at) };
  }

  async listWatchSeries(sourceKey: string): Promise<Array<{ series_key: string; group_key: string; watched: number; total: number; at: number }>> {
    const rows = await this.allQuery(`SELECT series_key, group_key, watched, total, at FROM jellyfin_watch_series WHERE source_key = ${this.type === 'sqlite' ? '?' : '$1'}`, [sourceKey]);
    return rows.map((row: any) => this.seriesRow(row));
  }

  async watchSeriesAmong(sourceKey: string, keys: string[]): Promise<Array<{ series_key: string; group_key: string; watched: number; total: number; at: number }>> {
    const rows = await this.selectAmong(
      (marks) => `SELECT series_key, group_key, watched, total, at FROM jellyfin_watch_series WHERE source_key = ${this.type === 'sqlite' ? '?' : '$1'} AND series_key IN (${marks})`,
      sourceKey,
      keys
    );
    return rows.map((row: any) => this.seriesRow(row));
  }

  /** Each finished show once, under the first id it answers to. */
  async listFinishedSeries(sourceKey: string): Promise<Array<{ series_key: string; at: number }>> {
    const rows = await this.allQuery(
      `SELECT series_key, at FROM jellyfin_watch_series WHERE source_key = ${this.type === 'sqlite' ? '?' : '$1'} AND series_key = group_key AND total > 0 AND watched >= total`,
      [sourceKey]
    );
    return rows.map((row: any) => ({ series_key: row.series_key, at: Number(row.at) }));
  }

  async upsertWatchSeries(sourceKey: string, rows: Array<{ series_key: string; group_key: string; watched: number; total: number; at: number }>): Promise<void> {
    const sqlite = this.type === 'sqlite';
    const size = sqlite ? 150 : 500;
    for (let i = 0; i < rows.length; i += size) {
      const chunk = rows.slice(i, i + size);
      const params: any[] = [];
      const values = chunk.map((row) => {
        params.push(sourceKey, row.series_key, row.group_key, row.watched, row.total, Math.round(row.at));
        const at = params.length - 6;
        return sqlite ? '(?, ?, ?, ?, ?, ?)' : `($${at + 1}, $${at + 2}, $${at + 3}, $${at + 4}, $${at + 5}, $${at + 6})`;
      });
      const ex = sqlite ? 'excluded' : 'EXCLUDED';
      await this.runQuery(
        `INSERT INTO jellyfin_watch_series (source_key, series_key, group_key, watched, total, at) VALUES ${values.join(', ')}
         ON CONFLICT (source_key, series_key) DO UPDATE SET group_key = ${ex}.group_key, watched = ${ex}.watched, total = ${ex}.total, at = ${ex}.at`,
        params
      );
    }
  }

  async deleteWatchSeries(sourceKey: string, keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 200) {
      const chunk = keys.slice(i, i + 200);
      const marks = chunk.map((_, n) => (this.type === 'sqlite' ? '?' : `$${n + 2}`)).join(', ');
      await this.runQuery(`DELETE FROM jellyfin_watch_series WHERE source_key = ${this.type === 'sqlite' ? '?' : '$1'} AND series_key IN (${marks})`, [sourceKey, ...chunk]);
    }
  }

  // A tracker account's library, mirrored here and kept current from its changes alone.
  // Keyed by the account rather than a user, so configurations sharing one share it.
  async getTrackerSync(sourceKey: string): Promise<any | null> {
    const query = this.type === 'sqlite'
      ? 'SELECT source_key, service, watermark, version, synced_at, full_at FROM jellyfin_tracker_sync WHERE source_key = ?'
      : 'SELECT source_key, service, watermark, version, synced_at, full_at FROM jellyfin_tracker_sync WHERE source_key = $1';
    return this.getQuery(query, [sourceKey]);
  }

  /** Adds `bump` to the stored version, keeping any bump made while the sync ran, and returns the result. */
  async setTrackerSync(sourceKey: string, service: string, state: { watermark: string; bump: number; syncedAt: number; fullAt: number }): Promise<number> {
    const sqlite = this.type === 'sqlite';
    const query = sqlite
      ? `INSERT INTO jellyfin_tracker_sync (source_key, service, watermark, version, synced_at, full_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_key) DO UPDATE SET service = excluded.service, watermark = excluded.watermark, version = jellyfin_tracker_sync.version + excluded.version,
           synced_at = excluded.synced_at, full_at = excluded.full_at, updated_at = excluded.updated_at`
      : `INSERT INTO jellyfin_tracker_sync (source_key, service, watermark, version, synced_at, full_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (source_key) DO UPDATE SET service = EXCLUDED.service, watermark = EXCLUDED.watermark, version = jellyfin_tracker_sync.version + EXCLUDED.version,
           synced_at = EXCLUDED.synced_at, full_at = EXCLUDED.full_at, updated_at = EXCLUDED.updated_at`;
    await this.runQuery(query, [sourceKey, service, state.watermark, state.bump, state.syncedAt, state.fullAt, Date.now()]);
    const [row] = await this.allPrimaryQuery(`SELECT version FROM jellyfin_tracker_sync WHERE source_key = ${sqlite ? '?' : '$1'}`, [sourceKey]);
    return Number(row?.version) || 0;
  }

  async bumpTrackerSyncVersion(sourceKey: string): Promise<void> {
    const query = this.type === 'sqlite'
      ? 'UPDATE jellyfin_tracker_sync SET version = version + 1, updated_at = ? WHERE source_key = ? AND version > 0'
      : 'UPDATE jellyfin_tracker_sync SET version = version + 1, updated_at = $1 WHERE source_key = $2 AND version > 0';
    await this.runQuery(query, [Date.now(), sourceKey]);
  }

  async listTrackerMirror(sourceKey: string): Promise<Array<{ item_key: string; group_key: string; sub_key: string; data: string }>> {
    const query = this.type === 'sqlite'
      ? 'SELECT item_key, group_key, sub_key, data FROM jellyfin_tracker_mirror WHERE source_key = ?'
      : 'SELECT item_key, group_key, sub_key, data FROM jellyfin_tracker_mirror WHERE source_key = $1';
    return this.allQuery(query, [sourceKey]);
  }

  async listTrackerMirrorGroup(sourceKey: string, group: string): Promise<Array<{ item_key: string; data: string }>> {
    const sqlite = this.type === 'sqlite';
    return this.allQuery(`SELECT item_key, data FROM jellyfin_tracker_mirror WHERE source_key = ${sqlite ? '?' : '$1'} AND group_key = ${sqlite ? '?' : '$2'}`, [sourceKey, group]);
  }

  /** The mirror's keys without their data, for deciding what an import must fetch or drop. */
  async listTrackerMirrorKeys(sourceKey: string): Promise<Array<{ item_key: string; group_key: string; sub_key: string }>> {
    const query = this.type === 'sqlite'
      ? 'SELECT item_key, group_key, sub_key FROM jellyfin_tracker_mirror WHERE source_key = ?'
      : 'SELECT item_key, group_key, sub_key FROM jellyfin_tracker_mirror WHERE source_key = $1';
    return this.allQuery(query, [sourceKey]);
  }

  async hasTrackerMirrorKeys(sourceKey: string, keys: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (let i = 0; i < keys.length; i += 200) {
      const chunk = keys.slice(i, i + 200);
      const marks = chunk.map((_, n) => (this.type === 'sqlite' ? '?' : `$${n + 2}`)).join(', ');
      const query = `SELECT item_key FROM jellyfin_tracker_mirror WHERE source_key = ${this.type === 'sqlite' ? '?' : '$1'} AND item_key IN (${marks})`;
      for (const row of await this.allQuery(query, [sourceKey, ...chunk])) found.add(String(row.item_key));
    }
    return found;
  }

  async upsertTrackerMirror(sourceKey: string, rows: Array<{ key: string; group?: string; sub?: string; data: any }>): Promise<void> {
    const now = Date.now();
    const size = this.type === 'sqlite' ? 100 : 500;
    for (let i = 0; i < rows.length; i += size) {
      const chunk = rows.slice(i, i + size);
      const params: any[] = [];
      const values = chunk.map((row) => {
        params.push(sourceKey, row.key, row.group ?? '', row.sub ?? '', JSON.stringify(row.data), now);
        const at = params.length - 6;
        return this.type === 'sqlite' ? '(?, ?, ?, ?, ?, ?)' : `($${at + 1}, $${at + 2}, $${at + 3}, $${at + 4}, $${at + 5}, $${at + 6})`;
      });
      const conflict = this.type === 'sqlite'
        ? 'ON CONFLICT (source_key, item_key) DO UPDATE SET group_key = excluded.group_key, sub_key = excluded.sub_key, data = excluded.data, updated_at = excluded.updated_at'
        : 'ON CONFLICT (source_key, item_key) DO UPDATE SET group_key = EXCLUDED.group_key, sub_key = EXCLUDED.sub_key, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at';
      await this.runQuery(`INSERT INTO jellyfin_tracker_mirror (source_key, item_key, group_key, sub_key, data, updated_at) VALUES ${values.join(', ')} ${conflict}`, params);
      // Other requests get the loop between chunks of a large first import.
      if (rows.length > size) await new Promise((resolve) => setImmediate(resolve));
    }
  }

  async deleteTrackerMirror(sourceKey: string, keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 200) {
      const chunk = keys.slice(i, i + 200);
      const marks = chunk.map((_, n) => (this.type === 'sqlite' ? '?' : `$${n + 2}`)).join(', ');
      await this.runQuery(`DELETE FROM jellyfin_tracker_mirror WHERE source_key = ${this.type === 'sqlite' ? '?' : '$1'} AND item_key IN (${marks})`, [sourceKey, ...chunk]);
    }
  }

  /** Every row of a group, such as a show's episodes, or only one sub-group of it, such as a season. */
  async deleteTrackerMirrorGroup(sourceKey: string, group: string, sub?: string): Promise<void> {
    const sqlite = this.type === 'sqlite';
    if (sub === undefined) {
      await this.runQuery(`DELETE FROM jellyfin_tracker_mirror WHERE source_key = ${sqlite ? '?' : '$1'} AND group_key = ${sqlite ? '?' : '$2'}`, [sourceKey, group]);
      return;
    }
    await this.runQuery(`DELETE FROM jellyfin_tracker_mirror WHERE source_key = ${sqlite ? '?' : '$1'} AND group_key = ${sqlite ? '?' : '$2'} AND sub_key = ${sqlite ? '?' : '$3'}`, [sourceKey, group, sub]);
  }

  async saveFingerprint(seriesId: string, season: number, episode: number, kind: string, startMs: number, points: string): Promise<void> {
    const query = this.type === 'sqlite'
      ? 'INSERT INTO jellyfin_fingerprints (series_id, season, episode, kind, start_ms, points, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (series_id, season, episode, kind) DO UPDATE SET start_ms = excluded.start_ms, points = excluded.points, updated_at = excluded.updated_at'
      : 'INSERT INTO jellyfin_fingerprints (series_id, season, episode, kind, start_ms, points, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (series_id, season, episode, kind) DO UPDATE SET start_ms = EXCLUDED.start_ms, points = EXCLUDED.points, updated_at = EXCLUDED.updated_at';
    await this.runQuery(query, [seriesId, season, episode, kind, Math.round(startMs), points, Date.now()]);
  }

  async listFingerprints(seriesId: string, season: number, kind: string): Promise<any[]> {
    const query = this.type === 'sqlite'
      ? 'SELECT episode, start_ms, points FROM jellyfin_fingerprints WHERE series_id = ? AND season = ? AND kind = ?'
      : 'SELECT episode, start_ms, points FROM jellyfin_fingerprints WHERE series_id = $1 AND season = $2 AND kind = $3';
    return this.allQuery(query, [seriesId, season, kind]);
  }

  async pruneFingerprints(before: number): Promise<void> {
    const query = this.type === 'sqlite'
      ? 'DELETE FROM jellyfin_fingerprints WHERE updated_at < ?'
      : 'DELETE FROM jellyfin_fingerprints WHERE updated_at < $1';
    await this.runQuery(query, [before]);
  }

  async listDropped(userUUID: string, profile = ''): Promise<any[]> {
    const query = this.type === 'sqlite'
      ? 'SELECT meta_id, updated_at FROM jellyfin_dropped WHERE user_uuid = ? AND profile = ?'
      : 'SELECT meta_id, updated_at FROM jellyfin_dropped WHERE user_uuid = $1 AND profile = $2';
    return this.allQuery(query, [userUUID, profile]);
  }

  async setDropped(userUUID: string, profile: string, metaIds: string[], dropped: boolean, updatedAt = Date.now()): Promise<void> {
    for (const metaId of metaIds) {
      if (dropped) {
        const query = this.type === 'sqlite'
          ? 'INSERT INTO jellyfin_dropped (user_uuid, profile, meta_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_uuid, profile, meta_id) DO UPDATE SET updated_at = excluded.updated_at'
          : 'INSERT INTO jellyfin_dropped (user_uuid, profile, meta_id, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (user_uuid, profile, meta_id) DO UPDATE SET updated_at = EXCLUDED.updated_at';
        await this.runQuery(query, [userUUID, profile, metaId, updatedAt]);
      } else {
        const query = this.type === 'sqlite'
          ? 'DELETE FROM jellyfin_dropped WHERE user_uuid = ? AND profile = ? AND meta_id = ?'
          : 'DELETE FROM jellyfin_dropped WHERE user_uuid = $1 AND profile = $2 AND meta_id = $3';
        await this.runQuery(query, [userUUID, profile, metaId]);
      }
    }
  }

  async listRatings(userUUID: string, profile: string, metaIds: string[]): Promise<any[]> {
    if (!metaIds.length) return [];
    const marks = metaIds.map((_, i) => (this.type === 'sqlite' ? '?' : `$${i + 3}`)).join(', ');
    const query = this.type === 'sqlite'
      ? `SELECT meta_id, rating, pmdb_id, updated_at FROM jellyfin_ratings WHERE user_uuid = ? AND profile = ? AND meta_id IN (${marks})`
      : `SELECT meta_id, rating, pmdb_id, updated_at FROM jellyfin_ratings WHERE user_uuid = $1 AND profile = $2 AND meta_id IN (${marks})`;
    return this.allQuery(query, [userUUID, profile, ...metaIds]);
  }

  async listProfileRatings(userUUID: string, profile: string, limit: number): Promise<any[]> {
    const query = this.type === 'sqlite'
      ? 'SELECT meta_id, rating, meta_type, updated_at FROM jellyfin_ratings WHERE user_uuid = ? AND profile = ? ORDER BY updated_at DESC LIMIT ?'
      : 'SELECT meta_id, rating, meta_type, updated_at FROM jellyfin_ratings WHERE user_uuid = $1 AND profile = $2 ORDER BY updated_at DESC LIMIT $3';
    return (await this.allQuery(query, [userUUID, profile, limit])) || [];
  }

  async listPlayedForProfile(userUUID: string, profile: string): Promise<any[]> {
    const query = this.type === 'sqlite'
      ? 'SELECT video_id, played, position_ms, runtime_ms, play_count, last_played_at, updated_at, origin FROM jellyfin_playstate WHERE user_uuid = ? AND profile = ? AND (played = 1 OR position_ms > 0)'
      : 'SELECT video_id, played, position_ms, runtime_ms, play_count, last_played_at, updated_at, origin FROM jellyfin_playstate WHERE user_uuid = $1 AND profile = $2 AND (played = 1 OR position_ms > 0)';
    return (await this.allQuery(query, [userUUID, profile])) || [];
  }

  async hasPlays(userUUID: string): Promise<boolean> {
    const query = this.type === 'sqlite'
      ? 'SELECT 1 AS found FROM jellyfin_playstate WHERE user_uuid = ? AND played = 1 LIMIT 1'
      : 'SELECT 1 AS found FROM jellyfin_playstate WHERE user_uuid = $1 AND played = 1 LIMIT 1';
    return !!(await this.getQuery(query, [userUUID]));
  }

  async playstateVersion(userUUID: string, profile: string): Promise<string> {
    const query = this.type === 'sqlite'
      ? 'SELECT COUNT(*) AS n, MAX(COALESCE(last_played_at, updated_at)) AS at FROM jellyfin_playstate WHERE user_uuid = ? AND profile = ? AND played = 1'
      : 'SELECT COUNT(*) AS n, MAX(COALESCE(last_played_at, updated_at)) AS at FROM jellyfin_playstate WHERE user_uuid = $1 AND profile = $2 AND played = 1';
    const row = await this.getQuery(query, [userUUID, profile]);
    return `${Number(row?.n) || 0}-${Number(row?.at) || 0}`;
  }

  async setRating(userUUID: string, profile: string, metaIds: string[], rating: number | null, metaType: string | null = null, updatedAt = Date.now()): Promise<void> {
    for (const metaId of metaIds) {
      if (rating !== null) {
        const query = this.type === 'sqlite'
          ? 'INSERT INTO jellyfin_ratings (user_uuid, profile, meta_id, rating, meta_type, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_uuid, profile, meta_id) DO UPDATE SET rating = excluded.rating, meta_type = COALESCE(excluded.meta_type, jellyfin_ratings.meta_type), updated_at = excluded.updated_at'
          : 'INSERT INTO jellyfin_ratings (user_uuid, profile, meta_id, rating, meta_type, updated_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (user_uuid, profile, meta_id) DO UPDATE SET rating = EXCLUDED.rating, meta_type = COALESCE(EXCLUDED.meta_type, jellyfin_ratings.meta_type), updated_at = EXCLUDED.updated_at';
        await this.runQuery(query, [userUUID, profile, metaId, rating, metaType, updatedAt]);
      } else {
        const query = this.type === 'sqlite'
          ? 'DELETE FROM jellyfin_ratings WHERE user_uuid = ? AND profile = ? AND meta_id = ?'
          : 'DELETE FROM jellyfin_ratings WHERE user_uuid = $1 AND profile = $2 AND meta_id = $3';
        await this.runQuery(query, [userUUID, profile, metaId]);
      }
    }
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

  async setRatingRemoteId(userUUID: string, profile: string, metaIds: string[], pmdbId: string): Promise<number> {
    if (!metaIds.length) return 0;
    const marks = metaIds.map((_, i) => (this.type === 'sqlite' ? '?' : `$${i + 4}`)).join(', ');
    const query = this.type === 'sqlite'
      ? `UPDATE jellyfin_ratings SET pmdb_id = ? WHERE user_uuid = ? AND profile = ? AND meta_id IN (${marks})`
      : `UPDATE jellyfin_ratings SET pmdb_id = $1 WHERE user_uuid = $2 AND profile = $3 AND meta_id IN (${marks})`;
    const result: any = await this.runQuery(query, [pmdbId, userUUID, profile, ...metaIds]);
    return Number(result?.changes ?? result?.rowCount ?? 0);
  }

  async insertJellyfinToken(tokenHash: string, userUUID: string, profileId: string | null, now: number): Promise<void> {
    const query = this.type === 'sqlite'
      ? 'INSERT INTO jellyfin_tokens (token_hash, user_uuid, profile_id, created_at, last_used_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (token_hash) DO NOTHING'
      : 'INSERT INTO jellyfin_tokens (token_hash, user_uuid, profile_id, created_at, last_used_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (token_hash) DO NOTHING';
    await this.runQuery(query, [tokenHash, userUUID, profileId, now, now]);
  }

  // Read from the primary: a replica behind it would reject a token minted a moment ago.
  async findJellyfinToken(tokenHash: string): Promise<{ user_uuid: string; profile_id: string | null; last_used_at: number } | null> {
    if (!this.initialized) await this.initialize();
    if (this.type === 'sqlite') {
      return this.getQuery('SELECT user_uuid, profile_id, last_used_at FROM jellyfin_tokens WHERE token_hash = ?', [tokenHash]);
    }
    const result = await this.db.query('SELECT user_uuid, profile_id, last_used_at FROM jellyfin_tokens WHERE token_hash = $1', [tokenHash]);
    const row = result.rows[0];
    return row ? { ...row, last_used_at: Number(row.last_used_at) } : null;
  }

  async touchJellyfinToken(tokenHash: string, now: number): Promise<void> {
    const query = this.type === 'sqlite'
      ? 'UPDATE jellyfin_tokens SET last_used_at = ? WHERE token_hash = ?'
      : 'UPDATE jellyfin_tokens SET last_used_at = $1 WHERE token_hash = $2';
    await this.runQuery(query, [now, tokenHash]);
  }

  async deleteJellyfinToken(tokenHash: string): Promise<void> {
    const query = this.type === 'sqlite'
      ? 'DELETE FROM jellyfin_tokens WHERE token_hash = ?'
      : 'DELETE FROM jellyfin_tokens WHERE token_hash = $1';
    await this.runQuery(query, [tokenHash]);
  }

  async deleteJellyfinTokensForUser(userUUID: string): Promise<void> {
    const query = this.type === 'sqlite'
      ? 'DELETE FROM jellyfin_tokens WHERE user_uuid = ?'
      : 'DELETE FROM jellyfin_tokens WHERE user_uuid = $1';
    await this.runQuery(query, [userUUID]);
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

  async listTrackerMatches(userUUID: string, service: string): Promise<Array<{ base: string; match_group: string; data: string }>> {
    const query = this.type === 'sqlite'
      ? 'SELECT base, match_group, data FROM tracker_matches WHERE user_uuid = ? AND service = ?'
      : 'SELECT base, match_group, data FROM tracker_matches WHERE user_uuid = $1 AND service = $2';
    return (await this.allQuery(query, [userUUID, service])) || [];
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

  async deleteTrackerMatches(userUUID: string): Promise<void> {
    const query = this.type === 'sqlite'
      ? 'DELETE FROM tracker_matches WHERE user_uuid = ?'
      : 'DELETE FROM tracker_matches WHERE user_uuid = $1';
    await this.runQuery(query, [userUUID]);
  }

  async deleteJellyfinTokensForProfile(userUUID: string, profileId: string | null): Promise<void> {
    if (profileId === null) {
      const query = this.type === 'sqlite'
        ? 'DELETE FROM jellyfin_tokens WHERE user_uuid = ? AND profile_id IS NULL'
        : 'DELETE FROM jellyfin_tokens WHERE user_uuid = $1 AND profile_id IS NULL';
      await this.runQuery(query, [userUUID]);
      return;
    }
    const query = this.type === 'sqlite'
      ? 'DELETE FROM jellyfin_tokens WHERE user_uuid = ? AND profile_id = ?'
      : 'DELETE FROM jellyfin_tokens WHERE user_uuid = $1 AND profile_id = $2';
    await this.runQuery(query, [userUUID, profileId]);
  }

  async deleteIdleJellyfinTokens(usedBefore: number): Promise<number> {
    const query = this.type === 'sqlite'
      ? 'DELETE FROM jellyfin_tokens WHERE last_used_at < ?'
      : 'DELETE FROM jellyfin_tokens WHERE last_used_at < $1';
    const result = await this.runQuery(query, [usedBefore]);
    return Number(this.type === 'sqlite' ? result?.changes : result?.rowCount) || 0;
  }

  async deletePlaystate(userUUID: string, videoId: string, profile = ''): Promise<void> {
    const query = this.type === 'sqlite'
      ? 'DELETE FROM jellyfin_playstate WHERE user_uuid = ? AND profile = ? AND video_id = ?'
      : 'DELETE FROM jellyfin_playstate WHERE user_uuid = $1 AND profile = $2 AND video_id = $3';
    await this.runQuery(query, [userUUID, profile, videoId]);
  }

  async lookupJellyfinId(id: string): Promise<any | null> {
    const query = this.type === 'sqlite'
      ? 'SELECT payload FROM jellyfin_ids WHERE id = ?'
      : 'SELECT payload FROM jellyfin_ids WHERE id = $1';
    const row = await this.getQuery(query, [id]);
    if (!row) return null;

    try {
      return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    } catch (error) {
      logger.error('Error parsing jellyfin id payload:', error);
      return null;
    }
  }

  async getIdMappingsBatch(offset: number, limit: number): Promise<any[]> {
    let query: string;
    let params: any[];

    if (this.type === 'sqlite') {
      query = `
        SELECT content_type, tmdb_id, tvdb_id, imdb_id, tvmaze_id
        FROM id_mappings
        ORDER BY id
        LIMIT ? OFFSET ?
      `;
      params = [limit, offset];
    } else {
      query = `
        SELECT content_type, tmdb_id, tvdb_id, imdb_id, tvmaze_id
        FROM id_mappings
        ORDER BY id
        LIMIT $1 OFFSET $2
      `;
      params = [limit, offset];
    }

    return await this.allQuery(query, params);
  }

  async close(): Promise<void> {
    if (this.db) {
      if (this.type === 'sqlite') {
        this.db.close();
        this.db = null;
        this.readDb = null;
        this.initialized = false;
        return;
      } else {
        if (this.readDb && this.readDb !== this.db) {
          await this.readDb.end();
        }
        await this.db.end();
        this.readDb = null;
      }
    }
  }

  async getAllUsers(): Promise<{ id: string; password_hash: string; config: string }[]> {
    try {
      const query = `SELECT user_uuid, password_hash, config_data FROM user_configs`;

      const rows = await this.allQuery(query);

      return rows.map(row => ({
        id: row.user_uuid,
        password_hash: row.password_hash,
        config: typeof row.config_data === 'string' ? row.config_data : JSON.stringify(row.config_data)
      }));
    } catch (error) {
      logger.error('Error getting all users:', error);
      return [];
    }
  }

  async getUsersByOAuthTokenIds(tokenField: string, tokenIds: string[]): Promise<any[]> {
    if (!tokenIds.length) return [];
    try {
      if (this.type === 'sqlite') {
        const placeholders = tokenIds.map(() => '?').join(', ');
        const query = `SELECT user_uuid, password_hash, config_data FROM user_configs
          WHERE json_extract(config_data, '$.apiKeys.${tokenField}') IN (${placeholders})`;
        const rows = await this.allQuery(query, tokenIds);
        return rows.map(row => ({
          id: row.user_uuid,
          password_hash: row.password_hash,
          config: typeof row.config_data === 'string' ? JSON.parse(row.config_data) : row.config_data
        }));
      } else {
        const placeholders = tokenIds.map((_, i) => `$${i + 1}`).join(', ');
        const query = `SELECT user_uuid, password_hash, config_data FROM user_configs
          WHERE config_data::jsonb->'apiKeys'->>'${tokenField}' IN (${placeholders})`;
        const rows = await this.allQuery(query, tokenIds);
        return rows.map(row => ({
          id: row.user_uuid,
          password_hash: row.password_hash,
          config: typeof row.config_data === 'string' ? JSON.parse(row.config_data) : row.config_data
        }));
      }
    } catch (error) {
      logger.error(`Error finding users by ${tokenField}:`, error);
      return [];
    }
  }

  /** Every configuration referring to one of these tokens, at the top level or on a Jellyfin user. */
  async findTokenReferences(field: string, tokenIds: string[]): Promise<Array<{ uuid: string; passwordHash: string; config: any; owners: string[] }>> {
    if (!tokenIds.length || !/^[A-Za-z]+$/.test(field)) return [];
    const sqlite = this.type === 'sqlite';
    const marks = tokenIds.map((_, i) => (sqlite ? '?' : `$${i + 1}`)).join(', ');
    const query = sqlite
      ? `SELECT user_uuid, password_hash, config_data FROM user_configs
         WHERE json_extract(config_data, '$.apiKeys.${field}') IN (${marks})
            OR EXISTS (SELECT 1 FROM json_each(config_data, '$.jellyfinUsers') u
                       WHERE json_extract(config_data, u.fullkey || '.accounts.apiKeys.${field}') IN (${marks}))`
      : `SELECT user_uuid, password_hash, config_data FROM user_configs
         WHERE config_data::jsonb->'apiKeys'->>'${field}' IN (${marks})
            OR EXISTS (
                 SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(config_data::jsonb->'jellyfinUsers') = 'array'
                                                         THEN config_data::jsonb->'jellyfinUsers' ELSE '[]'::jsonb END) u
                 WHERE u->'accounts'->'apiKeys'->>'${field}' IN (${marks}))`;
    // The release check must see this process's own just-committed write, so this reads the
    // primary directly rather than through allQuery's (possibly lagging) read replica.
    if (!this.initialized) await this.initialize();
    try {
      const rows = sqlite
        ? this.executeSQLiteStatement(this.db.prepare(query), 'all', [...tokenIds, ...tokenIds])
        : (await this.db.query(query, tokenIds)).rows;
      const wanted = new Set(tokenIds);
      return rows.map((row: any) => {
        const config = typeof row.config_data === 'string' ? JSON.parse(row.config_data) : row.config_data;
        const owners: string[] = [];
        if (wanted.has(config?.apiKeys?.[field])) owners.push('');
        for (const card of Array.isArray(config?.jellyfinUsers) ? config.jellyfinUsers : []) {
          if (card?.id && wanted.has(card?.accounts?.apiKeys?.[field])) owners.push(card.id);
        }
        return { uuid: row.user_uuid, passwordHash: row.password_hash, config, owners };
      }).filter((ref: any) => ref.owners.length > 0);
    } catch (error) {
      logger.error(`Error finding references to ${field}:`, error);
      throw error;
    }
  }

  /** A page of configurations, newest first, matched on the id's start or an alias; the flags are read for the page only. */
  async listUsersWithStats(options: { query?: string; limit: number; offset: number }): Promise<{ users: any[]; total: number }> {
    const q = String(options.query || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(500, options.limit));
    const offset = Math.max(0, options.offset);
    const sqlite = this.type === 'sqlite';

    let where = '';
    const params: any[] = [];
    if (q) {
      const alias = await this.getQuery(
        sqlite ? 'SELECT user_uuid FROM user_aliases WHERE alias_lower = ?' : 'SELECT user_uuid FROM user_aliases WHERE alias_lower = $1',
        [q]
      );
      // SQLite seeks the primary key for a prefix range; Postgres compares text by locale, so it gets LIKE.
      const prefix = sqlite ? '(user_uuid >= ? AND user_uuid < ?)' : `user_uuid LIKE $1`;
      where = alias
        ? ` WHERE (${prefix} OR user_uuid = ${sqlite ? '?' : '$2'})`
        : ` WHERE ${prefix}`;
      if (sqlite) params.push(q, `${q}\uffff`);
      else params.push(`${q.replace(/[%_\\]/g, '\\$&')}%`);
      if (alias) params.push(alias.user_uuid);
    }

    const countRow = await this.getQuery(`SELECT COUNT(*) AS count FROM user_configs${where}`, params);
    const total = Number(countRow?.count) || 0;

    const n = params.length;
    const page = sqlite
      ? `SELECT user_uuid, created_at, updated_at, config_data FROM user_configs${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      : `SELECT user_uuid, created_at, updated_at, config_data FROM user_configs${where} ORDER BY created_at DESC LIMIT $${n + 1} OFFSET $${n + 2}`;
    const rows = await this.allQuery(page, [...params, limit, offset]);
    if (!rows?.length) return { users: [], total };

    const uuids = rows.map((row: any) => row.user_uuid);
    const marks = uuids.map((_: string, i: number) => (sqlite ? '?' : `$${i + 1}`)).join(', ');
    const aliasRows = await this.allQuery(`SELECT alias, user_uuid FROM user_aliases WHERE user_uuid IN (${marks})`, uuids);
    const aliasByUuid = new Map((aliasRows || []).map((row: any) => [row.user_uuid, row.alias]));
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    // SQLite stores the config as text and the times as UTC text; Postgres hands back JSONB and Date objects.
    const stampOf = (value: any): number => {
      if (value instanceof Date) return value.getTime();
      const text = String(value || '').replace(' ', 'T');
      return Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`);
    };

    return {
      total,
      users: rows.map((row: any) => {
        let keys: any = null;
        try {
          const config = typeof row.config_data === 'string' ? JSON.parse(row.config_data) : row.config_data;
          keys = config?.apiKeys ?? null;
        } catch {
          keys = null;
        }
        const updated = stampOf(row.updated_at);
        return {
          uuid: row.user_uuid,
          alias: aliasByUuid.get(row.user_uuid) || null,
          created_at: row.created_at,
          last_updated: row.updated_at,
          last_activity: null,
          total_requests: 0,
          has_api_keys: Boolean(keys && (keys.tmdb || keys.tvdb || keys.imdb || keys.kitsu)),
          config_status: 'configured',
          is_active: Number.isFinite(updated) && updated >= weekAgo,
        };
      }),
    };
  }

  async getUserDetails(userUUID: string): Promise<any> {
    try {
      const query = this.type === 'sqlite'
        ? 'SELECT * FROM user_configs WHERE user_uuid = ?'
        : 'SELECT * FROM user_configs WHERE user_uuid = $1';

      const row = await this.getQuery(query, [userUUID]);

      if (!row) return null;

      let configData: any = null;
      try {
        configData = typeof row.config_data === 'string'
          ? JSON.parse(row.config_data)
          : row.config_data;
      } catch (error) {
        logger.warn('Error parsing config data for user:', userUUID);
        return null;
      }

      return {
        uuid: row.user_uuid,
        created_at: row.created_at,
        last_updated: row.updated_at,
        last_activity: null,
        total_requests: 0,
        api_keys: {
          tmdb: !!configData?.apiKeys?.tmdb,
          tvdb: !!configData?.apiKeys?.tvdb,
          imdb: !!configData?.apiKeys?.imdb,
          kitsu: !!configData?.apiKeys?.kitsu
        },
        streaming_services: configData?.streaming || [],
        catalogs_count: configData?.catalogs?.length || 0,
        language: configData?.language || 'en-US',
        region: configData?.region || 'US'
      };
    } catch (error) {
      logger.error('Error getting user details:', error);
      return null;
    }
  }

  async resetUserPassword(userUUID: string, newPassword?: string): Promise<string | null> {
    try {
      const password = newPassword || Math.random().toString(36).slice(-8);
      const hashedPassword = await this.hashPassword(password);

      const query = this.type === 'sqlite'
        ? 'UPDATE user_configs SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE user_uuid = ?'
        : 'UPDATE user_configs SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE user_uuid = $2';

      const result = await this.runQuery(query, [hashedPassword, userUUID]);

      if (this.type === 'sqlite' ? result.changes > 0 : result.rowCount > 0) {
        return password;
      }

      return null;
    } catch (error) {
      logger.error('Error resetting user password:', error);
      return null;
    }
  }

  async exportAllUserData(): Promise<any> {
    try {
      const query = this.type === 'sqlite'
        ? `SELECT
             user_uuid,
             created_at,
             updated_at,
             config_data
           FROM user_configs
           ORDER BY created_at DESC`
        : `SELECT
             user_uuid,
             created_at,
             updated_at,
             config_data
           FROM user_configs
           ORDER BY created_at DESC`;

      const rows = await this.allQuery(query);

      return {
        exportDate: new Date().toISOString(),
        totalUsers: rows.length,
        users: rows.map(row => {
          let configData: any = null;
          try {
            configData = typeof row.config_data === 'string'
              ? JSON.parse(row.config_data)
              : row.config_data;
          } catch (error) {
            logger.warn('Error parsing config data for export:', row.user_uuid);
          }

          return {
            uuid: row.user_uuid,
            created_at: row.created_at,
            updated_at: row.updated_at,
            config: configData
          };
        })
      };
    } catch (error) {
      logger.error('Error exporting user data:', error);
      return { exportDate: new Date().toISOString(), totalUsers: 0, users: [] };
    }
  }

  async deleteInactiveUsers(daysOld: number = 30): Promise<number> {
    try {
      const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
      const cutoffDateStr = cutoffDate.toISOString();

      const query = this.type === 'sqlite'
        ? 'DELETE FROM user_configs WHERE updated_at < ?'
        : 'DELETE FROM user_configs WHERE updated_at < $1';
      const doomed = await this.allQuery(this.type === 'sqlite'
        ? 'SELECT user_uuid FROM user_configs WHERE updated_at < ?'
        : 'SELECT user_uuid FROM user_configs WHERE updated_at < $1', [cutoffDateStr]);

      const result = await this.runQuery(query, [cutoffDateStr]);
      await require('./jellyfin/context').forgetSeen((doomed || []).map((row: any) => String(row.user_uuid))).catch(() => undefined);

      await this.runAliasCleanup(
        'DELETE FROM user_aliases WHERE user_uuid NOT IN (SELECT user_uuid FROM user_configs)'
      );

      return this.type === 'sqlite' ? result.changes : result.rowCount;
    } catch (error) {
      logger.error('Error deleting inactive users:', error);
      return 0;
    }
  }

  async saveOAuthToken(id: string, provider: string, userId: string, accessToken: string, refreshToken: string, expiresAt: number, scope: string = ''): Promise<boolean> {
    try {
      const query = this.type === 'sqlite'
        ? `INSERT OR REPLACE INTO oauth_tokens
           (id, provider, user_id, access_token, refresh_token, expires_at, scope, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        : `INSERT INTO oauth_tokens
           (id, provider, user_id, access_token, refresh_token, expires_at, scope, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO UPDATE SET
             access_token = EXCLUDED.access_token,
             refresh_token = EXCLUDED.refresh_token,
             expires_at = EXCLUDED.expires_at,
             scope = EXCLUDED.scope,
             updated_at = CURRENT_TIMESTAMP`;

      await this.runQuery(query, [id, provider, userId, accessToken, refreshToken, expiresAt, scope]);
      return true;
    } catch (error) {
      logger.error('Error saving OAuth token:', error);
      return false;
    }
  }

  async getOAuthToken(id: string): Promise<any> {
    try {
      const query = this.type === 'sqlite'
        ? 'SELECT * FROM oauth_tokens WHERE id = ?'
        : 'SELECT * FROM oauth_tokens WHERE id = $1';

      const row = await this.getQuery(query, [id]);
      return row || null;
    } catch (error) {
      logger.error('Error getting OAuth token:', error);
      return null;
    }
  }

  async updateOAuthToken(id: string, accessToken: string, refreshToken: string, expiresAt: number): Promise<boolean> {
    try {
      const query = this.type === 'sqlite'
        ? `UPDATE oauth_tokens
           SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        : `UPDATE oauth_tokens
           SET access_token = $1, refresh_token = $2, expires_at = $3, updated_at = CURRENT_TIMESTAMP
           WHERE id = $4`;

      await this.runQuery(query, [accessToken, refreshToken, expiresAt, id]);
      return true;
    } catch (error) {
      logger.error('Error updating OAuth token:', error);
      return false;
    }
  }

  async deleteOAuthToken(id: string): Promise<boolean> {
    try {
      const query = this.type === 'sqlite'
        ? 'DELETE FROM oauth_tokens WHERE id = ?'
        : 'DELETE FROM oauth_tokens WHERE id = $1';

      const result = await this.runQuery(query, [id]);
      return this.type === 'sqlite' ? result.changes > 0 : result.rowCount > 0;
    } catch (error) {
      logger.error('Error deleting OAuth token:', error);
      return false;
    }
  }

  async getOAuthTokensByProvider(provider: string): Promise<any[]> {
    try {
      const query = this.type === 'sqlite'
        ? 'SELECT * FROM oauth_tokens WHERE provider = ?'
        : 'SELECT * FROM oauth_tokens WHERE provider = $1';

      return await this.allQuery(query, [provider]);
    } catch (error) {
      logger.error('Error getting OAuth tokens by provider:', error);
      return [];
    }
  }

  // --- Accounts and config profiles ---

  /**
   * Keyed on (issuer, subject) rather than the username, because a provider
   * rename would otherwise orphan every profile the account owns.
   */
  async upsertAccount(
    issuer: string,
    subject: string,
    username: string,
    email: string | null,
    groups: string[] | null = null
  ): Promise<any> {
    const existing = await this.getQuery(
      this.type === 'sqlite'
        ? 'SELECT * FROM accounts WHERE issuer = ? AND subject = ?'
        : 'SELECT * FROM accounts WHERE issuer = $1 AND subject = $2',
      [issuer, subject]
    );
    const groupsJson = groups === null ? null : JSON.stringify(groups);

    if (existing) {
      await this.runQuery(
        this.type === 'sqlite'
          ? 'UPDATE accounts SET username = ?, email = ?, groups_json = ?, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?'
          : 'UPDATE accounts SET username = $1, email = $2, groups_json = $3, last_seen_at = CURRENT_TIMESTAMP WHERE id = $4',
        [username, email, groupsJson, existing.id]
      );
      return { ...existing, username, email, groups_json: groupsJson };
    }

    const id = crypto.randomUUID();
    await this.runQuery(
      this.type === 'sqlite'
        ? 'INSERT INTO accounts (id, issuer, subject, username, email, groups_json) VALUES (?, ?, ?, ?, ?, ?)'
        : 'INSERT INTO accounts (id, issuer, subject, username, email, groups_json) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, issuer, subject, username, email, groupsJson]
    );
    return { id, issuer, subject, username, email, groups_json: groupsJson, blocked: 0 };
  }

  async setAccountBlocked(accountId: string, blocked: boolean): Promise<void> {
    await this.runQuery(
      this.type === 'sqlite'
        ? 'UPDATE accounts SET blocked = ? WHERE id = ?'
        : 'UPDATE accounts SET blocked = $1 WHERE id = $2',
      [blocked ? 1 : 0, accountId]
    );
  }

  async getAccount(accountId: string): Promise<any> {
    return await this.getQuery(
      this.type === 'sqlite'
        ? 'SELECT * FROM accounts WHERE id = ?'
        : 'SELECT * FROM accounts WHERE id = $1',
      [accountId]
    );
  }

  async listAccounts(): Promise<any[]> {
    return await this.allQuery(
      `SELECT id, issuer, subject, username, email, groups_json, blocked, created_at, last_seen_at
         FROM accounts
        ORDER BY last_seen_at DESC NULLS LAST, created_at DESC`,
      []
    );
  }

  async deleteAccount(accountId: string): Promise<void> {
    await this.runQuery(
      this.type === 'sqlite'
        ? 'DELETE FROM accounts WHERE id = ?'
        : 'DELETE FROM accounts WHERE id = $1',
      [accountId]
    );
  }

  /** Profiles with the config still present, newest use first. */
  async getAccountConfigs(accountId: string): Promise<any[]> {
    return await this.allQuery(
      this.type === 'sqlite'
        ? `SELECT ac.user_uuid, ac.label, ac.linked_at, ac.last_opened_at
             FROM account_configs ac
             JOIN user_configs uc ON uc.user_uuid = ac.user_uuid
            WHERE ac.account_id = ?
            ORDER BY ac.last_opened_at DESC NULLS LAST, ac.linked_at DESC`
        : `SELECT ac.user_uuid, ac.label, ac.linked_at, ac.last_opened_at
             FROM account_configs ac
             JOIN user_configs uc ON uc.user_uuid = ac.user_uuid
            WHERE ac.account_id = $1
            ORDER BY ac.last_opened_at DESC NULLS LAST, ac.linked_at DESC`,
      [accountId]
    );
  }

  async ownsConfig(accountId: string, userUUID: string): Promise<boolean> {
    const row = await this.getQuery(
      this.type === 'sqlite'
        ? 'SELECT 1 AS ok FROM account_configs WHERE account_id = ? AND user_uuid = ?'
        : 'SELECT 1 AS ok FROM account_configs WHERE account_id = $1 AND user_uuid = $2',
      [accountId, userUUID]
    );
    return Boolean(row);
  }

  async countAccountConfigs(accountId: string): Promise<number> {
    const row = await this.getQuery(
      this.type === 'sqlite'
        ? 'SELECT COUNT(*) AS n FROM account_configs WHERE account_id = ?'
        : 'SELECT COUNT(*) AS n FROM account_configs WHERE account_id = $1',
      [accountId]
    );
    return Number(row?.n || 0);
  }

  async linkAccountConfig(accountId: string, userUUID: string, label: string): Promise<void> {
    await this.runQuery(
      this.type === 'sqlite'
        ? `INSERT INTO account_configs (account_id, user_uuid, label) VALUES (?, ?, ?)
             ON CONFLICT(account_id, user_uuid) DO UPDATE SET label = excluded.label`
        : `INSERT INTO account_configs (account_id, user_uuid, label) VALUES ($1, $2, $3)
             ON CONFLICT (account_id, user_uuid) DO UPDATE SET label = EXCLUDED.label`,
      [accountId, userUUID, label]
    );
  }

  async unlinkAccountConfig(accountId: string, userUUID: string): Promise<void> {
    await this.runQuery(
      this.type === 'sqlite'
        ? 'DELETE FROM account_configs WHERE account_id = ? AND user_uuid = ?'
        : 'DELETE FROM account_configs WHERE account_id = $1 AND user_uuid = $2',
      [accountId, userUUID]
    );
  }

  async touchAccountConfig(accountId: string, userUUID: string): Promise<void> {
    await this.runQuery(
      this.type === 'sqlite'
        ? 'UPDATE account_configs SET last_opened_at = CURRENT_TIMESTAMP WHERE account_id = ? AND user_uuid = ?'
        : 'UPDATE account_configs SET last_opened_at = CURRENT_TIMESTAMP WHERE account_id = $1 AND user_uuid = $2',
      [accountId, userUUID]
    );
  }

  /** Called when a config goes away, since the link has no meaning without it. */
  async unlinkConfigFromAllAccounts(userUUID: string): Promise<void> {
    await this.runQuery(
      this.type === 'sqlite'
        ? 'DELETE FROM account_configs WHERE user_uuid = ?'
        : 'DELETE FROM account_configs WHERE user_uuid = $1',
      [userUUID]
    );
  }
}

const database = new Database();

export default database;
module.exports = database;
