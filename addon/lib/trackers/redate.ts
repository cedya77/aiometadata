export interface WatchDateChange {
  from: number;
  to: number;
  latest?: number | null;
}

export interface Redate {
  config: any;
  ids: Record<string, any>;
  mediaType: 'movie' | 'series';
  season: number | undefined;
  episode: number | undefined;
  change: WatchDateChange;
  within: number;
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
