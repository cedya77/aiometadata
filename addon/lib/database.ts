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

class Database {
  db: any;
  type: DbType | null;
  initialized: boolean;

  constructor() {
    this.db = null;
    this.type = null;
    this.initialized = false;
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

    if (databaseUri.startsWith('sqlite://')) {
      await this.initializeSQLite(databaseUri);
    } else if (databaseUri.startsWith('postgres://') || databaseUri.startsWith('postgresql://')) {
      await this.initializePostgreSQL(databaseUri);
    } else {
      throw new Error('Unsupported database URI format. Use sqlite:// or postgres://');
    }

    // Mark initialized BEFORE creating tables to avoid recursive initialize() calls
    // from runQuery/getQuery during table creation.
    this.initialized = true;
    await this.createTables();
    logger.info(`Initialized ${this.type} database`);
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
  }

  async initializePostgreSQL(uri: string): Promise<void> {
    this.db = new Pool({ connectionString: uri });
    this.type = 'postgres';

    await this.db.query('SELECT 1');
  }

  async createTables(): Promise<void> {
    if (this.type === 'sqlite') {
      await this.createSQLiteTables();
    } else {
      await this.createPostgreSQLTables();
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
      `CREATE TABLE IF NOT EXISTS trusted_uuids (
        user_uuid TEXT UNIQUE NOT NULL,
        trusted_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
      `CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_id ON oauth_tokens(user_id)`
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
      `CREATE TABLE IF NOT EXISTS trusted_uuids (
        user_uuid VARCHAR(255) UNIQUE NOT NULL,
        trusted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
      `CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_id ON oauth_tokens(user_id)`
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
      const statement = this.db.prepare(query);
      return this.executeSQLiteStatement(statement, 'get', params) || null;
    } else {
      const result = await this.db.query(query, params);
      return result.rows[0] || null;
    }
  }

  async allQuery(query: string, params: any[] = []): Promise<any[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (this.type === 'sqlite') {
      const statement = this.db.prepare(query);
      return this.executeSQLiteStatement(statement, 'all', params);
    } else {
      const result = await this.db.query(query, params);
      return result.rows;
    }
  }

  generateUserUUID(): string {
    return crypto.randomUUID();
  }

  async saveUserConfig(userUUID: string, passwordHash: string, configData: any): Promise<void> {
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
        this.initialized = false;
        return;
      } else {
        await this.db.end();
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
          WHERE config_data->'apiKeys'->>'${tokenField}' IN (${placeholders})`;
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
             CASE WHEN (config_data->'apiKeys'->>'tmdb') IS NOT NULL
                    OR (config_data->'apiKeys'->>'tvdb') IS NOT NULL
                    OR (config_data->'apiKeys'->>'imdb') IS NOT NULL
                    OR (config_data->'apiKeys'->>'kitsu') IS NOT NULL
               THEN true ELSE false END AS has_api_keys,
             CASE WHEN updated_at >= NOW() - INTERVAL '7 days' THEN true ELSE false END AS is_active
           FROM user_configs
           ORDER BY created_at DESC`;

      const rows = await this.allQuery(query);

      return rows.map(row => ({
        uuid: row.user_uuid,
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
}

const database = new Database();

export default database;
module.exports = database;
