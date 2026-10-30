import { envInt } from '../../utils/envNumber';
import type { AccountService } from '../accounts';
import { anilist } from './anilist';
import { mal } from './mal';
import { mdblist } from './mdblist';
import { publicmetadb } from './publicmetadb';
import { simkl } from './simkl';
import type { Mark, Tracker } from './types';

export type { Mark, Tracker } from './types';
export { MARK_KINDS } from './types';

export const TRACKERS: Record<AccountService, Tracker> = { simkl, mdblist, publicmetadb, anilist, mal };
const LIST: Tracker[] = Object.values(TRACKERS);

export const trackerOf = (id: string): Tracker | undefined => (TRACKERS as Record<string, Tracker>)[id];
export const trackerName = (id: string): string => trackerOf(id)?.name ?? id;
export const isAnimeList = (id: string): boolean => trackerOf(id)?.animeOnly === true;
export const resumeTrackers = (): AccountService[] => LIST.filter((tracker) => tracker.resumeRank).sort((a, b) => a.resumeRank! - b.resumeRank!).map((tracker) => tracker.id);
export const isMatchable = (id: string): boolean => Boolean(trackerOf(id)?.match);

export function copyBatch(id: string, what: Mark | 'watches' = 'watches'): number {
  const tracker = trackerOf(id);
  return (what !== 'watches' ? tracker?.markBatch?.[what] : undefined) ?? tracker?.batch ?? envInt('JELLYFIN_COPY_BATCH_SIZE', 100, 1);
}

export function gapMs(id: string, what: Mark | 'watches' = 'watches'): number {
  const pace = trackerOf(id)?.pace?.();
  if (!pace) return 1000;
  return what === 'ratings' && pace.ratingsPerHour ? Math.ceil(3_600_000 / pace.ratingsPerHour) : Math.ceil(1000 / pace.perSecond);
}

export function trackerFacts() {
  return LIST.map((tracker) => ({
    id: tracker.id,
    name: tracker.name,
    color: tracker.color,
    animeOnly: tracker.animeOnly,
    datedHistory: tracker.datedHistory,
    matchable: Boolean(tracker.match),
    wholeRatings: tracker.wholeRatings,
    redates: tracker.redate?.scope ?? null,
    marks: tracker.marks,
    pace: tracker.pace?.() ?? null,
    notes: tracker.notes,
  }));
}
