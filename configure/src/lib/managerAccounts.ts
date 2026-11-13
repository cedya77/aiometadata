// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { AppConfig, ManagerAccount } from '@/contexts/config';

export function normalizeInstanceUrl(url: string): string {
  return (url || '').trim().replace(/\/+$/, '');
}

/** Two accounts are the same destination when the instance and the key match. */
export function sameDestination(a: ManagerAccount, instanceUrl: string): boolean {
  return normalizeInstanceUrl(a.instanceUrl).toLowerCase() === normalizeInstanceUrl(instanceUrl).toLowerCase();
}

export function defaultLabelFor(instanceUrl: string, existing: ManagerAccount[]): string {
  let host = normalizeInstanceUrl(instanceUrl);
  try {
    host = new URL(host.includes('://') ? host : `https://${host}`).host;
  } catch {
    /* keep the raw string, it is only a suggestion */
  }
  const taken = new Set(existing.map(a => a.label.toLowerCase()));
  if (!taken.has(host.toLowerCase())) return host;
  for (let n = 2; ; n++) {
    const candidate = `${host} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Lifts the old `managers` map into the account list. The legacy shape held one
 * account per manager with the key inline, so the key cannot be carried across:
 * it is returned separately for the caller to store properly.
 */
export function liftLegacyManagers(
  config: Pick<AppConfig, 'managers' | 'managerAccounts'>
): Array<{ account: ManagerAccount; apiKey: string }> {
  if (config.managerAccounts?.length) return [];
  const legacy = config.managers || {};
  const lifted: Array<{ account: ManagerAccount; apiKey: string }> = [];
  for (const [managerId, saved] of Object.entries(legacy)) {
    const instanceUrl = normalizeInstanceUrl(saved?.instanceUrl || '');
    const apiKey = (saved?.apiKey || '').trim();
    if (!instanceUrl || !apiKey) continue;
    lifted.push({
      account: {
        id: newAccountId(),
        managerId,
        label: defaultLabelFor(instanceUrl, lifted.map(l => l.account)),
        instanceUrl,
        profileTags: [],
        autoSync: true,
      },
      apiKey,
    });
  }
  return lifted;
}

export function newAccountId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  return `acct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function accountsFor(config: Pick<AppConfig, 'managerAccounts'>, managerId: string): ManagerAccount[] {
  return (config.managerAccounts || []).filter(a => a.managerId === managerId);
}

export function taggedManifestUrl(installUrl: string, tags: string[]): string {
  const base = installUrl.split('?')[0];
  if (tags.length === 0) return base;
  if (/\/manifest\.json$/.test(base)) {
    const segments = tags.map(name => `/t/${encodeURIComponent(name)}`).join('');
    return base.replace(/\/manifest\.json$/, `${segments}/manifest.json`);
  }
  return `${base}?${tags.map(name => `tag=${encodeURIComponent(name)}`).join('&')}`;
}

export function profileUrlFor(baseInstallUrl: string, account: Pick<ManagerAccount, 'profileTags'>): string {
  if (!baseInstallUrl) return '';
  return taggedManifestUrl(baseInstallUrl, account.profileTags || []);
}

export function describeProfile(account: Pick<ManagerAccount, 'profileTags'>): string {
  const tags = account.profileTags || [];
  if (tags.length === 0) return 'Full install';
  if (tags.length <= 2) return tags.join(' + ');
  return `${tags.length} tags`;
}

/**
 * An account is a credential bound to this configuration, not portable content, so an
 * imported file must never take existing ones away. Accounts already here are kept
 * untouched; destinations only the file knows about are added without a key, so they
 * show up ready for one rather than silently pointing at someone else's credential.
 */
export function mergeImportedAccounts(
  current: ManagerAccount[] | undefined,
  imported: ManagerAccount[] | undefined
): ManagerAccount[] {
  const kept = current || [];
  const seen = new Set(
    kept.map(a => `${a.managerId}|${normalizeInstanceUrl(a.instanceUrl).toLowerCase()}`)
  );
  const added: ManagerAccount[] = [];
  for (const account of imported || []) {
    if (!account?.instanceUrl || !account?.managerId) continue;
    const key = `${account.managerId}|${normalizeInstanceUrl(account.instanceUrl).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({ ...account, id: newAccountId(), keyId: undefined });
  }
  return [...kept, ...added];
}
