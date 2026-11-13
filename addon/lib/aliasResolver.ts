// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import { getSetting } from './settingsService.js';
import { validateAlias, parseAliasSeed, normalizeAlias } from './userAliases.js';

const database: any = require('./database');

const logger = consola.withTag('UserAliases');

// aliasLower -> canonical uuid
let aliasToUuid = new Map<string, string>();
// uuid -> alias in its display casing
let uuidToAlias = new Map<string, string>();
let loadedAtMs = 0;
let refreshInFlight: Promise<void> | null = null;

function refreshIntervalMs(): number {
  const parsed = Number.parseInt(getSetting('USER_ALIAS_REFRESH_SEC'), 10);
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : 30) * 1000;
}

export function isAliasFeatureEnabled(): boolean {
  return getSetting('USER_ALIASES_ENABLED') === 'true';
}

export async function loadAliasMap(): Promise<void> {
  const rows = await database.getAllUserAliases();
  const nextAliasToUuid = new Map<string, string>();
  const nextUuidToAlias = new Map<string, string>();

  for (const row of rows) {
    nextAliasToUuid.set(row.alias_lower, row.user_uuid);
    nextUuidToAlias.set(row.user_uuid, row.alias);
  }

  aliasToUuid = nextAliasToUuid;
  uuidToAlias = nextUuidToAlias;
  loadedAtMs = Date.now();
}

// Non-blocking staleness check. Callers never await this; a stale map serves
// the current request and the next one sees the refreshed data.
function maybeRefresh(): void {
  if (refreshInFlight) return;
  if (Date.now() - loadedAtMs < refreshIntervalMs()) return;

  refreshInFlight = loadAliasMap()
    .catch((error: any) => {
      loadedAtMs = Date.now();
      logger.warn(`Alias map refresh failed: ${error.message}`);
    })
    .finally(() => { refreshInFlight = null; });
}

export function resolveAliasSync(aliasLower: string): string | null {
  maybeRefresh();
  return aliasToUuid.get(aliasLower) || null;
}

export function getAliasForUuid(userUUID: string): string | null {
  return uuidToAlias.get(userUUID) || null;
}

export async function setAliasForUser(
  userUUID: string,
  rawAlias: unknown
): Promise<{ ok: boolean; alias?: string; status?: number; error?: string }> {
  const validation = validateAlias(rawAlias);
  if (!validation.valid) {
    return { ok: false, status: 400, error: validation.reason };
  }

  const existingOwner = aliasToUuid.get(validation.aliasLower);
  if (existingOwner && existingOwner !== userUUID) {
    return { ok: false, status: 409, error: `Alias "${validation.alias}" is already taken.` };
  }

  const user = await database.getUser(userUUID);
  if (!user) {
    return { ok: false, status: 404, error: 'User not found.' };
  }

  try {
    await database.setUserAlias(userUUID, validation.alias, validation.aliasLower);
  } catch (error: any) {
    // Alias taken, or lost a race against another writer claiming it.
    const message = String(error?.message || '');
    if (error?.code === 'ALIAS_TAKEN' || message.includes('UNIQUE') || error?.code === '23505') {
      await loadAliasMap();
      return { ok: false, status: 409, error: `Alias "${validation.alias}" is already taken.` };
    }
    throw error;
  }

  await loadAliasMap();
  logger.info(`Alias "${validation.alias}" assigned to ${userUUID}`);
  return { ok: true, alias: validation.alias };
}

export async function clearAliasForUser(userUUID: string): Promise<boolean> {
  const removed = await database.deleteUserAlias(userUUID);
  await loadAliasMap();
  return removed;
}

async function seedAliasesFromEnv(): Promise<void> {
  const raw = getSetting('USER_ALIASES');
  const { entries, errors } = parseAliasSeed(raw);

  for (const error of errors) {
    logger.warn(`USER_ALIASES: ${error}`);
  }

  for (const entry of entries) {
    const user = await database.getUser(entry.userUUID);
    if (!user) {
      logger.warn(`USER_ALIASES: no such user ${entry.userUUID} for alias "${entry.alias}", skipping.`);
      continue;
    }

    const aliasLower = normalizeAlias(entry.alias);
    const currentOwner = aliasToUuid.get(aliasLower);
    if (currentOwner && currentOwner !== entry.userUUID) {
      // The env file is the self-hoster's declared intent, so it wins: free the
      // alias from its current owner first.
      await database.deleteUserAlias(currentOwner);
      logger.warn(`USER_ALIASES: alias "${entry.alias}" reassigned from ${currentOwner} to ${entry.userUUID}.`);
      await loadAliasMap();
    }

    try {
      await database.setUserAlias(entry.userUUID, entry.alias, aliasLower);
      await loadAliasMap();
    } catch (error: any) {
      logger.warn(`USER_ALIASES: failed to apply "${entry.alias}": ${error.message}`);
    }
  }
}

export async function initializeUserAliases(): Promise<void> {
  await loadAliasMap();

  if (!isAliasFeatureEnabled()) {
    logger.debug('User aliases disabled (USER_ALIASES_ENABLED=false)');
    return;
  }

  await seedAliasesFromEnv();
  logger.info(`User aliases enabled (${aliasToUuid.size} configured)`);
}

module.exports = {
  isAliasFeatureEnabled,
  loadAliasMap,
  resolveAliasSync,
  getAliasForUuid,
  setAliasForUser,
  clearAliasForUser,
  initializeUserAliases,
};
