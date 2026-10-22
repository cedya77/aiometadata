import consola from 'consola';
import { envInt } from '../../utils/envNumber';
import { decodeJellyfinId, normaliseJellyfinId } from './ids';
import { showIdentity } from './canonicalIds';

const logger = consola.withTag('Jellyfin');
const database: any = require('../database');

const KINDS = new Set(['intro', 'credits']);
// About 16 minutes of audio, past any window a client fingerprints.
const MAX_POINTS = 8000;
// The other episodes of the season sent back, nearest first.
const NEIGHBOURS = 6;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
let prunedAt = 0;

async function episodeOf(itemId: unknown, config: any): Promise<{ series: string; season: number; episode: number } | null> {
  const descriptor = await decodeJellyfinId(normaliseJellyfinId(String(itemId ?? '')));
  if (!descriptor || descriptor.k !== 'episode' || !Number.isInteger(descriptor.s) || !Number.isInteger(descriptor.e)) return null;
  return { series: await showIdentity(String(descriptor.i), config), season: Number(descriptor.s), episode: Number(descriptor.e) };
}

function kindOf(value: unknown): string | null {
  const kind = String(value ?? '').toLowerCase();
  return KINDS.has(kind) ? kind : null;
}

/** The fingerprints clients took of the other episodes of this one's season. */
export async function listSeasonFingerprints(itemId: unknown, kindValue: unknown, config: any): Promise<any[] | null> {
  const kind = kindOf(kindValue);
  const at = await episodeOf(itemId, config);
  if (!kind || !at) return null;
  const rows = await database.listFingerprints(at.series, at.season, kind);
  return rows
    .filter((row: any) => Number(row.episode) !== at.episode)
    .sort((a: any, b: any) => Math.abs(Number(a.episode) - at.episode) - Math.abs(Number(b.episode) - at.episode) || Number(a.episode) - Number(b.episode))
    .slice(0, NEIGHBOURS)
    .map((row: any) => ({ Episode: Number(row.episode), StartMs: Number(row.start_ms), Points: String(row.points) }));
}

/** Keeps a client's fingerprint of one episode's intro or credits for the others of its season. */
export async function saveSeasonFingerprint(itemId: unknown, body: any, config: any): Promise<boolean> {
  const kind = kindOf(body?.Kind);
  const startMs = Number(body?.StartMs);
  const points = typeof body?.Points === 'string' ? body.Points : '';
  const size = Buffer.from(points, 'base64').length;
  if (!kind || !Number.isFinite(startMs) || startMs < 0 || !size || size % 4 !== 0 || size / 4 > MAX_POINTS) return false;
  const at = await episodeOf(itemId, config);
  if (!at) return false;
  await database.saveFingerprint(at.series, at.season, at.episode, kind, startMs, points);
  const now = Date.now();
  if (now - prunedAt > PRUNE_EVERY_MS) {
    prunedAt = now;
    const days = envInt('JELLYFIN_FINGERPRINT_DAYS', 365, 1);
    database.pruneFingerprints(now - days * 24 * 60 * 60 * 1000).catch((error: any) => logger.debug(`Fingerprint prune failed: ${error?.message || error}`));
  }
  return true;
}
