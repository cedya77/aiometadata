import { Pool } from 'pg';
import BetterSqlite3 from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
const redisIdCache: any = require('./redis-id-cache');
import consola from 'consola';

const logger = consola.withTag('Database');

type DbType = 'sqlite' | 'postgres';

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
        PRIMARY KEY (user_uuid, profile, video_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_jellyfin_playstate_recent ON jellyfin_playstate(user_uuid, profile, updated_at DESC)`,
      `CREATE TABLE IF NOT EXISTS jellyfin_preferences (
        user_uuid TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        pref_id TEXT NOT NULL,
        client TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_uuid, profile, pref_id, client)
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
        PRIMARY KEY (user_uuid, profile, video_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_jellyfin_playstate_recent ON jellyfin_playstate(user_uuid, profile, updated_at DESC)`,
      `CREATE TABLE IF NOT EXISTS jellyfin_preferences (
        user_uuid VARCHAR(64) NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        pref_id TEXT NOT NULL,
        client TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_uuid, profile, pref_id, client)
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
    const query = this.type === 'sqlite'
      ? 'SELECT COUNT(*) as count FROM user_configs WHERE DATE(created_at) = ?'
      : 'SELECT COUNT(*) as count FROM user_configs WHERE DATE(created_at) = $1';
    const row = await this.getQuery(query, [today]);
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

      const deleteAliasQuery = this.type === 'sqlite'
        ? 'DELETE FROM user_aliases WHERE user_uuid = ?'
        : 'DELETE FROM user_aliases WHERE user_uuid = $1';
      await this.runAliasCleanup(deleteAliasQuery, [userUUID]);
      await this.unlinkConfigFromAllAccounts(userUUID);

      logger.info(`Successfully deleted user ${userUUID} and all associated data`);
      return userDeleted;
    } catch (error) {
      logger.error(`Error deleting user ${userUUID}:`, error);
      throw error;
    }
  }

  async migrateFromLocalStorage(localStorageData: any, password: string): Promise<string | null> {
    if (!localStorageData) return null;

    try {
      const config = typeof localStorageData === 'string'
        ? JSON.parse(localStorageData)
        : localStorageData;

      const userUUID = this.generateUserUUID();

      const passwordHash = crypto.createHash('sha256').update(password).digest('hex');

      await this.saveUserConfig(userUUID, passwordHash, config);
      logger.info('[Database] Migrated localStorage config for user:', userUUID);

      return userUUID;
    } catch (error) {
      logger.error('Migration failed:', error);
      return null;
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

    const query = this.type === 'sqlite'
      ? 'INSERT OR IGNORE INTO jellyfin_ids (id, payload, codec_version) VALUES (?, ?, ?)'
      : 'INSERT INTO jellyfin_ids (id, payload, codec_version) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING';

    for (const row of rows) {
      await this.runQuery(query, [row.id, JSON.stringify(row.payload), row.codecVersion]);
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

    const marks = videoIds.map((_, i) => (this.type === 'sqlite' ? '?' : `$${i + 3}`)).join(', ');
    const query = this.type === 'sqlite'
      ? `SELECT * FROM jellyfin_playstate WHERE user_uuid = ? AND profile = ? AND video_id IN (${marks})`
      : `SELECT * FROM jellyfin_playstate WHERE user_uuid = $1 AND profile = $2 AND video_id IN (${marks})`;
    const rows = await this.allQuery(query, [userUUID, profile, ...videoIds]);
    for (const row of rows || []) out.set(row.video_id, row);
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
  async listRecentlyPlayed(userUUID: string, since: number, limit: number, profile = ''): Promise<any[]> {
    const query = this.type === 'sqlite'
      ? "SELECT * FROM jellyfin_playstate WHERE user_uuid = ? AND profile = ? AND played = 1 AND last_played_at >= ? AND video_id LIKE '%:%:%' ORDER BY last_played_at DESC LIMIT ?"
      : "SELECT * FROM jellyfin_playstate WHERE user_uuid = $1 AND profile = $2 AND played = 1 AND last_played_at >= $3 AND video_id LIKE '%:%:%' ORDER BY last_played_at DESC LIMIT $4";
    return (await this.allQuery(query, [userUUID, profile, since, limit])) || [];
  }

  async upsertPlaystate(
    userUUID: string,
    videoId: string,
    patch: { positionMs?: number; runtimeMs?: number; played?: boolean; lastPlayedAt?: number | null },
    profile = ''
  ): Promise<void> {
    const existing = await this.getPlaystate(userUUID, videoId, profile);
    const now = Date.now();

    const positionMs = patch.positionMs ?? existing?.position_ms ?? 0;
    const runtimeMs = patch.runtimeMs ?? existing?.runtime_ms ?? 0;
    const played = patch.played ?? Boolean(existing?.played);
    const playCount = (existing?.play_count ?? 0) + (patch.played === true && !existing?.played ? 1 : 0);
    const lastPlayedAt = patch.lastPlayedAt === undefined ? (existing?.last_played_at ?? null) : patch.lastPlayedAt;

    const query = this.type === 'sqlite'
      ? `INSERT INTO jellyfin_playstate (user_uuid, profile, video_id, position_ms, runtime_ms, played, play_count, last_played_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_uuid, profile, video_id) DO UPDATE SET
           position_ms = excluded.position_ms, runtime_ms = excluded.runtime_ms, played = excluded.played,
           play_count = excluded.play_count, last_played_at = excluded.last_played_at, updated_at = excluded.updated_at`
      : `INSERT INTO jellyfin_playstate (user_uuid, profile, video_id, position_ms, runtime_ms, played, play_count, last_played_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_uuid, profile, video_id) DO UPDATE SET
           position_ms = EXCLUDED.position_ms, runtime_ms = EXCLUDED.runtime_ms, played = EXCLUDED.played,
           play_count = EXCLUDED.play_count, last_played_at = EXCLUDED.last_played_at, updated_at = EXCLUDED.updated_at`;

    await this.runQuery(query, [userUUID, profile, videoId, positionMs, runtimeMs, played ? 1 : 0, playCount, lastPlayedAt, now]);
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

  async getAllUsersWithStats(): Promise<any[]> {
    try {
      const query = this.type === 'sqlite'
        ? `SELECT
             user_uuid,
             created_at,
             updated_at,
             CASE WHEN json_extract(config_data, '$.apiKeys.tmdb') IS NOT NULL
                    OR json_extract(config_data, '$.apiKeys.tvdb') IS NOT NULL
                    OR json_extract(config_data, '$.apiKeys.imdb') IS NOT NULL
                    OR json_extract(config_data, '$.apiKeys.kitsu') IS NOT NULL
               THEN 1 ELSE 0 END AS has_api_keys,
             CASE WHEN updated_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END AS is_active
           FROM user_configs
           ORDER BY created_at DESC`
        : `SELECT
             user_uuid,
             created_at,
             updated_at,
             CASE WHEN (config_data::jsonb->'apiKeys'->>'tmdb') IS NOT NULL
                    OR (config_data::jsonb->'apiKeys'->>'tvdb') IS NOT NULL
                    OR (config_data::jsonb->'apiKeys'->>'imdb') IS NOT NULL
                    OR (config_data::jsonb->'apiKeys'->>'kitsu') IS NOT NULL
               THEN true ELSE false END AS has_api_keys,
             CASE WHEN updated_at >= NOW() - INTERVAL '7 days' THEN true ELSE false END AS is_active
           FROM user_configs
           ORDER BY created_at DESC`;

      const rows = await this.allQuery(query);

      const aliasRows = await this.getAllUserAliases();
      const aliasByUuid = new Map(aliasRows.map(row => [row.user_uuid, row.alias]));

      return rows.map(row => ({
        uuid: row.user_uuid,
        alias: aliasByUuid.get(row.user_uuid) || null,
        created_at: row.created_at,
        last_updated: row.updated_at,
        last_activity: null,
        total_requests: 0,
        has_api_keys: !!row.has_api_keys,
        config_status: 'configured',
        is_active: !!row.is_active
      }));
    } catch (error) {
      logger.error('Error getting all users with stats:', error);
      return [];
    }
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

      const result = await this.runQuery(query, [cutoffDateStr]);

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
