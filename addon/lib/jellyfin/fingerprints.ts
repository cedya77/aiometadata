import consola from 'consola';
import { envInt } from '../../utils/envNumber';
import { decodeJellyfinId, normaliseJellyfinId } from './ids';
import { isAnimeId, showIdentity } from './canonicalIds';

const logger = consola.withTag('Jellyfin');
const database: any = require('../database');

const KINDS = new Set(['intro', 'credits']);
const MAX_POINTS = 8000;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const NEIGHBOURS = 6;
const MAX_EPISODE = 9999;
const MAX_START_MS = 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
let prunedAt = 0;

async function episodeOf(itemId: unknown, config: any): Promise<{ series: string; season: number; episode: number } | null> {
  const descriptor = await decodeJellyfinId(normaliseJellyfinId(String(itemId ?? '')));
  if (!descriptor || descriptor.k !== 'episode' || !Number.isInteger(descriptor.e)) return null;
  // An anime entry numbers its episodes without a season and is one season of its own.
  const season = Number.isInteger(descriptor.s) ? Number(descriptor.s) : descriptor.s == null && isAnimeId(String(descriptor.i)) ? 1 : null;
  if (season === null) return null;
  return { series: await showIdentity(String(descriptor.i), config), season, episode: Number(descriptor.e) };
}

function kindOf(value: unknown): string | null {
  const kind = String(value ?? '').toLowerCase();
  return KINDS.has(kind) ? kind : null;
}

export async function listSeasonFingerprints(itemId: unknown, kindValue: unknown, config: any): Promise<any[] | null> {
  const kind = kindOf(kindValue);
  const at = await episodeOf(itemId, config);
  if (!kind || !at) return null;
  const rows = await database.listFingerprints(at.series, at.season, kind, at.episode, NEIGHBOURS);
  return rows.map((row: any) => ({ Episode: Number(row.episode), StartMs: Number(row.start_ms), Points: String(row.points) }));
}

export async function saveSeasonFingerprint(itemId: unknown, body: any, config: any, contributor: string): Promise<boolean> {
  const kind = kindOf(body?.Kind);
  const startMs = Number(body?.StartMs);
  const points = typeof body?.Points === 'string' ? body.Points : '';
  // Node's decoder skips characters outside base64, so the text itself is checked before its decoded size.
  if (points.length > 4 * Math.ceil((MAX_POINTS * 4) / 3) || points.length % 4 !== 0 || !BASE64.test(points)) return false;
  const size = Buffer.from(points, 'base64').length;
  if (!kind || !Number.isFinite(startMs) || startMs < 0 || startMs > MAX_START_MS || !size || size % 4 !== 0 || size / 4 > MAX_POINTS) return false;
  const at = await episodeOf(itemId, config);
  if (!at || at.episode < 1 || at.episode > MAX_EPISODE) return false;
  // The table is shared by every user, so a season takes new episodes only up to a size no real season reaches.
  const { held, count } = await database.fingerprintHeld(at.series, at.season, at.episode, kind);
  if (!held && count >= envInt('JELLYFIN_FINGERPRINT_SEASON_MAX', 3000, 1)) return false;
  await database.saveFingerprint(at.series, at.season, at.episode, kind, startMs, points, contributor);
  const now = Date.now();
  if (now - prunedAt > PRUNE_EVERY_MS) {
    prunedAt = now;
    const days = envInt('JELLYFIN_FINGERPRINT_DAYS', 365, 1);
    database.pruneFingerprints(now - days * 24 * 60 * 60 * 1000).catch((error: any) => logger.debug(`Fingerprint prune failed: ${error?.message || error}`));
  }
  return true;
}
