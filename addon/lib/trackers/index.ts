import type { AccountService } from '../accounts';
import { anilist } from './anilist';
import { mal } from './mal';
import { mdblist } from './mdblist';
import { publicmetadb } from './publicmetadb';
import { simkl } from './simkl';
import type { Tracker } from './types';

export type { Tracker } from './types';

export const TRACKERS: Record<AccountService, Tracker> = { simkl, mdblist, publicmetadb, anilist, mal };

export const trackerOf = (id: string): Tracker | undefined => (TRACKERS as Record<string, Tracker>)[id];
export const trackerName = (id: string): string => trackerOf(id)?.name ?? id;
export const isAnimeList = (id: string): boolean => trackerOf(id)?.animeOnly === true;
