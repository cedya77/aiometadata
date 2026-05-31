import consola from 'consola';
import { SETTINGS_REGISTRY, CONDITIONAL_RULES, getSettingDefinition, type SettingDefinition } from './settingsRegistry.js';

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
  logger.info(`Loaded ${rows.length} settings from database`);
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

export async function setSetting(key: string, value: string): Promise<void> {
  const def = getSettingDefinition(key);
  if (!def) throw new Error(`Unknown setting: ${key}`);
  if (def.envOnly) throw new Error(`Setting ${key} can only be configured via environment variable`);
  if (def.validate && !def.validate(value)) throw new Error(`Invalid value for ${key}`);

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
  cache.set(key, value);
  if (!originalEnv.has(def.envVar)) {
    originalEnv.set(def.envVar, process.env[def.envVar]);
  }
  process.env[def.envVar] = value;
  logger.info(`Setting ${key} updated`);
}

export async function resetSetting(key: string): Promise<void> {
  const def = getSettingDefinition(key);
  if (!def) throw new Error(`Unknown setting: ${key}`);

  if (database.type === 'sqlite') {
    await database.runQuery('DELETE FROM addon_settings WHERE key = ?', [key]);
  } else {
    await database.runQuery('DELETE FROM addon_settings WHERE key = $1', [key]);
  }
  cache.delete(key);
  const orig = originalEnv.get(def.envVar);
  if (orig !== undefined) {
    process.env[def.envVar] = orig;
  } else {
    delete process.env[def.envVar];
  }
  originalEnv.delete(def.envVar);
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
