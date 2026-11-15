export interface WatchDateChange {
  from: number;
  to: number;
  latest?: number | null;
  /** The history kept this viewing beside another at the new date, so a tracker keeps both plays too. */
  apart?: boolean;
}

export interface Redate {
  config: any;
  ids: Record<string, any>;
  mediaType: 'movie' | 'series';
  season: number | undefined;
  episode: number | undefined;
  change: WatchDateChange;
  within: number;
  fallback?: { ids: Record<string, any>; season: number; episode: number } | null;
}

export function nothingToMove(url: string, reason: string): void {
  const { lastTrackerCall, noteTrackerCall } = require('../../utils/trackerCalls');
  const last = lastTrackerCall();
  if (last && last.status !== 409 && (last.status < 200 || last.status >= 300)) return;
  noteTrackerCall(url, 404, reason);
}

export const SAME_PLAY_MS = 60_000;

export function playTime(value: unknown): number | null {
  const at = Date.parse(String(value ?? '').replace(' ', 'T'));
  return Number.isFinite(at) ? at : null;
}

export function nearestPlay<T>(plays: T[], at: number, dateOf: (play: T) => unknown, within: number): T | null {
  let best: T | null = null;
  let gap = Infinity;
  for (const play of plays) {
    const when = playTime(dateOf(play));
    if (when === null) continue;
    const off = Math.abs(when - at);
    if (off <= within && off < gap) {
      best = play;
      gap = off;
    }
  }
  return best;
}
