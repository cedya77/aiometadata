# Database Migration Guide

This guide will help you migrate from localStorage to a proper database system for storing user configurations.

## 🎯 Overview

The new database system provides:
- **Persistent storage** across browser sessions
- **Multi-user support** for shared instances
- **Session-based sharing** of configurations
- **Better scalability** for public deployments
- **Admin tools** for monitoring and maintenance

## 🗄️ Database Options

### SQLite (Recommended for Local Development)
```bash
# Simple file-based database
DATABASE_URI=sqlite://./data/db.sqlite
```

### PostgreSQL (Recommended for Production)
```bash
# PostgreSQL connection string
DATABASE_URI=postgres://username:password@host:port/database_name
```

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Set Environment Variables
Add to your `.env` file:
```bash
# Required: Database connection
DATABASE_URI=sqlite://./data/db.sqlite

# Optional: Admin key for admin endpoints
ADMIN_KEY=your-secret-admin-key
```

### 3. Run Migration Script
```bash
node scripts/migrate-to-database.js
```

### 4. Start the Server
```bash
npm start
```

## 📊 Database Schema

The system creates three main tables:

### `user_configs`
Stores user configuration data
```sql
CREATE TABLE user_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT UNIQUE NOT NULL,
  config_data TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### `user_themes`
Stores user theme preferences
```sql
CREATE TABLE user_themes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT UNIQUE NOT NULL,
  theme TEXT NOT NULL DEFAULT 'dark',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### `user_sessions`
Stores temporary session data for sharing
```sql
CREATE TABLE user_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL,
  config_data TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user_configs(user_id) ON DELETE CASCADE
);
```

## 🔌 API Endpoints

### Configuration Management
```http
POST /api/config/save
Content-Type: application/json

{
  "config": {
    "language": "en-US",
    "providers": { "movie": "tmdb", "series": "tvdb" },
    "apiKeys": { "tmdb": "your-key" }
  }
}
```

```http
GET /api/config/load?sessionId=abc123
```

### Theme Management
```http
POST /api/config/theme
Content-Type: application/json

{
  "theme": "dark"
}
```

```http
GET /api/config/theme
```

### Session Management
```http
GET /api/config/session/:sessionId
```

```http
POST /api/config/share
```

### Migration
```http
POST /api/config/migrate
Content-Type: application/json

{
  "localStorageData": "your-localStorage-data"
}
```

### Admin Endpoints
```http
GET /api/config/stats
X-Admin-Key: your-secret-admin-key
```

```http
POST /api/config/cleanup
X-Admin-Key: your-secret-admin-key
```

## 🔄 Frontend Migration

### Before (localStorage)
```typescript
// Save configuration
localStorage.setItem('stremio-addon-config', JSON.stringify(config));

// Load configuration
const config = JSON.parse(localStorage.getItem('stremio-addon-config') || '{}');
```

### After (Database API)
```typescript
// Save configuration
const response = await fetch('/api/config/save', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ config })
});

// Load configuration
const response = await fetch('/api/config/load');
const { config } = await response.json();
```

## 🎨 Theme Migration

### Before (localStorage)
```typescript
// Save theme
localStorage.setItem('vite-ui-theme', theme);

// Load theme
const theme = localStorage.getItem('vite-ui-theme') || 'dark';
```

### After (Database API)
```typescript
// Save theme
await fetch('/api/config/theme', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ theme })
});

// Load theme
const response = await fetch('/api/config/theme');
const { theme } = await response.json();
```

## 🔗 Configuration Sharing

### Generate Share URL
```typescript
const response = await fetch('/api/config/share', { method: 'POST' });
const { shareUrl, sessionId } = await response.json();
```

### Load Shared Configuration
```typescript
const response = await fetch(`/api/config/session/${sessionId}`);
const { config } = await response.json();
```

## 🛠️ Admin Tools

### Database Statistics
```bash
curl -H "X-Admin-Key: your-secret-admin-key" \
  http://localhost:11470/api/config/stats
```

### Cleanup Expired Sessions
```bash
curl -X POST -H "X-Admin-Key: your-secret-admin-key" \
  http://localhost:11470/api/config/cleanup
```

## 🔧 Environment Variables

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `DATABASE_URI` | Yes | Database connection string | `sqlite://./data/db.sqlite` |
| `ADMIN_KEY` | No | Admin key for admin endpoints | `your-secret-key` |

## 🚨 Troubleshooting

### Database Connection Issues
```bash
# Check if DATABASE_URI is set
echo $DATABASE_URI

# Test SQLite database
sqlite3 ./data/db.sqlite "SELECT 1;"

# Test PostgreSQL connection
psql $DATABASE_URI -c "SELECT 1;"
```

### Permission Issues
```bash
# Ensure data directory exists and is writable
mkdir -p ./data
chmod 755 ./data
```

### Migration Issues
```bash
# Run migration with verbose logging
DEBUG=* node scripts/migrate-to-database.js
```

## 📈 Performance Considerations

### SQLite
- **Pros**: Simple setup, no server required, good for small to medium deployments
- **Cons**: Limited concurrent writes, not suitable for high-traffic sites

### PostgreSQL
- **Pros**: Better concurrency, ACID compliance, suitable for production
- **Cons**: Requires database server, more complex setup

## 🔒 Security Notes

1. **Admin Key**: Use a strong, unique admin key for production
2. **Database Access**: Restrict database access to your application only
3. **Session Expiry**: Sessions automatically expire after 24 hours
4. **User Isolation**: Each user gets a unique ID based on their request fingerprint

## 🎯 Migration Checklist

- [ ] Set `DATABASE_URI` environment variable
- [ ] Run migration script: `node scripts/migrate-to-database.js`
- [ ] Update frontend code to use new API endpoints
- [ ] Test configuration saving and loading
- [ ] Test theme persistence
- [ ] Test configuration sharing
- [ ] Remove localStorage usage from code
- [ ] Test admin endpoints (if using)
- [ ] Monitor database performance
- [ ] Set up database backups (for production)

## 📞 Support

If you encounter issues during migration:

1. Check the troubleshooting section above
2. Review the migration script output
3. Check database connection and permissions
4. Verify environment variables are set correctly
5. Check server logs for error messages

## 🔄 Rollback Plan

If you need to rollback to localStorage:

1. Keep the old localStorage code commented out
2. Add a feature flag to switch between storage methods
3. Test thoroughly before removing localStorage support
4. Keep database migration scripts for future use











