import { listProfiles, type Profile } from './profiles';
import { encodeJellyfinId, normaliseJellyfinId, parseStremioId } from './ids';
import { groupBySpelling } from './aliases';
import { createHash } from 'crypto';

const ANIME_IDS = /^(kitsu|mal|anilist|anidb):/;
// The tracker an imported row came from, by the origin it was written with.
const TRACKER_NAMES: Record<string, string> = { mdblist: 'MDBList', simkl: 'Simkl', publicmetadb: 'PublicMetaDB', anilist: 'AniList', mal: 'MyAnimeList' };

export interface HistoryUser {
  profile: Profile;
  /** The play state this user reads and writes: the main user's for one that shares it. */
  key: string;
  owns: boolean;
}

/** Who the caller may read: a profile only itself, the main user everyone. */
export function historyUsers(config: any, userUUID: string, callerProfileId: string | null): HistoryUser[] {
  const users = listProfiles(config, userUUID).map((profile) => {
    const key = profile.id && !profile.sharesHistory ? profile.id : '';
    return { profile, key, owns: key === (profile.id ?? '') };
  });
  return callerProfileId ? users.filter((user) => user.profile.id === callerProfileId) : users;
}

export function userByKey(users: HistoryUser[]): Map<string, HistoryUser> {
  return new Map(users.filter((user) => user.owns).map((user) => [user.key, user]));
}

export function findUser(users: HistoryUser[], userId: unknown): HistoryUser | undefined {
  const wanted = normaliseJellyfinId(String(userId ?? ''));
  return wanted ? users.find((user) => user.profile.userId === wanted) : undefined;
}

export function itemIdForVideo(videoId: string): string {
  const parsed = parseStremioId(videoId);
  if (parsed && parsed.episode !== null && parsed.episode !== undefined) {
    return encodeJellyfinId({ k: 'episode', t: ANIME_IDS.test(videoId) ? 'anime' : 'series', i: parsed.base, s: parsed.season, e: parsed.episode });
  }
  return encodeJellyfinId({ k: 'movie', t: 'movie', i: videoId });
}

export function isEpisodeVideo(videoId: string): boolean {
  const parsed = parseStremioId(videoId);
  return Boolean(parsed && parsed.episode !== null && parsed.episode !== undefined);
}

// A play is written under each of a title's ids, so one entry carries them all, joined by this.
const KEY_JOIN = '|';

export function videoIdsOf(itemKey: string): string[] {
  return itemKey.split(KEY_JOIN).filter(Boolean);
}

/** The id a group is shown and opened by: IMDb's, then TMDB's, then whichever comes first. */
function preferredId(ids: string[]): string {
  return ids.find((id) => id.startsWith('tt')) ?? ids.find((id) => id.startsWith('tmdb:')) ?? ids[0];
}

export interface HistoryEntry {
  profile: string;
  itemKey: string;
  videoId: string;
  played: boolean;
  playCount: number;
  positionMs: number;
  durationMs: number;
  lastPlayedAt: number | null;
  sortAt: number;
  origin: 'local' | 'import';
  tracker: string | null;
}

function entryOf(group: any[]): HistoryEntry {
  const ids = [...new Set(group.map((row) => String(row.video_id)))];
  const newest = group.reduce((a, b) => ((Number(b.sort_at) || 0) > (Number(a.sort_at) || 0) ? b : a));
  const played = group.some((row) => Number(row.played) === 1);
  const origins = group.map(originOf);
  const local = origins.some((o) => o.origin === 'local');
  return {
    profile: String(newest.profile ?? ''),
    itemKey: ids.join(KEY_JOIN),
    videoId: preferredId(ids),
    played,
    playCount: Math.max(0, ...group.map((row) => Number(row.play_count) || 0)),
    positionMs: played ? 0 : Math.max(0, ...group.map((row) => Number(row.position_ms) || 0)),
    durationMs: Math.max(0, ...group.map((row) => Number(row.runtime_ms) || 0)),
    lastPlayedAt: Math.max(0, ...group.map((row) => Number(row.last_played_at) || 0)) || null,
    sortAt: Number(newest.sort_at) || 0,
    origin: local ? 'local' : 'import',
    tracker: local ? null : (origins.find((o) => o.tracker)?.tracker ?? null),
  };
}

export interface HistoryCursor {
  sortAt: number;
  profile: string;
  videoId: string;
  /** Titles the pages before already listed near the cut, which this one leaves out. */
  seen: string[];
}

// Spellings of one play written moments apart can fall either side of a page's cut.
const SEEN_WINDOW_MS = 60 * 60 * 1000;
const SEEN_MAX = 100;

function merged(into: HistoryEntry, entry: HistoryEntry): void {
  into.itemKey = [...new Set([...videoIdsOf(into.itemKey), ...videoIdsOf(entry.itemKey)])].join(KEY_JOIN);
  into.played ||= entry.played;
  into.playCount = Math.max(into.playCount, entry.playCount);
  if (into.played) into.positionMs = 0;
  into.durationMs = Math.max(into.durationMs, entry.durationMs);
  into.lastPlayedAt = Math.max(into.lastPlayedAt ?? 0, entry.lastPlayedAt ?? 0) || null;
  if (entry.origin === 'local') {
    into.origin = 'local';
    into.tracker = null;
  }
}

/**
 * A page of history, each title once. Spellings of a title are folded by their
 * aliases, then by the item they open, which is the same whatever the spelling.
 * A page ends between two play times, never inside one, as one play's spellings share it.
 */
export async function historyPage(
  read: (limit: number, after?: HistoryCursor) => Promise<any[]>,
  resolve: (entries: HistoryEntry[]) => Promise<Array<any | null>>,
  limit: number,
  after?: HistoryCursor
): Promise<{ entries: Array<HistoryEntry & { item: any | null }>; cursor: string | null }> {
  const asked = limit * 3 + 1;
  const raw = await read(asked, after);
  const exhausted = raw.length < asked;
  let kept = raw;
  if (!exhausted) {
    const lastAt = Number(raw[raw.length - 1].sort_at) || 0;
    const cut = raw.findIndex((row) => (Number(row.sort_at) || 0) === lastAt);
    if (cut > 0) kept = raw.slice(0, cut);
  }
  const byProfile = new Map<string, any[]>();
  for (const row of kept) {
    const key = String(row.profile ?? '');
    if (!byProfile.has(key)) byProfile.set(key, []);
    byProfile.get(key)!.push(row);
  }
  const groups = (await Promise.all([...byProfile.values()].map((rows) => groupBySpelling(rows)))).flat();
  const indexOf = new Map(kept.map((row, i) => [row, i]));
  const firstIndex = new Map(groups.map((group) => [group, Math.min(...group.map((row) => indexOf.get(row)!))]));
  const lastIndex = new Map(groups.map((group) => [group, Math.max(...group.map((row) => indexOf.get(row)!))]));
  groups.sort((a, b) => firstIndex.get(a)! - firstIndex.get(b)!);

  let end = kept.length;
  if (groups.length > limit) {
    // Past every row of the titles taken, and on to the end of that play time.
    const runEnd = (i: number) => {
      const at = Number(kept[i].sort_at) || 0;
      let next = i + 1;
      while (next < kept.length && (Number(kept[next].sort_at) || 0) === at) next++;
      return next;
    };
    end = firstIndex.get(groups[limit])!;
    for (;;) {
      const taken = groups.filter((group) => firstIndex.get(group)! < end);
      const next = runEnd(Math.max(end - 1, ...taken.map((group) => lastIndex.get(group)!)));
      if (next <= end) break;
      end = next;
    }
  }
  const candidates = groups.filter((group) => firstIndex.get(group)! < end).map(entryOf);
  const items = await resolve(candidates);
  const skipped = new Set(after?.seen ?? []);
  const byItem = new Map<string, HistoryEntry & { item: any | null }>();
  for (const [i, entry] of candidates.entries()) {
    const item = items[i] ?? null;
    const key = createHash('sha1').update(item?.Id ? `${entry.profile}|${normaliseJellyfinId(String(item.Id))}` : `${entry.profile}|${entry.itemKey}`).digest('base64url').slice(0, 12);
    if (skipped.has(key)) continue;
    const held = byItem.get(key);
    if (held) merged(held, entry);
    else byItem.set(key, { ...entry, item });
  }

  const last = end > 0 ? kept[end - 1] : null;
  const more = !(exhausted && end === kept.length && kept.length === raw.length);
  if (!more || !last) return { entries: [...byItem.values()], cursor: null };
  const cutAt = Number(last.sort_at) || 0;
  const recent = [...byItem.entries()].filter(([, entry]) => entry.sortAt <= cutAt + SEEN_WINDOW_MS).map(([key]) => key);
  const seen = [...new Set([...(after?.seen ?? []), ...recent])].slice(-SEEN_MAX);
  const cursor: HistoryCursor = { sortAt: cutAt, profile: String(last.profile ?? ''), videoId: String(last.video_id), seen };
  return { entries: [...byItem.values()], cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url') };
}

export function decodeCursor(raw: unknown): HistoryCursor | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed?.sortAt === 'number' && typeof parsed.profile === 'string' && typeof parsed.videoId === 'string') {
      return { sortAt: parsed.sortAt, profile: parsed.profile, videoId: parsed.videoId, seen: Array.isArray(parsed.seen) ? parsed.seen.filter((key: unknown) => typeof key === 'string').slice(-SEEN_MAX) : [] };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** A row's origin as the app reads it: a play here, or one read from a tracker it names. */
export function originOf(row: any): { origin: 'local' | 'import'; tracker: string | null } {
  const origin = row.origin == null ? null : String(row.origin);
  if (origin && origin !== 'server' && origin !== 'play') {
    return { origin: 'import', tracker: TRACKER_NAMES[origin] ?? origin };
  }
  const lastPlayed = row.last_played_at == null ? null : Number(row.last_played_at);
  const written = Number(row.updated_at) || 0;
  const imported = origin !== 'server' && (lastPlayed === null || Math.abs(written - lastPlayed) >= 2000);
  return imported ? { origin: 'import', tracker: null } : { origin: 'local', tracker: null };
}

export function exportRow(row: any): any {
  const iso = (ms: unknown) => (ms ? new Date(Number(ms)).toISOString() : null);
  return {
    profile: String(row.profile ?? ''),
    itemKey: String(row.video_id),
    kind: isEpisodeVideo(String(row.video_id)) ? 'episode' : 'movie',
    videoId: String(row.video_id),
    played: Boolean(Number(row.played)),
    playCount: Number(row.play_count) || 0,
    positionMs: Number(row.position_ms) || 0,
    durationMs: Number(row.runtime_ms) || 0,
    lastPlayedAt: iso(row.last_played_at),
    updatedAt: iso(row.updated_at),
    origin: originOf(row).origin,
  };
}
