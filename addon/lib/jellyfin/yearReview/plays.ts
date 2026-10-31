import { envInt } from '../../../utils/envNumber';
import { mapWithConcurrency } from '../../../utils/concurrency';
import { parseStremioId } from '../idsCodec';
import { videoIdAliases } from '../aliases';

const database: any = require('../../database');

export interface YearPlay {
  at: number;
  videoId: string;
  spellings: string[];
  titleKey: string;
  kind: 'movie' | 'episode';
  season: number | null;
  episode: number | null;
  origin: string | null;
  batch: boolean;
}

function zoneOffsetMs(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(at));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) - Math.floor(at / 1000) * 1000;
}

function localMidnight(year: number, timeZone: string): number {
  const wall = Date.UTC(year, 0, 1);
  let at = wall - zoneOffsetMs(timeZone, wall);
  at = wall - zoneOffsetMs(timeZone, at);
  return at;
}

export function safeTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

export function yearBounds(year: number, timeZone: string): { from: number; to: number } {
  const zone = safeTimeZone(timeZone);
  return { from: localMidnight(year, zone), to: localMidnight(year + 1, zone) };
}

const SPELLING_ORDER = ['tt', 'tmdb', 'tvdb', 'kitsu', 'mal', 'anilist', 'anidb'];

const spellingRank = (id: string): number => {
  const kind = id.startsWith('tt') ? 'tt' : id.split(':')[0];
  const at = SPELLING_ORDER.indexOf(kind);
  return at < 0 ? SPELLING_ORDER.length : at;
};

const preferred = (ids: string[]): string => [...ids].sort((a, b) => spellingRank(a) - spellingRank(b) || a.localeCompare(b))[0];

function unionFind(ids: string[]) {
  const parent = new Map<string, string>(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const groups = () => {
    const out = new Map<string, string[]>();
    for (const id of parent.keys()) {
      const root = find(id);
      const members = out.get(root);
      if (members) members.push(id);
      else out.set(root, [id]);
    }
    return [...out.values()];
  };
  return { union, find, groups };
}

function viewingsOf(times: Array<{ at: number; origin: string | null }>): Array<{ at: number; origin: string | null }> {
  const gap = envInt('JELLYFIN_REWATCH_MIN_GAP_MINUTES', 10, 0) * 60_000;
  const out: Array<{ at: number; origin: string | null }> = [];
  for (const time of [...times].sort((a, b) => a.at - b.at)) {
    const last = out[out.length - 1];
    if (last && time.at - last.at < gap) continue;
    out.push(time);
  }
  return out;
}

const spellingKind = (id: string): string => (id.startsWith('tt') ? 'tt' : id.split(':')[0]);

function pairFilmSpellings(rows: Array<{ video_id: string; watched_at: number }>, union: (a: string, b: string) => void): void {
  const batchSize = envInt('JELLYFIN_YEAR_REVIEW_BATCH_PLAYS', 6, 2);
  const byInstant = new Map<number, Set<string>>();
  for (const row of rows) byInstant.set(row.watched_at, (byInstant.get(row.watched_at) ?? new Set()).add(row.video_id));
  for (const ids of byInstant.values()) {
    if (ids.size >= batchSize) continue;
    const films = [...ids].filter((id) => {
      const parsed = parseStremioId(id);
      return parsed && (parsed.episode === null || parsed.episode === undefined);
    });
    if (films.length < 2 || films.length !== ids.size) continue;
    if (new Set(films.map(spellingKind)).size !== films.length) continue;
    for (const id of films.slice(1)) union(films[0], id);
  }
}

export async function foldPlays(rows: Array<{ video_id: string; watched_at: number; origin: string | null }>): Promise<YearPlay[]> {
  const ids = [...new Set(rows.map((row) => row.video_id))];
  const spellings = unionFind(ids);
  const aliases = await mapWithConcurrency(ids, envInt('JELLYFIN_YEAR_REVIEW_ALIAS_CONCURRENCY', 8, 1), (id) => videoIdAliases(id).catch(() => [] as string[]));
  ids.forEach((id, i) => {
    for (const alias of aliases[i]) spellings.union(id, alias);
  });
  pairFilmSpellings(rows, spellings.union);

  const bases = new Map<string, string>();
  for (const id of ids) {
    const parsed = parseStremioId(id);
    bases.set(id, parsed?.base ? String(parsed.base) : id);
  }
  const titles = unionFind([...new Set(bases.values())]);
  const groups = spellings.groups();
  for (const group of groups) {
    const groupBases = group.map((id) => bases.get(id)!);
    for (const base of groupBases.slice(1)) titles.union(groupBases[0], base);
  }
  const titleKeys = new Map<string, string>();
  for (const members of titles.groups()) {
    const key = preferred(members);
    for (const member of members) titleKeys.set(member, key);
  }

  const timesById = new Map<string, Array<{ at: number; origin: string | null }>>();
  for (const row of rows) {
    const times = timesById.get(row.video_id);
    if (times) times.push({ at: row.watched_at, origin: row.origin });
    else timesById.set(row.video_id, [{ at: row.watched_at, origin: row.origin }]);
  }

  const plays: YearPlay[] = [];
  for (const group of groups) {
    const videoId = preferred(group);
    const parsed = parseStremioId(videoId);
    const episode = parsed && parsed.episode !== null && parsed.episode !== undefined ? Number(parsed.episode) : null;
    for (const viewing of viewingsOf(group.flatMap((id) => timesById.get(id) ?? []))) {
      plays.push({
        at: viewing.at,
        videoId,
        spellings: group,
        titleKey: titleKeys.get(bases.get(videoId)!) ?? videoId,
        kind: episode === null ? 'movie' : 'episode',
        season: episode === null || parsed?.season === null || parsed?.season === undefined ? null : Number(parsed.season),
        episode,
        origin: viewing.origin,
        batch: false,
      });
    }
  }

  plays.sort((a, b) => a.at - b.at);
  const batchSize = envInt('JELLYFIN_YEAR_REVIEW_BATCH_PLAYS', 6, 2);
  const gapMs = envInt('JELLYFIN_YEAR_REVIEW_BULK_GAP_SECONDS', 60, 0) * 1000;
  let start = 0;
  for (let i = 1; i <= plays.length; i += 1) {
    if (i < plays.length && plays[i].at - plays[i - 1].at <= gapMs) continue;
    if (i - start >= batchSize) for (let j = start; j < i; j += 1) plays[j].batch = true;
    start = i;
  }
  return plays;
}

export async function yearPlays(userUUID: string, historyKey: string, year: number, timeZone: string): Promise<YearPlay[]> {
  const { from, to } = yearBounds(year, timeZone);
  return foldPlays(await database.listWatchesBetween(userUUID, historyKey, from, to));
}
