const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const redisIdCache = require('./redis-id-cache');
const consola = require('consola');
const logger = consola.withTag('Database');

class Database {
  constructor() {
    this.db = null;
    this.type = null;
    this.initialized = false;
  }

  // Helper method to hash passwords with bcrypt
  async hashPassword(password) {
    const saltRounds = 12;
    return await bcrypt.hash(password, saltRounds);
  }

  // Helper method to verify passwords (supports both SHA-256 and bcrypt)
  async verifyPasswordHash(password, storedHash) {
    // First try bcrypt verification (for new passwords)
    try {
      const bcryptMatch = await bcrypt.compare(password, storedHash);
      if (bcryptMatch) return true;
    } catch (error) {
      // Not a bcrypt hash, continue to SHA-256 check
    }

    // Fallback to SHA-256 verification (for legacy passwords)
    const hashRaw = crypto.createHash('sha256').update(password).digest('hex');
    const hashTrim = crypto.createHash('sha256').update((password || '').trim()).digest('hex');
    
    return storedHash === hashRaw || storedHash === hashTrim;
  }

  // Helper method to check if a hash is bcrypt
  isBcryptHash(hash) {
    return hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$');
  }

  async initialize() {
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

  async initializeSQLite(uri) {
    const dbPath = uri.replace('sqlite://', '');
    const fullPath = path.resolve(dbPath);
    
    // Ensure directory exists
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new sqlite3.Database(fullPath);
    this.type = 'sqlite';

    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run('PRAGMA foreign_keys = ON');
        this.db.run('PRAGMA journal_mode = WAL');
        this.db.run('PRAGMA busy_timeout = 5000');
        this.db.run('PRAGMA synchronous = NORMAL');
        this.db.run('PRAGMA cache_size = 10000');
        this.db.run('PRAGMA temp_store = MEMORY');
        this.db.run('PRAGMA mmap_size = 268435456'); // 256MB
        resolve();
      });
    });
  }

  async initializePostgreSQL(uri) {
    this.db = new Pool({ connectionString: uri });
    this.type = 'postgres';
    
    // Test connection
    await this.db.query('SELECT 1');
  }

  async createTables() {
    if (this.type === 'sqlite') {
      await this.createSQLiteTables();
    } else {
      await this.createPostgreSQLTables();
    }
  }

  async createSQLiteTables() {
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

  async createPostgreSQLTables() {
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

  async runQuery(query, params = []) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (this.type === 'sqlite') {
      return new Promise((resolve, reject) => {
        this.db.run(query, params, function(err) {
          if (err) reject(err);
          else resolve({ lastID: this.lastID, changes: this.changes });
        });
      });
    } else {
      const result = await this.db.query(query, params);
      return result;
    }
  }

  async getQuery(query, params = []) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (this.type === 'sqlite') {
      return new Promise((resolve, reject) => {
        this.db.get(query, params, (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
    } else {
      const result = await this.db.query(query, params);
      return result.rows[0] || null;
    }
  }

  async allQuery(query, params = []) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (this.type === 'sqlite') {
      return new Promise((resolve, reject) => {
        this.db.all(query, params, (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
    } else {
      const result = await this.db.query(query, params);
      return result.rows;
    }
  }

  // Generate a UUID for a user
  generateUserUUID() {
    return crypto.randomUUID();
  }

  // Save user configuration by UUID with password
  async saveUserConfig(userUUID, passwordHash, configData) {
    let normalizedConfig = configData;

    if (typeof normalizedConfig === 'string') {
      try {
        normalizedConfig = JSON.parse(normalizedConfig);
      } catch (error) {
        normalizedConfig = null;
      }
    }

    let configJson;
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
        // First try to insert as new user
        await this.runQuery(
          `INSERT INTO user_configs (user_uuid, password_hash, config_data, created_at, updated_at) 
           VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [userUUID, passwordHash, configJson]
        );
      } catch (error) {
        // If insert failed (user already exists), update only the necessary fields
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.message.includes('UNIQUE constraint failed')) {
          await this.runQuery(
            `UPDATE user_configs SET password_hash = ?, config_data = ?, updated_at = CURRENT_TIMESTAMP 
             WHERE user_uuid = ?`,
            [passwordHash, configJson, userUUID]
          );
        } else {
          throw error; // Re-throw if it's not a constraint violation
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

  // Get user configuration by UUID (without password check for manifest access)
  async getUserConfig(userUUID) {
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

  // Get user by UUID
  async getUser(userUUID) {
    const query = this.type === 'sqlite'
      ? 'SELECT user_uuid, password_hash, created_at FROM user_configs WHERE user_uuid = ?'
      : 'SELECT user_uuid, password_hash, created_at FROM user_configs WHERE user_uuid = $1';
    const row = await this.getQuery(query, [userUUID]);
    return row;
  }

  // Get all user UUIDs for dashboard aggregation
  async getAllUserUUIDs() {
    const query = 'SELECT user_uuid FROM user_configs';
    const rows = await this.allQuery(query);
    return rows ? rows.map(row => row.user_uuid) : [];
  }

  // Get users created today
  async getUsersCreatedToday() {
    const today = new Date().toISOString().substring(0, 10);
    const query = this.type === 'sqlite'
      ? 'SELECT COUNT(*) as count FROM user_configs WHERE DATE(created_at) = ?'
      : 'SELECT COUNT(*) as count FROM user_configs WHERE DATE(created_at) = $1';
    const row = await this.getQuery(query, [today]);
    return row ? parseInt(row.count) : 0;
  }

  // ID Mapping Cache Methods
  async getCachedIdMapping(contentType, tmdbId = null, tvdbId = null, imdbId = null, tvmazeId = null) {
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    // Add content type parameter first
    params.push(contentType);
    const contentTypeCondition = this.type === 'sqlite' ? 'content_type = ?' : `content_type = $${paramIndex++}`;

    if (tmdbId) {
      conditions.push(this.type === 'sqlite' ? 'tmdb_id = ?' : `tmdb_id = $${paramIndex++}`);
      params.push(tmdbId);
    }
    if (tvdbId) {
      conditions.push(this.type === 'sqlite' ? 'tvdb_id = ?' : `tvdb_id = $${paramIndex++}`);
      params.push(tvdbId);
    }
    if (imdbId) {
      conditions.push(this.type === 'sqlite' ? 'imdb_id = ?' : `imdb_id = $${paramIndex++}`);
      params.push(imdbId);
    }
    if (tvmazeId) {
      conditions.push(this.type === 'sqlite' ? 'tvmaze_id = ?' : `tvmaze_id = $${paramIndex++}`);
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

  async saveIdMapping(contentType, tmdbId = null, tvdbId = null, imdbId = null, tvmazeId = null) {
    // Skip if no IDs provided
    if (!tmdbId && !tvdbId && !imdbId && !tvmazeId) return;
    // Skip if only one ID is non-null
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

  async getCachedMappingByAnyId(contentType, tmdbId = null, tvdbId = null, imdbId = null, tvmazeId = null) {
    // Try Redis cache first
    const redisCached = await redisIdCache.searchByAnyId(contentType, tmdbId, tvdbId, imdbId, tvmazeId);
    if (redisCached) {
      return redisCached;
    }

    return null;
  }

  // Verify user password and get config (supports both SHA-256 and bcrypt)
  async verifyUserAndGetConfig(userUUID, password) {
    const query = this.type === 'sqlite'
      ? 'SELECT password_hash, config_data FROM user_configs WHERE user_uuid = ?'
      : 'SELECT password_hash, config_data FROM user_configs WHERE user_uuid = $1';
    const row = await this.getQuery(query, [userUUID]);
    if (!row) return null;

    const storedHash = row.password_hash;
    
    // Verify password using new method that supports both SHA-256 and bcrypt
    const isValidPassword = await this.verifyPasswordHash(password, storedHash);
    if (!isValidPassword) {
      return null;
    }

    // Background migration: If user has SHA-256 hash, upgrade to bcrypt
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
        // Don't fail the login if migration fails
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

  // Verify user password only (returns boolean)
  async verifyPassword(userUUID, password) {
    const query = this.type === 'sqlite'
      ? 'SELECT password_hash FROM user_configs WHERE user_uuid = ?'
      : 'SELECT password_hash FROM user_configs WHERE user_uuid = $1';
    const row = await this.getQuery(query, [userUUID]);
    if (!row) return false;

    const storedHash = row.password_hash;
    return await this.verifyPasswordHash(password, storedHash);
  }

  // Delete user configuration
  async deleteUserConfig(userUUID) {
    const query = this.type === 'sqlite'
      ? 'DELETE FROM user_configs WHERE user_uuid = ?'
      : 'DELETE FROM user_configs WHERE user_uuid = $1';
    await this.runQuery(query, [userUUID]);
  }

  // Delete user and all associated data
  async deleteUser(userUUID) {
    try {
      await this.deleteUserConfig(userUUID);
      
      // Delete from trusted_uuids table
      const deleteTrustedQuery = this.type === 'sqlite'
        ? 'DELETE FROM trusted_uuids WHERE user_uuid = ?'
        : 'DELETE FROM trusted_uuids WHERE user_uuid = $1';
      await this.runQuery(deleteTrustedQuery, [userUUID]);
      
      logger.info(`Successfully deleted user ${userUUID} and all associated data`);
    } catch (error) {
      logger.error(`Error deleting user ${userUUID}:`, error);
      throw error;
    }
  }

  // Migrate from localStorage (for backward compatibility)
  async migrateFromLocalStorage(localStorageData, password) {
    if (!localStorageData) return null;
    
    try {
      const config = typeof localStorageData === 'string' 
        ? JSON.parse(localStorageData) 
        : localStorageData;
      
      // Generate a new UUID for the user
      const userUUID = this.generateUserUUID();
      
      // Hash the password
      const crypto = require('crypto');
      const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
      
      await this.saveUserConfig(userUUID, passwordHash, config);
      logger.info('[Database] Migrated localStorage config for user:', userUUID);
      
      return userUUID;
    } catch (error) {
      logger.error('Migration failed:', error);
      return null;
    }
  }

  // Move these methods into the Database class as proper methods:
  async trustUUID(userUUID) {
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
  async isUUIDTrusted(userUUID) {
    const query = this.type === 'sqlite'
      ? 'SELECT trusted_at FROM trusted_uuids WHERE user_uuid = ?'
      : 'SELECT trusted_at FROM trusted_uuids WHERE user_uuid = $1';
    const row = await this.getQuery(query, [userUUID]);
    return !!row;
  }
  async untrustUUID(userUUID) {
    const query = this.type === 'sqlite'
      ? 'DELETE FROM trusted_uuids WHERE user_uuid = ?'
      : 'DELETE FROM trusted_uuids WHERE user_uuid = $1';
    await this.runQuery(query, [userUUID]);
  }

  // Prune all id_mappings (delete all rows)
  async pruneAllIdMappings() {
    const query = this.type === 'sqlite'
      ? 'DELETE FROM id_mappings'
      : 'DELETE FROM id_mappings';
    await this.runQuery(query);
    logger.info('Pruned all id_mappings.');
  }

  /**
   * Get total count of ID mappings
   */
  async getTotalIdMappingCount() {
    const query = 'SELECT COUNT(*) as count FROM id_mappings';
    const result = await this.getQuery(query);
    return result ? result.count : 0;
  }

  /**
   * Get ID mappings in batches for migration
   */
  async getIdMappingsBatch(offset, limit) {
    let query, params;
    
    if (this.type === 'sqlite') {
      query = `
        SELECT content_type, tmdb_id, tvdb_id, imdb_id, tvmaze_id 
        FROM id_mappings 
        ORDER BY id 
        LIMIT ? OFFSET ?
      `;
      params = [limit, offset];
    } else {
      // PostgreSQL syntax
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

  async close() {
    if (this.db) {
      if (this.type === 'sqlite') {
        return new Promise((resolve) => {
          this.db.close(resolve);
        });
      } else {
        await this.db.end();
      }
    }
  }

  // --- User Management Methods ---

  // Get all users with raw data (for internal operations like OAuth token updates)
  async getAllUsers() {
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

  // Get all users with basic statistics
  async getAllUsersWithStats() {
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

      return rows.map(row => {
        let configData = null;
        try {
          configData = typeof row.config_data === 'string' 
            ? JSON.parse(row.config_data) 
            : row.config_data;
        } catch (error) {
          logger.warn('Error parsing config data for user:', row.user_uuid);
        }

        // Check if user has API keys configured
        const hasApiKeys = configData?.apiKeys && (
          configData.apiKeys.tmdb || 
          configData.apiKeys.tvdb || 
          configData.apiKeys.imdb || 
          configData.apiKeys.kitsu
        );

        // Determine if user is active (updated in last 7 days)
        const lastUpdated = new Date(row.updated_at);
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const isActive = lastUpdated > sevenDaysAgo;

        return {
          uuid: row.user_uuid,
          created_at: row.created_at,
          last_updated: row.updated_at,
          last_activity: null, // This would need to come from request tracker
          total_requests: 0, // This would need to be tracked separately
          has_api_keys: !!hasApiKeys,
          config_status: configData ? 'configured' : 'empty',
          is_active: isActive
        };
      });
    } catch (error) {
      logger.error('Error getting all users with stats:', error);
      return [];
    }
  }

  // Get detailed user information
  async getUserDetails(userUUID) {
    try {
      const query = this.type === 'sqlite'
        ? 'SELECT * FROM user_configs WHERE user_uuid = ?'
        : 'SELECT * FROM user_configs WHERE user_uuid = $1';
      
      const row = await this.getQuery(query, [userUUID]);
      
      if (!row) return null;

      let configData = null;
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
        last_activity: null, // This would need to come from request tracker
        total_requests: 0, // This would need to be tracked separately
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

  // Reset user password (generate new one)
  async resetUserPassword(userUUID) {
    try {
      // Generate a new random password
      const newPassword = Math.random().toString(36).slice(-8);
      const hashedPassword = await this.hashPassword(newPassword);

      const query = this.type === 'sqlite'
        ? 'UPDATE user_configs SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE user_uuid = ?'
        : 'UPDATE user_configs SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE user_uuid = $2';

      const result = await this.runQuery(query, [hashedPassword, userUUID]);
      
      if (this.type === 'sqlite' ? result.changes > 0 : result.rowCount > 0) {
        return newPassword;
      }
      
      return null;
    } catch (error) {
      logger.error('Error resetting user password:', error);
      return null;
    }
  }

  // Delete user
  async deleteUser(userUUID) {
    try {
      const query = this.type === 'sqlite'
        ? 'DELETE FROM user_configs WHERE user_uuid = ?'
        : 'DELETE FROM user_configs WHERE user_uuid = $1';

      const result = await this.runQuery(query, [userUUID]);
      
      return this.type === 'sqlite' ? result.changes > 0 : result.rowCount > 0;
    } catch (error) {
      logger.error('Error deleting user:', error);
      return false;
    }
  }

  // Export all user data
  async exportAllUserData() {
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
          let configData = null;
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

  // Delete inactive users (older than specified days)
  async deleteInactiveUsers(daysOld = 30) {
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

  // OAuth Token Management Methods

  /**
   * Save OAuth token to database
   * @param {string} id - UUID for this token
   * @param {string} provider - OAuth provider (e.g., 'trakt')
   * @param {string} userId - Provider's user ID/username
   * @param {string} accessToken - OAuth access token
   * @param {string} refreshToken - OAuth refresh token
   * @param {number} expiresAt - Expiration timestamp
   * @param {string} scope - OAuth scopes
   * @returns {Promise<boolean>}
   */
  async saveOAuthToken(id, provider, userId, accessToken, refreshToken, expiresAt, scope = '') {
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

  /**
   * Get OAuth token by ID
   * @param {string} id - Token UUID
   * @returns {Promise<Object|null>}
   */
  async getOAuthToken(id) {
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

  /**
   * Update OAuth token (for refresh)
   * @param {string} id - Token UUID
   * @param {string} accessToken - New access token
   * @param {string} refreshToken - New refresh token
   * @param {number} expiresAt - New expiration timestamp
   * @returns {Promise<boolean>}
   */
  async updateOAuthToken(id, accessToken, refreshToken, expiresAt) {
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

  /**
   * Delete OAuth token by ID
   * @param {string} id - Token UUID
   * @returns {Promise<boolean>}
   */
  async deleteOAuthToken(id) {
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

  /**
   * Get all OAuth tokens for a provider
   * @param {string} provider - OAuth provider
   * @returns {Promise<Array>}
   */
  async getOAuthTokensByProvider(provider) {
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

// Create singleton instance
const database = new Database();

module.exports = database;
