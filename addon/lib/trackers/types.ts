import type { AccountService } from '../accounts';

export interface Tracker {
  id: AccountService;
  name: string;
  color: string;
  animeOnly: boolean;
}
