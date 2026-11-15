// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import crypto from 'crypto';

const database: any = require('./database');

export interface ManagerAccount {
  id: string;
  managerId: string;
  label: string;
  instanceUrl: string;
  keyId?: string;
  profileTags?: string[];
  autoSync?: boolean;
  lastSyncedAt?: string;
}

export function normalizeInstanceUrl(url: string): string {
  return String(url || '').trim().replace(/\/+$/, '');
}

export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function providerFor(managerId: string): string {
  return `manager:${managerId}`;
}

export function accountsOf(config: any): ManagerAccount[] {
  return Array.isArray(config?.managerAccounts) ? config.managerAccounts : [];
}

export function findAccount(config: any, accountId: string): ManagerAccount | null {
  return accountsOf(config).find(account => account.id === accountId) || null;
}

/**
 * The stored key for an account. Returns null rather than throwing so a caller
 * syncing several accounts can report the broken one and carry on with the rest.
 */
export async function resolveAccountKey(account: ManagerAccount | null): Promise<string | null> {
  if (!account?.keyId) return null;
  const row = await database.getOAuthToken(account.keyId);
  const key = row?.access_token;
  return typeof key === 'string' && key.trim() !== '' ? key : null;
}

async function storeKey(managerId: string, userUUID: string, apiKey: string, existingKeyId?: string): Promise<string> {
  const keyId = existingKeyId || crypto.randomUUID();
  await database.saveOAuthToken(keyId, providerFor(managerId), userUUID, apiKey, '', 0, '');
  return keyId;
}

export interface UpsertInput {
  accountId?: string;
  managerId: string;
  label?: string;
  instanceUrl: string;
  apiKey?: string;
  profileTags?: string[];
  autoSync?: boolean;
}

/**
 * Adds or edits one account on the config, storing the key out of line. Mutates and
 * returns the account list so the caller can save the config once.
 */
export async function upsertAccount(config: any, userUUID: string, input: UpsertInput): Promise<ManagerAccount> {
  const accounts = accountsOf(config).slice();
  const instanceUrl = normalizeInstanceUrl(input.instanceUrl);
  const existingIndex = input.accountId ? accounts.findIndex(a => a.id === input.accountId) : -1;
  const existing = existingIndex >= 0 ? accounts[existingIndex] : null;

  let keyId = existing?.keyId;
  if (input.apiKey) {
    keyId = await storeKey(input.managerId, userUUID, input.apiKey.trim(), keyId);
  }

  const account: ManagerAccount = {
    id: existing?.id || crypto.randomUUID(),
    managerId: input.managerId,
    label: (input.label || existing?.label || instanceUrl).trim() || instanceUrl,
    instanceUrl,
    ...(keyId ? { keyId } : {}),
    profileTags: Array.isArray(input.profileTags) ? input.profileTags : existing?.profileTags || [],
    autoSync: input.autoSync !== undefined ? !!input.autoSync : existing?.autoSync !== false,
    ...(existing?.lastSyncedAt ? { lastSyncedAt: existing.lastSyncedAt } : {}),
  };

  if (existingIndex >= 0) accounts[existingIndex] = account;
  else accounts.push(account);

  config.managerAccounts = accounts;
  return account;
}

export async function removeAccount(config: any, accountId: string): Promise<boolean> {
  const accounts = accountsOf(config);
  const account = accounts.find(a => a.id === accountId);
  if (!account) return false;
  if (account.keyId) {
    await database.deleteOAuthToken(account.keyId).catch(() => { /* the config entry is what matters */ });
  }
  config.managerAccounts = accounts.filter(a => a.id !== accountId);
  return true;
}

/**
 * Moves a pre-account config onto the new shape. The old map held the key in the
 * clear, so migrating is also what gets it out of the config body.
 */
export async function migrateLegacyManagers(config: any, userUUID: string): Promise<number> {
  if (accountsOf(config).length > 0 || !config?.managers) return 0;
  let migrated = 0;
  for (const [managerId, saved] of Object.entries<any>(config.managers)) {
    const instanceUrl = normalizeInstanceUrl(saved?.instanceUrl || '');
    const apiKey = String(saved?.apiKey || '').trim();
    if (!instanceUrl || !apiKey) continue;
    await upsertAccount(config, userUUID, {
      managerId,
      instanceUrl,
      apiKey,
      label: hostLabel(instanceUrl),
      profileTags: [],
      autoSync: true,
    });
    migrated += 1;
  }
  if (migrated > 0) delete config.managers;
  return migrated;
}

export function hostLabel(instanceUrl: string): string {
  try {
    return new URL(instanceUrl).host;
  } catch {
    return instanceUrl;
  }
}

module.exports = {
  normalizeInstanceUrl,
  isHttpUrl,
  accountsOf,
  findAccount,
  resolveAccountKey,
  upsertAccount,
  removeAccount,
  migrateLegacyManagers,
  hostLabel,
};
