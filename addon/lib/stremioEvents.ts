import { LRUCache } from 'lru-cache';
import { envInt } from '../utils/envNumber';
import { parseStremioId, type Descriptor } from './jellyfin/idsCodec';
import { isAnimeId } from './jellyfin/canonicalIds';

export type PlayerAction = 'start' | 'pause' | 'stop';
export type LibraryAction = 'libraryAdd' | 'libraryRemove' | 'watched' | 'unwatched';
export type PlayerEvent = { resource: 'player'; type: 'movie' | 'series'; videoId: string; action: PlayerAction; positionMs: number; durationMs: number };
export type LibraryEvent = { resource: 'library'; type: 'movie' | 'series'; metaId: string; action: LibraryAction; videoIds: string[] };
export type StremioEvent = PlayerEvent | LibraryEvent;

const PLAYER_ACTIONS: readonly string[] = ['start', 'pause', 'stop'];
const LIBRARY_ACTIONS: readonly string[] = ['libraryAdd', 'libraryRemove', 'watched', 'unwatched'];

function millis(value: string | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function hasEpisode(id: string): boolean {
  return typeof parseStremioId(id)?.episode === 'number';
}

export function parseStremioEvent(resource: string, type: string, id: string, extra: string): StremioEvent | null {
  if (!id) return null;
  const params = new URLSearchParams(extra || '');
  const action = params.get('action') ?? '';
  const known: 'movie' | 'series' | null =
    type === 'movie' || type === 'anime.movie' ? 'movie'
    : type === 'series' || type === 'anime.series' ? 'series'
    : null;

  if (resource === 'player') {
    if (!PLAYER_ACTIONS.includes(action)) return null;
    return {
      resource, type: known ?? (hasEpisode(id) ? 'series' : 'movie'), videoId: id, action: action as PlayerAction,
      positionMs: millis(params.get('currentTime')), durationMs: millis(params.get('duration')),
    };
  }

  if (resource === 'library') {
    if (!LIBRARY_ACTIONS.includes(action)) return null;
    const videoIds = (params.get('videoId') ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    // A meta id says nothing of its kind (tmdb:603 is a film and a show), so only videos make an unknown type a series.
    const resolved = known ?? (videoIds.length ? 'series' : null);
    if (!resolved) return null;
    return { resource, type: resolved, metaId: id, action: action as LibraryAction, videoIds };
  }

  return null;
}

export function stremioEventTarget(event: StremioEvent): string {
  return event.resource === 'player' ? event.videoId : `${event.metaId}|${event.videoIds.join(',')}`;
}

export function stremioEventKey(event: StremioEvent): string {
  return event.resource === 'player' ? `${event.action}|${event.positionMs}` : event.action;
}

// Each install of one config in a Stremio profile receives every event; only a repeat of the last one is dropped.
const lastEvents = new LRUCache<string, string>({
  max: 10000,
  ttl: envInt('STREMIO_EVENT_DEDUPE_SECONDS', 60, 1) * 1000,
});

export function isRepeatEvent(scope: string, target: string, key: string): boolean {
  const slot = `${scope}|${target}`;
  const repeat = lastEvents.get(slot) === key;
  lastEvents.set(slot, key);
  return repeat;
}

/** The title an event is about, so a play and a mark of one show queue behind each other. */
export function stremioEventSlot(event: StremioEvent): string {
  const id = event.resource === 'player' ? event.videoId : event.metaId;
  return parseStremioId(id)?.base ?? id;
}

// Stremio sends without waiting, so events of one title are worked through in arrival order.
const queues = new Map<string, Promise<void>>();

export function runInOrder(slot: string, work: () => Promise<unknown>): Promise<void> {
  const next = (queues.get(slot) ?? Promise.resolve()).then(() => work()).then(() => undefined);
  const settled = next.catch(() => undefined);
  queues.set(slot, settled);
  settled.then(() => { if (queues.get(slot) === settled) queues.delete(slot); });
  return next;
}

export function titleType(id: string, type: 'movie' | 'series'): 'movie' | 'series' | 'anime' {
  return isAnimeId(id) ? 'anime' : type;
}

export function descriptorForVideo(type: 'movie' | 'series', videoId: string): Descriptor | null {
  const t = titleType(videoId, type);
  if (type === 'movie') return { k: 'movie', t, i: videoId };
  const parsed = parseStremioId(videoId);
  if (!parsed || typeof parsed.episode !== 'number') return null;
  return { k: 'episode', t, i: parsed.base, s: parsed.season, e: parsed.episode };
}

export function isPlayed(positionMs: number, durationMs: number, thresholdPercent: number): boolean {
  return durationMs > 0 && (positionMs / durationMs) * 100 >= thresholdPercent;
}
