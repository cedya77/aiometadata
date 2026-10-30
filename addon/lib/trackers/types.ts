import type { AccountService } from '../accounts';
import type { MarkItem, MarkOutcome, MarkSide, MarkWrite } from './marks';

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
  marks: { from: Mark[]; to: Mark[] };
  batch?: number;
  markBatch?: Partial<Record<Mark, number>>;
  pace?: () => TrackerPace;
  readMarks?(what: Mark, side: MarkSide): Promise<MarkItem[]>;
  heldMarks?(what: Mark, side: MarkSide): Promise<Set<string>>;
  markContext?(what: Mark, side: MarkSide): Promise<unknown>;
  prepareMark?(entry: MarkItem): MarkItem;
  refuseMark?(what: Mark, entry: MarkItem, context: unknown): string | null;
  writeMarks?(what: Mark, items: MarkItem[], side: MarkSide, userUUID: string): Promise<MarkOutcome>;
  writeMark?(what: Mark, entry: MarkItem, side: MarkSide, userUUID: string): Promise<MarkWrite>;
  checkSignIn?(credential: string): Promise<void>;
}
