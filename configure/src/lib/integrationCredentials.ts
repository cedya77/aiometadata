// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
export type IntegrationProvider = 'trakt' | 'simkl' | 'anilist' | 'mal' | 'movielens';

interface PersistArgs {
  provider: IntegrationProvider;
  tokenId: string;
  userUUID: string | null;
  password: string | null;
  authenticated: boolean;
  profile?: string;
}

/**
 * Writes the credential pointer through to the stored configuration as soon as it is
 * connected. Only the pointer is sent, so edits still open in the page are untouched.
 * An unsaved configuration has nothing to write to yet; there the pointer rides along
 * with the first save, which is what the caller's local update covers.
 */
export async function persistIntegrationCredential(
  { provider, tokenId, userUUID, password, authenticated, profile }: PersistArgs
): Promise<{ persisted: boolean; error?: string }> {
  if (!authenticated || !userUUID || !tokenId) return { persisted: false };
  try {
    const response = await fetch('/api/integrations/credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userUUID, password, provider, tokenId, ...(profile ? { profile } : {}) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { persisted: false, error: data?.error || `Save failed (${response.status})` };
    return { persisted: true };
  } catch (error) {
    return { persisted: false, error: error instanceof Error ? error.message : 'Save failed' };
  }
}

/** Disconnects one service from a Jellyfin user; a user the server has not stored yet has nothing to disconnect. */
export async function disconnectCardAccount(path: string, userUUID: string, profile: string, password: string | null): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userUUID, profile, password }),
    });
    if (response.ok || response.status === 404) return { ok: true };
    const data = await response.json().catch(() => ({}));
    return { ok: false, error: data?.error || `Disconnect failed (${response.status})` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Disconnect failed' };
  }
}

export interface DisconnectRemovals {
  apiKeys?: string[];
  fields?: string[];
  catalogIdPrefix?: string;
}

/**
 * Applies exactly what a disconnect took out, leaving everything else in the page
 * alone. Adopting the server's whole document instead would be correct about this
 * provider and would quietly throw away any other edit still open.
 */
export function applyDisconnectRemovals<T extends Record<string, any>>(
  config: T,
  removed: DisconnectRemovals | undefined
): T {
  if (!removed) return config;
  const next: any = { ...config };
  for (const field of removed.fields || []) next[field] = undefined;
  if (removed.apiKeys?.length) {
    next.apiKeys = { ...(config.apiKeys || {}) };
    for (const key of removed.apiKeys) next.apiKeys[key] = undefined;
  }
  if (removed.catalogIdPrefix) {
    next.catalogs = (config.catalogs || []).filter(
      (catalog: any) => !String(catalog?.id || '').startsWith(removed.catalogIdPrefix as string)
    );
  }
  return next as T;
}
