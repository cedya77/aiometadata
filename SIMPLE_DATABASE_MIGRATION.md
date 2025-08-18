# Password-Protected Database Migration Guide

This guide covers the essential database migration for replacing localStorage with UUID-based, password-protected configuration storage.

## 🎯 Overview

The password-protected database system provides:
- **UUID-based user identification** for both public and private instances
- **Password protection** for configuration access
- **Frontend validation** requiring TMDB/TVDB API keys before password creation
- **Database storage** replacing localStorage
- **URL format**: `Hostname/stremio/uuid/compressedConfigString/manifest.json`

## 🔄 User Flow

1. **User configures addon** in web interface
2. **Frontend validates** TMDB/TVDB API keys are provided
3. **User creates password** (only after validation passes)
4. **System generates UUID** and saves config with password
5. **User receives UUID** and install URL
6. **User installs** in Stremio using the UUID-based URL
7. **User can access config** using UUID + password combination

## 🗄️ Database Setup

### Environment Variable
```bash
# Required: Database connection
DATABASE_URI=sqlite://./data/db.sqlite
```

### Install Dependencies
```bash
npm install
```

## 🔧 API Endpoints

### Save Configuration (with password)
```http
POST /api/config/save
Content-Type: application/json

{
  "config": {
    "language": "en-US",
    "providers": { "movie": "tmdb", "series": "tvdb" },
    "apiKeys": { 
      "tmdb": "your-tmdb-key",
      "tvdb": "your-tvdb-key"
    }
  },
  "password": "your-secure-password"
}
```

**Response:**
```json
{
  "success": true,
  "userUUID": "550e8400-e29b-41d4-a716-446655440000",
  "compressedConfig": "N4IgDgTg...",
  "installUrl": "http://localhost:11470/stremio/550e8400-e29b-41d4-a716-446655440000/N4IgDgTg.../manifest.json"
}
```

### Load Configuration (requires password)
```http
POST /api/config/load/:userUUID
Content-Type: application/json

{
  "password": "your-secure-password"
}
```

### Update Configuration (requires password)
```http
PUT /api/config/update/:userUUID
Content-Type: application/json

{
  "config": { "updated": "configuration" },
  "password": "your-secure-password"
}
```

### Migrate from localStorage
```http
POST /api/config/migrate
Content-Type: application/json

{
  "localStorageData": "your-localStorage-data",
  "password": "your-secure-password"
}
```

## 🔄 Frontend Migration

### Before (localStorage)
```typescript
// Save configuration
localStorage.setItem('stremio-addon-config', JSON.stringify(config));

// Load configuration
const config = JSON.parse(localStorage.getItem('stremio-addon-config') || '{}');
```

### After (Password-Protected Database API)
```typescript
// 1. Validate required API keys first
const requiredKeys = ['tmdb', 'tvdb'];
const missingKeys = requiredKeys.filter(key => !config.apiKeys?.[key]);

if (missingKeys.length > 0) {
  alert(`Please provide: ${missingKeys.join(', ')} API keys`);
  return;
}

// 2. Get password from user
const password = prompt('Create a password for your configuration:');
if (!password) return;

// 3. Save configuration
const response = await fetch('/api/config/save', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ config, password })
});

const { userUUID, installUrl } = await response.json();
console.log('Your UUID:', userUUID);
console.log('Install URL:', installUrl);

// 4. Load configuration (if needed)
const loadResponse = await fetch(`/api/config/load/${userUUID}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password })
});

const { config: loadedConfig } = await loadResponse.json();
```

## 🌐 URL Format

### UUID-Based URLs (for all instances)
```
http://your-host.com/stremio/{userUUID}/{compressedConfig}/manifest.json
```

### Examples
```
http://localhost:11470/stremio/550e8400-e29b-41d4-a716-446655440000/N4IgDgTg.../manifest.json
http://your-addon.com/stremio/abc123-def456-ghi789/N4IgDgTg.../manifest.json
```

## 🧪 Testing

### Run Database Test
```bash
node test-simple-database.js
```

### Test Migration
```bash
node scripts/migrate-to-database.js
```

## 📊 Database Schema

```sql
CREATE TABLE user_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_uuid TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  config_data TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## 🔒 Security Features

- **Password hashing** using SHA-256
- **Required API key validation** before password creation
- **UUID-based access** for manifest requests
- **Password verification** for configuration access
- **No password required** for manifest access (public read-only)

## 🔄 Migration Steps

1. **Set environment variable:**
   ```bash
   DATABASE_URI=sqlite://./data/db.sqlite
   ```

2. **Test database:**
   ```bash
   node test-simple-database.js
   ```

3. **Update frontend flow:**
   - Add API key validation before password creation
   - Implement password input after validation
   - Use returned `userUUID` and `installUrl`

4. **Deploy with new URL format:**
   - All instances use UUID-based URLs
   - Configurations protected by passwords
   - Users need UUID + password to access their config

## 🎯 Key Benefits

- **Secure**: Password-protected configuration access
- **Public instance ready**: UUID-based user identification
- **Persistent storage**: Configurations survive browser restarts
- **Easy sharing**: Generate install URLs automatically
- **Frontend validation**: Ensures required API keys before saving
- **Simple migration**: Minimal API changes required

## 📝 Example Frontend Flow

```typescript
// 1. User configures addon
const config = {
  language: "en-US",
  providers: { movie: 'tmdb', series: 'tvdb' },
  apiKeys: { 
    tmdb: 'user-tmdb-key',
    tvdb: 'user-tvdb-key'
  }
};

// 2. Frontend validates required keys
const requiredKeys = ['tmdb', 'tvdb'];
const missingKeys = requiredKeys.filter(key => !config.apiKeys?.[key]);

if (missingKeys.length > 0) {
  showError(`Please provide: ${missingKeys.join(', ')} API keys`);
  return;
}

// 3. User creates password
const password = await showPasswordDialog('Create a password for your configuration:');
if (!password) return;

// 4. Save to database
const response = await fetch('/api/config/save', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ config, password })
});

const { userUUID, installUrl } = await response.json();

// 5. Show user their credentials
showSuccess(`
  Configuration saved!
  
  Your UUID: ${userUUID}
  Install URL: ${installUrl}
  
  Save these credentials to access your configuration later.
`);

// 6. User installs in Stremio using installUrl
// Stremio calls: http://host.com/stremio/{userUUID}/{compressedConfig}/manifest.json

// 7. Later, user can access config using UUID + password
const loadResponse = await fetch(`/api/config/load/${userUUID}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: userPassword })
});

const { config: loadedConfig } = await loadResponse.json();
```

## 🚨 Troubleshooting

### Database Connection Issues
```bash
# Check if DATABASE_URI is set
echo $DATABASE_URI

# Test SQLite database
sqlite3 ./data/db.sqlite "SELECT 1;"
```

### Permission Issues
```bash
# Ensure data directory exists
mkdir -p ./data
chmod 755 ./data
```

### Migration Issues
```bash
# Run with verbose logging
DEBUG=* node test-simple-database.js
```

## ✅ Migration Checklist

- [ ] Set `DATABASE_URI` environment variable
- [ ] Run database test: `node test-simple-database.js`
- [ ] Add frontend API key validation
- [ ] Implement password creation flow
- [ ] Update frontend to use `/api/config/save`
- [ ] Test UUID-based URL format
- [ ] Test password protection
- [ ] Deploy and test public instance
- [ ] Remove localStorage usage from code
