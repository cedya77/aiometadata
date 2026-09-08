// @ts-ignore
import { getSetting } from '../lib/settingsService';

/**
 * AniList stopped answering requests that carry no account token. Turning
 * ANILIST_REQUIRES_AUTH off restores the behaviour from before that, and is the
 * only switch needed: it gates the three artwork cache guards in lib/anilist.ts,
 * error caching on the trending catalog, and the connect notices in the UI.
 */
export function anilistRequiresAuth(): boolean {
  return String(getSetting('ANILIST_REQUIRES_AUTH') ?? '').toLowerCase() !== 'false';
}
