import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../utils/envNumber';

const logger = consola.withTag('StremioStatus');

const PREF_ID = 'stremio-events';

export interface StremioLinkStatus { profile: string | null; manifestAt: number | null; eventAt: number | null }

const noted = new LRUCache<string, true>({
  max: 10000,
  ttl: envInt('STREMIO_STATUS_WRITE_SECONDS', 300, 1) * 1000,
});
const queues = new Map<string, Promise<void>>();

function note(userUUID: string, linkId: string, field: 'manifestAt' | 'eventAt'): void {
  const throttle = `${userUUID}:${linkId}:${field}`;
  if (noted.has(throttle)) return;
  noted.set(throttle, true, { ttl: envInt('STREMIO_STATUS_WRITE_SECONDS', 300, 1) * 1000 });

  const slot = `${userUUID}:${linkId}`;
  const at = Date.now();
  const next = (queues.get(slot) ?? Promise.resolve()).then(async () => {
    const database: any = require('./database');
    const held = (await database.getPreferences(userUUID, linkId, PREF_ID, '')) || {};
    await database.savePreferences(userUUID, linkId, PREF_ID, '', { ...held, [field]: at });
  }).catch((error: any) => logger.debug(`Recording ${field} for ${userUUID} failed: ${error?.message || error}`));
  queues.set(slot, next);
  next.finally(() => { if (queues.get(slot) === next) queues.delete(slot); });
}

export function noteManifest(userUUID: string, linkId: string): void {
  note(userUUID, linkId, 'manifestAt');
}

export function noteEvent(userUUID: string, linkId: string): void {
  note(userUUID, linkId, 'eventAt');
}

export async function readStatus(userUUID: string, linkIds: string[]): Promise<StremioLinkStatus[]> {
  const database: any = require('./database');
  return Promise.all(linkIds.map(async (linkId) => {
    const held = await database.getPreferences(userUUID, linkId, PREF_ID, '').catch(() => null);
    return {
      profile: linkId || null,
      manifestAt: Number(held?.manifestAt) || null,
      eventAt: Number(held?.eventAt) || null,
    };
  }));
}
