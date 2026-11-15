import { bulkTimes } from './bulkMarks';

export type PlayedKind = 'viewing' | 'mark';

interface Dated {
  lastPlayedAt: number | null;
  lastPlayedKind: PlayedKind | null;
}

/** The side whose date a title keeps: a viewing beats a mark either way round, else the later date; a held date set here only gives way to a later one. */
export function datedBy<T extends Dated>(held: T, incoming: T, heldIsLocal = false): T {
  if (!incoming.lastPlayedAt) return held;
  if (!held.lastPlayedAt) return incoming;
  const heldViewed = held.lastPlayedKind !== 'mark';
  if (!heldIsLocal && heldViewed !== (incoming.lastPlayedKind !== 'mark')) return heldViewed ? held : incoming;
  return incoming.lastPlayedAt > held.lastPlayedAt ? incoming : held;
}

/** Dates not yet called viewings or marks are told apart by the bulk mark rule, one profile at a time. */
export function sortPlayedKinds<T extends Dated & { profile: string; videoId: string; played: boolean }>(rows: T[]): void {
  const byProfile = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.lastPlayedAt) continue;
    const group = byProfile.get(row.profile);
    if (group) group.push(row);
    else byProfile.set(row.profile, [row]);
  }
  for (const group of byProfile.values()) {
    const unsorted = group.filter((row) => !row.lastPlayedKind);
    if (!unsorted.length) continue;
    const marks = bulkTimes(group.filter((row) => row.played).map((row) => ({ at: row.lastPlayedAt!, videoId: row.videoId })));
    for (const row of unsorted) row.lastPlayedKind = row.played && marks.has(row.lastPlayedAt!) ? 'mark' : 'viewing';
  }
}
