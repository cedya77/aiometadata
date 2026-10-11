# Google Drive Backups

Google Drive backups are configured per saved UUID. Each UUID connects its own Google account; the app's OAuth client credentials belong to the server operator.

## Server setup

1. In Google Cloud Console, create or select a project, enable the Google Drive API, and configure the OAuth consent screen.
2. Create an OAuth client ID with application type **Web application**.
3. Add `${HOST_NAME}/api/auth/google-drive/callback` to the client's authorized redirect URIs. If the server uses a different public URL, set `GOOGLE_DRIVE_REDIRECT_URI` to that exact URI.
4. Set `GOOGLE_DRIVE_CLIENT_ID` and `GOOGLE_DRIVE_CLIENT_SECRET` in the server environment and restart the server.

The application requests only the `drive.file` scope and can access files it creates. A publicly hosted instance may need its Google OAuth consent screen published or its users added as test users, according to the project's Google configuration.

## User controls

After loading a saved UUID configuration, open **Configuration → Import / Export → Google Drive Backups**:

- Connect the Google account that should hold this UUID's backups.
- Daily backups are enabled after connecting. A backup is scheduled immediately and then once every 24 hours while the server is running.
- The default retention limit is 10 backups. Change the limit to retain a different number; the oldest backups are removed when a new backup would exceed it.
- **Back Up Now** creates an immediate snapshot of the last-saved configuration.
- Choose a dated snapshot to restore. Restore replaces the saved configuration and is subject to the same validation as a normal configuration save.
- **Download** saves a selected snapshot as a portable JSON file. Keep this file private: it includes the configuration and API keys.
- To recover on another instance, choose the downloaded JSON under **Recover from a portable backup**, set a new configuration password, and submit. Recovery creates a new UUID on that instance and restores the configuration and Jellyfin history under it; any currently loaded UUID is left unchanged. This file-based transfer works even when the two instances use different Google OAuth apps. If the instance requires its add-on password to create configurations, enter it as well.
- Disconnecting stops future backups and removes the local authorization token, but leaves existing files in Drive.

Backups contain the saved configuration, including its API keys and settings, plus the Jellyfin integration's locally stored per-profile state: playback progress and watched/scrobble records, favorites, watchlists, dropped titles, ratings, and Jellyfin preferences. This state is restored with the configuration. Pending tracker writes and Jellyfin/API authorization tokens are not included; linked service OAuth tokens remain separately stored by the instance. History held by external tracker accounts remains with those services. Keep the connected Google account and its Drive files private. Restoring on a different server does not migrate linked OAuth tokens.

The portable JSON file is a sensitive export with the same contents as the Drive backup. Transfer it over a secure channel and delete extra copies when they are no longer needed. The Drive OAuth token is never included. After portable recovery, connect Google Drive on the destination UUID to enable future scheduled backups there.
