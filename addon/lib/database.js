const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

class Database {
  constructor() {
    this.db = null;
    this.type = null;
    this.initialized = false;
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
    console.log(`[Database] Initialized ${this.type} database`);
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
      )`
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
      )`
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
    const configJson = typeof configData === 'string' ? configData : JSON.stringify(configData);
    
    if (this.type === 'sqlite') {
      await this.runQuery(
        `INSERT OR REPLACE INTO user_configs (user_uuid, password_hash, config_data, updated_at) 
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
        [userUUID, passwordHash, configJson]
      );
    } else {
      await this.runQuery(
        `INSERT INTO user_configs (user_uuid, password_hash, config_data, updated_at) 
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (user_uuid) 
         DO UPDATE SET password_hash = $2, config_data = $3, updated_at = CURRENT_TIMESTAMP`,
        [userUUID, passwordHash, configData]
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
      console.error('[Database] Error parsing config data:', error);
      return null;
    }
  }

  // ID Mapping Cache Methods
  async getCachedIdMapping(contentType, tmdbId = null, tvdbId = null, imdbId = null, tvmazeId = null) {
    const conditions = [];
    const params = [];
    let paramIndex = 1;

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

    if (conditions.length === 0) return null;

    const contentTypeCondition = this.type === 'sqlite' ? 'content_type = ?' : `content_type = $${paramIndex++}`;
    params.push(contentType);

    const query = `
      SELECT tmdb_id, tvdb_id, imdb_id, tvmaze_id 
      FROM id_mappings 
      WHERE ${contentTypeCondition} AND (${conditions.join(' OR ')})
      LIMIT 1
    `;

    return await this.getQuery(query, params);
  }

  async saveIdMapping(contentType, tmdbId = null, tvdbId = null, imdbId = null, tvmazeId = null) {
    // Skip if no IDs provided
    if (!tmdbId && !tvdbId && !imdbId && !tvmazeId) return;

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
    const cached = await this.getCachedIdMapping(contentType, tmdbId, tvdbId, imdbId, tvmazeId);
    if (cached) {
      console.log(`[ID Cache] Found cached mapping for ${contentType}:`, cached);
      return cached;
    }
    return null;
  }

  // Verify user password and get config (tolerant: tries raw and trimmed password)
  async verifyUserAndGetConfig(userUUID, password) {
    const crypto = require('crypto');
    const hashRaw = crypto.createHash('sha256').update(password).digest('hex');
    const hashTrim = crypto.createHash('sha256').update((password || '').trim()).digest('hex');

    const query = this.type === 'sqlite'
      ? 'SELECT password_hash, config_data FROM user_configs WHERE user_uuid = ?'
      : 'SELECT password_hash, config_data FROM user_configs WHERE user_uuid = $1';
    const row = await this.getQuery(query, [userUUID]);
    if (!row) return null;

    const storedHash = row.password_hash;
    if (storedHash !== hashRaw && storedHash !== hashTrim) {
      return null;
    }

    try {
      return typeof row.config_data === 'string'
        ? JSON.parse(row.config_data)
        : row.config_data;
    } catch (error) {
      console.error('[Database] Error parsing user config:', error);
      return null;
    }
  }

  // Delete user configuration
  async deleteUserConfig(userUUID) {
    const query = this.type === 'sqlite'
      ? 'DELETE FROM user_configs WHERE user_uuid = ?'
      : 'DELETE FROM user_configs WHERE user_uuid = $1';
    await this.runQuery(query, [userUUID]);
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
      console.log('[Database] Migrated localStorage config for user:', userUUID);
      
      return userUUID;
    } catch (error) {
      console.error('[Database] Migration failed:', error);
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
}

// Create singleton instance
const database = new Database();

module.exports = database;
