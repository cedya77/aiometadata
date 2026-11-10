import { envInt } from '../../../utils/envNumber';

const getSetting = (key: string): string => require('../../settingsService').getSetting(key);

// getSetting returns a string, and the string 'false' is truthy.
const on = (value: unknown): boolean => String(value).trim().toLowerCase() === 'true';

export const syncPlayEnabled = (): boolean => on(getSetting('JELLYFIN_SYNCPLAY_ENABLED'));

export const syncPlayActive = (): boolean => on(getSetting('JELLYFIN_API_ENABLED')) && syncPlayEnabled();

export function syncPlayScope(): 'configuration' | 'instance' {
  return String(getSetting('JELLYFIN_SYNCPLAY_SCOPE')).trim().toLowerCase() === 'instance' ? 'instance' : 'configuration';
}

export function maxGroups(): number {
  const value = Math.floor(Number(getSetting('JELLYFIN_SYNCPLAY_MAX_GROUPS')));
  return Number.isFinite(value) && value >= 1 ? value : 1000;
}

export function graceMs(): number {
  return Math.max(30000, 2 * envInt('JELLYFIN_SOCKET_PING_MS', 30000, 1000));
}
