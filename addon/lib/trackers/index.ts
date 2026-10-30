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

export const trackerOf = (id: string): Tracker | undefined => (TRACKERS as Record<string, Tracker>)[id];
export const trackerName = (id: string): string => trackerOf(id)?.name ?? id;
export const isAnimeList = (id: string): boolean => trackerOf(id)?.animeOnly === true;

export function copyBatch(id: string, what: Mark | 'watches' = 'watches'): number {
  const tracker = trackerOf(id);
  return (what !== 'watches' ? tracker?.markBatch?.[what] : undefined) ?? tracker?.batch ?? envInt('JELLYFIN_COPY_BATCH_SIZE', 100, 1);
}

export function gapMs(id: string, what: Mark | 'watches' = 'watches'): number {
  const pace = trackerOf(id)?.pace?.();
  if (!pace) return 1000;
  return what === 'ratings' && pace.ratingsPerHour ? Math.ceil(3_600_000 / pace.ratingsPerHour) : Math.ceil(1000 / pace.perSecond);
}
