import type { AccountService } from '../accounts';
import type { MarkItem, MarkOutcome, MarkSide, MarkWrite } from './marks';
import type { CopyItem, CopyTarget, MirrorRow, TmdbWatch, WatchOutcome } from './watches';
import type { MatchCandidate, MatchDetail } from './match';
import type { Redate } from './redate';

export type Mark = 'ratings' | 'watchlist' | 'dropped';
export const MARK_KINDS: Mark[] = ['ratings', 'watchlist', 'dropped'];

export interface TrackerPace {
  perSecond: number;
  ratingsPerHour?: number;
}

export interface Tracker {
  id: AccountService;
  name: string;
  color: string;
  animeOnly: boolean;
  datedHistory: boolean;
  marks: { from: Mark[]; to: Mark[] };
  batch?: number;
  markBatch?: Partial<Record<Mark, number>>;
  batchGapMs?: number;
  pace?: () => TrackerPace;
  readMarks?(what: Mark, side: MarkSide): Promise<MarkItem[]>;
  heldMarks?(what: Mark, side: MarkSide): Promise<Set<string>>;
  markContext?(what: Mark, side: MarkSide): Promise<unknown>;
  prepareMark?(entry: MarkItem): MarkItem;
  refuseMark?(what: Mark, entry: MarkItem, context: unknown): string | null;
  writeMarks?(what: Mark, items: MarkItem[], side: MarkSide, userUUID: string): Promise<MarkOutcome>;
  writeMark?(what: Mark, entry: MarkItem, side: MarkSide, userUUID: string): Promise<MarkWrite>;
  checkSignIn?(credential: string): Promise<void>;
  animeEntry?(media: any): Promise<{ id: number; episode: any } | null>;
  rewatch?: { separate: boolean; kept?(credential: string): Promise<boolean> };
  tmdbWatches?(rows: MirrorRow[]): TmdbWatch[];
  watchesHeld?: { read(credential: string): Promise<Set<string>>; keys(target: CopyTarget, kind: 'movie' | 'episode'): string[] };
  takesEpisodeIds?: boolean;
  writeWatches?: { url: string; write(items: CopyItem[], credential: string, config: any, rewatch?: boolean): Promise<WatchOutcome> };
  writeWatch?(item: CopyItem, credential: string, config: any): Promise<boolean>;
  redate?: { scope: 'all' | 'episodes'; run(redate: Redate): Promise<void> };
  match?: {
    search(credential: string, query: string, kind: 'movie' | 'series', config: any): Promise<MatchCandidate[]>;
    detail(credential: string, candidate: MatchCandidate, config: any): Promise<MatchDetail>;
    spellings?(ids: Record<string, string | number>, kind: 'movie' | 'series'): Promise<string[]>;
  };
}
