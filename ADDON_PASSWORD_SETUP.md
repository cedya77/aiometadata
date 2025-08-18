# Addon Password Protection Setup

## 🔐 Overview

The addon password feature allows you to control who can create accounts on your addon instance. It acts as a "master key" that users must provide when registering.

## 🚀 Quick Setup

### 1. Set Environment Variable

Add to your `.env` file:

```bash
# Require addon password for new accounts
ADDON_PASSWORD=your-secret-master-password

# Or leave empty to disable protection
ADDON_PASSWORD=
```

### 2. Restart Your Addon

```bash
# Restart to apply the new environment variable
npm restart
# or
pm2 restart your-addon-name
```

## 📋 How It Works

### Without Addon Password (Default)
1. User configures addon
2. User sets personal password  
3. Account created ✅

### With Addon Password
1. User configures addon
2. User provides **addon password** (proves authorization)
3. User sets personal password
4. Account created ✅ (if addon password is correct)

## 🎯 Use Cases

### Public Instance Protection
```bash
# Prevent random users from creating accounts
ADDON_PASSWORD=only-my-friends-know-this-password
```

### Family/Friend Sharing  
```bash
# Share with trusted people
ADDON_PASSWORD=family-movie-night-2024
```

### Private Server
```bash
# No protection needed for personal use
ADDON_PASSWORD=
```

## 🔧 API Changes

### Frontend Integration Required

The frontend needs to be updated to:

1. **Check if addon password is required:**
```javascript
const response = await fetch('/api/config/addon-info');
const { requiresAddonPassword } = await response.json();
```

2. **Include addon password in requests:**
```javascript
// Save config
await fetch('/api/config/save', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    config: userConfig,
    password: userPassword,
    addonPassword: addonMasterPassword  // Only if required
  })
});

// Load config  
await fetch('/api/config/load/uuid', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    password: userPassword,
    addonPassword: addonMasterPassword  // Only if required
  })
});

// Update config
await fetch('/api/config/update/uuid', {
  method: 'PUT', 
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    config: newConfig,
    password: userPassword,
    addonPassword: addonMasterPassword  // Only if required
  })
});
```

## 🛡️ Security Features

- **Optional:** Can be disabled by leaving `ADDON_PASSWORD` empty
- **Server-side validation:** Password checked before any account operations
- **Clear error messages:** Users get helpful feedback if addon password is wrong
- **No impact on existing users:** Only affects new account creation and config access

## 📱 Error Messages

Users will see these errors if addon password is incorrect:

```json
{
  "error": "Invalid addon password. Contact the addon administrator."
}
```

## 🔄 Migration

Existing users are **not affected**. The addon password only applies to:
- New account creation
- Loading existing configurations  
- Updating existing configurations

## 🧪 Testing

### Test Addon Info Endpoint
```bash
curl http://localhost:11470/api/config/addon-info
```

**Response:**
```json
{
  "success": true,
  "requiresAddonPassword": true,
  "version": "1.0.0"
}
```

### Test Protected Endpoint
```bash
curl -X POST http://localhost:11470/api/config/save \
  -H "Content-Type: application/json" \
  -d '{
    "config": {"language": "en-US"},
    "password": "user123",
    "addonPassword": "wrong-password"
  }'
```

**Response:**
```json
{
  "error": "Invalid addon password. Contact the addon administrator."
}
```

## 💡 Best Practices

1. **Use Strong Passwords:** Make addon passwords hard to guess
2. **Share Securely:** Only give addon password to trusted users
3. **Document Access:** Keep track of who has the addon password
4. **Regular Updates:** Consider changing addon password periodically
5. **Backup Strategy:** Document the password in your server setup notes

## 🚨 Important Notes

- **Backend is ready** - All API endpoints now support addon password protection
- **Frontend update needed** - The web interface needs to be updated to collect and send addon passwords
- **Backward compatible** - Works with existing setups (disabled by default)
- **No data loss** - Existing user accounts and configurations remain unchanged
