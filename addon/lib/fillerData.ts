import consola from 'consola';
import { httpGet } from '../utils/httpClient';
import { getSetting } from './settingsService';

const logger = consola.withTag('FillerData');

export type EpisodeKind = 'canon' | 'filler' | 'mixed' | 'anime_canon';
const KINDS: EpisodeKind[] = ['canon', 'filler', 'mixed', 'anime_canon'];

interface Snapshot {
  kinds: Map<number, Map<number, EpisodeKind>>;
  recaps: Map<number, Set<number>>;
  generated: string | null;
}

let snapshot: Snapshot | null = null;
let lastCheck = 0;
let lastRefreshAt = 0;
let lastError = '';
let refreshing: Promise<void> | null = null;

function sourceUrl(): string {
  return (getSetting('FILLER_DATA_URL') || '').trim();
}

function refreshMs(): number {
  const hours = Number(getSetting('FILLER_DATA_REFRESH_HOURS'));
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1000;
}

async function refresh(): Promise<void> {
  const response = await httpGet(sourceUrl(), { timeout: 30000, retryAttempts: 2 });
  const body = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
  const kinds = new Map<number, Map<number, EpisodeKind>>();
  const recaps = new Map<number, Set<number>>();
  for (const [id, show] of Object.entries<any>(body?.shows || {})) {
    const mal = Number(id);
    if (!Number.isInteger(mal) || mal <= 0) continue;
    const episodes = new Map<number, EpisodeKind>();
    for (const kind of KINDS) {
      for (const episode of show?.[kind] || []) episodes.set(Number(episode), kind);
    }
    kinds.set(mal, episodes);
    recaps.set(mal, new Set((show?.recap || []).map(Number)));
  }
  snapshot = { kinds, recaps, generated: typeof body?.generated === 'string' ? body.generated : null };
  lastRefreshAt = Date.now();
  logger.debug(`Loaded episode types for ${kinds.size} anime`);
}

function startRefresh(): Promise<void> {
  lastCheck = Date.now();
  refreshing = refresh()
    .then(() => { lastError = ''; })
    .catch((error: any) => {
      lastError = error?.message || String(error);
      throw error;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

function refreshInBackground(): void {
  if (refreshing || !sourceUrl() || Date.now() - lastCheck < refreshMs()) return;
  startRefresh().catch((error: any) => logger.warn(`Could not refresh the filler data: ${error?.message || error}`));
}

export async function initializeFillerData(): Promise<void> {
  if (!sourceUrl() || snapshot) return;
  await (refreshing || startRefresh());
}

export function covers(mal: number): boolean {
  refreshInBackground();
  return !!snapshot?.kinds.has(mal);
}

export function episodeKind(mal: number, episode: number): EpisodeKind | null {
  return snapshot?.kinds.get(mal)?.get(episode) ?? null;
}

export function isRecap(mal: number, episode: number): boolean {
  return !!snapshot?.recaps.get(mal)?.has(episode);
}

export function fillerDataStats(): string {
  if (!snapshot) return sourceUrl() ? 'not loaded' : 'off';
  return `${snapshot.kinds.size.toLocaleString()} anime`;
}

export function getFillerDataStats() {
  return {
    enabled: !!sourceUrl(),
    loaded: !!snapshot,
    running: !!refreshing,
    anime: snapshot?.kinds.size || 0,
    generated: snapshot?.generated || null,
    lastCheck: lastCheck || null,
    lastRefreshAt: lastRefreshAt || null,
    refreshHours: refreshMs() / 3600000,
    lastError,
  };
}

export async function forceUpdateFillerData(): Promise<{ success: boolean; count: number; message: string }> {
  if (!sourceUrl()) return { success: false, count: 0, message: 'The filler data source is turned off' };
  if (refreshing) await refreshing.catch(() => {});
  try {
    await startRefresh();
    const count = snapshot?.kinds.size || 0;
    return { success: true, count, message: `Filler data updated (${fillerDataStats()})` };
  } catch (error: any) {
    return { success: false, count: 0, message: `Failed to update the filler data: ${error?.message || error}` };
  }
}
