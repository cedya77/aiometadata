// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import { SETTINGS_REGISTRY, CONDITIONAL_RULES, getSettingDefinition, type SettingDefinition } from './settingsRegistry.js';
import { WINDOW_JOBS, quietHoursKeys, windowSettingFromQuietHours } from './runWindow';

const logger = consola.withTag('Settings');
const database: any = require('./database');

const cache = new Map<string, string>();
const originalEnv = new Map<string, string | undefined>();
const bootValues = new Map<string, string>();
let initialized = false;

export async function initializeSettings(): Promise<void> {
  if (initialized) return;
  const rows: { key: string; value: string }[] = await database.allQuery(
    'SELECT key, value FROM addon_settings'
  );
  for (const row of rows) {
    cache.set(row.key, row.value);
  }
  await convertQuietHours();
  for (const [key, value] of cache) {
    const def = getSettingDefinition(key);
    if (def && !def.envOnly) {
      originalEnv.set(def.envVar, process.env[def.envVar]);
      process.env[def.envVar] = value;
    }
  }
  for (const def of SETTINGS_REGISTRY) {
    bootValues.set(def.key, getSetting(def.key));
  }
  initialized = true;
  applySideEffects();
  logger.info(`Loaded ${rows.length} settings from database`);
}

async function storeRow(key: string, value: string): Promise<void> {
  if (database.type === 'sqlite') {
    await database.runQuery(
      `INSERT INTO addon_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`,
      [key, value, value]
    );
  } else {
    await database.runQuery(
      `INSERT INTO addon_settings (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
      [key, value]
    );
  }
}

async function deleteRow(key: string): Promise<void> {
  if (database.type === 'sqlite') {
    await database.runQuery('DELETE FROM addon_settings WHERE key = ?', [key]);
  } else {
    await database.runQuery('DELETE FROM addon_settings WHERE key = $1', [key]);
  }
}

const JOB_NAMES = { CATALOG_WARMUP: 'catalog warming', MAL_WARMUP: 'MAL warming', CACHE_CLEANUP: 'cache cleanup' } as const;

async function convertQuietHours(): Promise<void> {
  for (const job of WINDOW_JOBS) {
    const { enabled, range } = quietHoursKeys(job);
    if (!cache.has(enabled) && !cache.has(range)) continue;
    const target = `${job}_WINDOW`;
    if (!cache.has(target)) {
      const window = windowSettingFromQuietHours(job, cache.get(enabled) ?? process.env[enabled], cache.get(range) ?? process.env[range]);
      if (window) {
        await storeRow(target, window);
        cache.set(target, window);
        logger.info(`Quiet hours for ${JOB_NAMES[job]} are now ${target}=${window}`);
      }
    }
    for (const key of [enabled, range]) {
      await deleteRow(key);
      cache.delete(key);
    }
  }
}

export function getSetting(key: string): string {
  const def = getSettingDefinition(key);
  if (!def) return '';
  const envVal = process.env[def.envVar] || (def.legacyEnvVar ? process.env[def.legacyEnvVar] : undefined);
  if (def.envOnly && envVal) return envVal;
  const dbVal = cache.get(key);
  if (dbVal !== undefined) return dbVal;
  if (envVal) return envVal;
  return String(def.default);
}

export function previewSettingValue(key: string, value: string | null): string {
  const def = getSettingDefinition(key);
  if (!def) return '';
  if (value !== null) return value;
  const restored = originalEnv.has(def.envVar) ? originalEnv.get(def.envVar) : undefined;
  const envVal = restored || (def.legacyEnvVar ? process.env[def.legacyEnvVar] : undefined);
  if (envVal) return envVal;
  return String(def.default);
}

export async function setSetting(key: string, value: string): Promise<void> {
  const def = getSettingDefinition(key);
  if (!def) throw new Error(`Unknown setting: ${key}`);
  if (def.envOnly) throw new Error(`Setting ${key} can only be configured via environment variable`);
  if (def.validate && !def.validate(value)) throw new Error(`Invalid value for ${key}`);

  await storeRow(key, value);
  cache.set(key, value);
  if (!originalEnv.has(def.envVar)) {
    originalEnv.set(def.envVar, process.env[def.envVar]);
  }
  process.env[def.envVar] = value;
  applySideEffects(key);
  logger.info(`Setting ${key} updated`);
}

export async function resetSetting(key: string): Promise<void> {
  const def = getSettingDefinition(key);
  if (!def) throw new Error(`Unknown setting: ${key}`);
  if (def.envOnly) throw new Error(`Setting ${key} can only be configured via environment variable`);

  await deleteRow(key);
  cache.delete(key);
  const orig = originalEnv.get(def.envVar);
  if (orig !== undefined) {
    process.env[def.envVar] = orig;
  } else {
    delete process.env[def.envVar];
  }
  originalEnv.delete(def.envVar);
  applySideEffects(key);
  logger.info(`Setting ${key} reset to default`);
}

function evaluateDisabledState(): Map<string, string> {
  const disabled = new Map<string, string>();
  for (const rule of CONDITIONAL_RULES) {
    const currentVal = getSetting(rule.when.key);
    if (currentVal !== rule.when.eq) continue;
    if (rule.disable.keys) {
      for (const k of rule.disable.keys) disabled.set(k, rule.reason);
    }
    if (rule.disable.categories) {
      for (const def of SETTINGS_REGISTRY) {
        if (rule.disable.categories.includes(def.category)) {
          disabled.set(def.key, rule.reason);
        }
      }
    }
  }
  return disabled;
}

/** consola reads CONSOLA_LEVEL once when it is created, so a stored value is applied to it directly. */
function applyLogLevel(): void {
  const parsed = parseInt(getSetting('CONSOLA_LEVEL'), 10);
  if (Number.isFinite(parsed)) consola.level = parsed;
}

/** Settings the process has to be told about, rather than reading them when next needed. */
export function applySideEffects(key?: string): void {
  if (key === undefined || key === 'CONSOLA_LEVEL') applyLogLevel();
}

export interface SettingsExport {
  exportedAt: string;
  version: string;
  settings: Record<string, string | null>;
  /** Secrets are written as null; these are the keys to enter again by hand. */
  maskedSecretKeys: string[];
}

/** Every setting saved from the dashboard, secrets blanked. */
export function exportSettings(): SettingsExport {
  const settings: Record<string, string | null> = {};
  const maskedSecretKeys: string[] = [];
  for (const def of SETTINGS_REGISTRY) {
    if (def.envOnly || !cache.has(def.key)) continue;
    if (def.sensitive) {
      settings[def.key] = null;
      maskedSecretKeys.push(def.key);
    } else {
      settings[def.key] = cache.get(def.key) as string;
    }
  }
  return { exportedAt: new Date().toISOString(), version: require('./buildInfo').version, settings, maskedSecretKeys };
}

/** Why a value cannot be saved under this setting, or null when it can. */
export function invalidValueReason(def: SettingDefinition, value: string): string | null {
  if (def.type === 'number') {
    const n = Number(value);
    if (value.trim() === '' || !Number.isFinite(n)) return 'not a number';
    if (def.min !== undefined && n < def.min) return `below ${def.min}`;
    if (def.max !== undefined && n > def.max) return `above ${def.max}`;
  }
  if (def.type === 'boolean' && value !== 'true' && value !== 'false') return 'not true or false';
  if (def.type === 'select' && def.options && !def.options.includes(value)) return 'not one of its options';
  if (def.validate && !def.validate(value)) return 'invalid value';
  return null;
}

export function hasStoredValue(key: string): boolean {
  return cache.has(key);
}

export function getAllSettings(): object[] {
  const disabledMap = evaluateDisabledState();

  return SETTINGS_REGISTRY.map((def) => {
    const currentValue = getSetting(def.key);
    const hasEnvVar = originalEnv.has(def.envVar) || !!(process.env[def.envVar] && !cache.has(def.key))
      || !!(def.legacyEnvVar && process.env[def.legacyEnvVar] && !cache.has(def.key));
    const hasDbOverride = cache.has(def.key);
    const disabledReason = disabledMap.get(def.key) || null;

    return {
      key: def.key,
      label: def.label,
      description: def.description,
      category: def.category,
      type: def.type,
      default: def.default,
      options: def.options,
      sensitive: def.sensitive ?? false,
      requiresRestart: def.requiresRestart ?? false,
      envOnly: def.envOnly ?? false,
      uiHint: def.uiHint ?? null,
      maxTags: def.maxTags ?? null,
      min: def.min ?? null,
      max: def.max ?? null,
      value: currentValue,
      hasEnvVar,
      hasDbOverride,
      disabledReason,
      changedSinceBoot: (def.requiresRestart ?? false)
        && bootValues.has(def.key)
        && String(currentValue) !== String(bootValues.get(def.key)),
    };
  });
}
