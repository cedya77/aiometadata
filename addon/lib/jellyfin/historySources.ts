import { createHash } from 'crypto';
import { inflateRawSync } from 'zlib';
import consola from 'consola';
import { envInt } from '../../utils/envNumber';
import { kitsuForTmdb, videoIdAliases } from './aliases';

const idMapper: any = require('../id-mapper');

const logger = consola.withTag('Jellyfin');

export type SourceFiles = Map<string, string>;
export type Upload = { fileName: string | null; files: SourceFiles; json: unknown };
export type Unmatched = { name: string; reason: string };
export type Choice = { tmdb: number; title: string; originalTitle: string | null; year: number | null; poster: string | null; overview: string };
export type Ambiguous = { key: string; name: string; options: Choice[]; picked: number | null };
export type SourceRead = { body: any; unmatched: Unmatched[]; unmatchedCount: number; ambiguous?: Ambiguous[] };
export type Progress = { done: number; total: number };
export type SourceProgress = { matching: Progress & { label: string } };

export interface HistorySource {
  id: string;
  about: string;
  importName?: string;
  sameViewingMs(): number;
  // How close a title's state here must be to count as the same viewing and stay as it is; sameViewingMs when absent.
  sameStateMs?(): number;
  detects(upload: Upload): boolean;
  read(upload: Upload, context: { userUUID: string; config: any; picks: Record<string, number> }): Promise<SourceRead | SourceProgress | string>;
}

const MAX_ENTRIES = 5000;
const MAX_UNMATCHED_LISTED = 200;

function isZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50;
}

// Editors on Windows often start a UTF-8 file with a byte order mark, which JSON.parse refuses.
const withoutBom = (text: string) => text.replace(/^\ufeff/, '');

function unzipTextFiles(buffer: Buffer): SourceFiles | string {
  const budget = envInt('JELLYFIN_HISTORY_IMPORT_MAX_UNZIPPED_MB', 256, 1) * 1048576;
  const unreadable = 'This zip file could not be read';
  const tooLarge = 'This zip file is larger than the import limit once unpacked';
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 65557); at--) {
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) return unreadable;
  const count = buffer.readUInt16LE(end + 10);
  if (count > MAX_ENTRIES) return 'This zip file holds too many files';
  let at = buffer.readUInt32LE(end + 16);
  const found: Array<[string, string]> = [];
  let used = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) return unreadable;
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const packed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength).replace(/\\/g, '/');
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
    if (name.endsWith('/') || !/\.(json|csv)$/i.test(name)) continue;
    if (flags & 1) return 'This zip file is encrypted';
    if (packed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) return 'This zip file is too large to read';
    if (method !== 0 && method !== 8) return 'This zip file uses a compression this server cannot read';
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) return unreadable;
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + packed > buffer.length) return unreadable;
    if (used + size > budget) return tooLarge;
    const data = buffer.subarray(start, start + packed);
    let text: Buffer;
    try {
      text = method === 0 ? data : inflateRawSync(data, { maxOutputLength: Math.max(1, budget - used) });
    } catch (error: any) {
      return error?.code === 'ERR_BUFFER_TOO_LARGE' ? tooLarge : unreadable;
    }
    used += text.length;
    if (used > budget) return tooLarge;
    found.push([name, withoutBom(text.toString('utf8'))]);
  }
  const tops = new Set(found.map(([name]) => (name.includes('/') ? name.split('/')[0] : '')));
  const shared = tops.size === 1 && !tops.has('') ? `${[...tops][0]}/` : '';
  return new Map(found.map(([name, text]) => [name.slice(shared.length), text]));
}

export function openUpload(buffer: Buffer, fileName: string | null): Upload | string {
  if (isZip(buffer)) {
    const files = unzipTextFiles(buffer);
    if (typeof files === 'string') return files;
    const json = [...files.entries()].filter(([name]) => name.toLowerCase().endsWith('.json'));
    let parsed: unknown;
    if (json.length === 1) {
      try {
        parsed = JSON.parse(json[0][1]);
      } catch {
        parsed = undefined;
      }
    }
    return { fileName, files, json: parsed };
  }
  const text = withoutBom(buffer.toString('utf8'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const base = fileName ? fileName.split(/[\\/]/).pop()!.toLowerCase() : parsed === undefined ? 'upload.csv' : 'upload.json';
  return { fileName, files: new Map([[base, text]]), json: parsed };
}

export function parseCsv(text: string): Array<Record<string, string>> {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  const names = header.map((name) => name.trim());
  return body
    .filter((cells) => cells.some((cell) => cell !== ''))
    .map((cells) => {
      const out: Record<string, string> = Object.create(null);
      names.forEach((name, i) => {
        out[name] = (cells[i] ?? '').trim();
      });
      return out;
    });
}

export const positive = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export const seasonNumber = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n < 10000 ? n : null;
};

export const imdbOf = (value: unknown): string | null => (typeof value === 'string' && /^tt\d{1,10}$/.test(value) ? value : null);

export const unique = (ids: Array<string | null | undefined | false | 0>): string[] => [...new Set(ids.filter((id): id is string => Boolean(id)))];

export const isoAt = (at: number | null | undefined): string | null => (at && at > 0 ? new Date(at).toISOString() : null);

export type TitleIds = { imdb?: unknown; tmdb?: unknown; tvdb?: unknown };

export async function filmSpellings(ids: TitleIds | null | undefined): Promise<string[]> {
  const tmdb = positive(ids?.tmdb);
  const own = unique([imdbOf(ids?.imdb), tmdb && `tmdb:${tmdb}`]);
  if (!own.length) return [];
  return unique([...own, ...(await videoIdAliases(own[0]).catch(() => [] as string[]))]);
}

function showIds(ids: TitleIds | null | undefined): { tmdb: number | null; imdb: string | null; tvdb: number | null; anime: boolean } {
  const tmdb = positive(ids?.tmdb);
  const imdb = imdbOf(ids?.imdb);
  const tvdb = positive(ids?.tvdb);
  const anime = tmdb
    ? idMapper.getSeriesMappingsByTmdbId(tmdb).length > 0
    : Boolean((imdb && idMapper.getMappingByImdbId(imdb)) || (tvdb && idMapper.getMappingByTvdbId(tvdb)));
  return { tmdb, imdb, tvdb, anime };
}

export function showSpellings(ids: TitleIds | null | undefined): string[] {
  const show = showIds(ids);
  return unique([show.imdb, show.tvdb && `tvdb:${show.tvdb}`, show.tmdb && `tmdb:${show.tmdb}`]);
}

export function tmdbSeasonSpellings(ids: TitleIds | null | undefined, season: number): string[] {
  const show = showIds(ids);
  const tmdb = show.tmdb ? `tmdb:${show.tmdb}:${season}` : null;
  if (show.anime) return unique([tmdb]);
  return unique([tmdb, show.imdb && `${show.imdb}:${season}`, show.tvdb && `tvdb:${show.tvdb}:${season}`]);
}

export type EpisodeAt = { season: number; episode: number };

export async function tmdbEpisodeSpellings(ids: TitleIds | null | undefined, season: number, episode: number, onTvdb: EpisodeAt | null = null): Promise<string[]> {
  const show = showIds(ids);
  const primary = show.tmdb ? `tmdb:${show.tmdb}:${season}:${episode}` : null;
  const tvdbNumbered = onTvdb && show.tvdb ? [`tvdb:${show.tvdb}:${onTvdb.season}:${onTvdb.episode}`, show.imdb && `${show.imdb}:${onTvdb.season}:${onTvdb.episode}`] : null;
  if (!show.anime && tvdbNumbered) return unique([primary, ...tvdbNumbered]);
  if (show.anime) {
    const kitsu = show.tmdb ? await kitsuForTmdb(show.tmdb, season, episode).catch(() => null) : null;
    const anime = kitsu ? `kitsu:${kitsu.kitsuId}:${kitsu.episodeNumber}` : null;
    const found = anime
      ? [anime, ...(await videoIdAliases(anime).catch(() => [] as string[])).filter((id) => !id.startsWith('tmdb:'))]
      : primary ? await videoIdAliases(primary).catch(() => [] as string[]) : [];
    return unique([primary, ...found, ...(tvdbNumbered && !found.some((id) => id.startsWith('tvdb:')) ? tvdbNumbered : [])]);
  }
  const aliases = primary ? await videoIdAliases(primary).catch(() => [] as string[]) : [];
  return unique([primary, ...aliases, show.imdb && `${show.imdb}:${season}:${episode}`, show.tvdb && `tvdb:${show.tvdb}:${season}:${episode}`]);
}

type LookupJob = { signature: string; done: number; total: number; failed: number; stopped: boolean; result: Promise<Map<string, unknown>>; idle?: NodeJS.Timeout };

const lookupJobs = new Map<string, LookupJob>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function startLookups<T>(jobKey: string, signature: string, items: Map<string, T>, lookup: (item: T) => Promise<unknown>): LookupJob {
  const keys = [...items.keys()];
  const job: LookupJob = { signature, done: 0, total: keys.length, failed: 0, stopped: false, result: Promise.resolve(new Map()) };
  job.result = (async () => {
    const out = new Map<string, unknown>();
    let next = 0;
    const worker = async () => {
      while (!job.stopped && next < keys.length) {
        const key = keys[next++];
        try {
          out.set(key, await lookup(items.get(key)!));
        } catch (error: any) {
          job.failed += 1;
          logger.debug(`History import lookup failed for ${key}: ${error?.message || error}`);
        }
        job.done += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(keys.length, envInt('JELLYFIN_HISTORY_IMPORT_LOOKUP_CONCURRENCY', 4, 1)) }, worker));
    if (job.failed) logger.warn(`History import ${jobKey.split('\u0000')[0]}: ${job.failed} of ${keys.length} lookup(s) failed`);
    job.idle = setTimeout(() => {
      if (lookupJobs.get(jobKey) === job) lookupJobs.delete(jobKey);
    }, envInt('JELLYFIN_HISTORY_IMPORT_LOOKUP_KEEP_SECONDS', 600, 10) * 1000);
    job.idle.unref?.();
    return out;
  })();
  lookupJobs.set(jobKey, job);
  return job;
}

export async function lookupAll<T, V>(scope: string, userUUID: string, items: Map<string, T>, lookup: (item: T) => Promise<V>): Promise<{ values: Map<string, V> } | Progress> {
  const jobKey = `${scope}\u0000${userUUID}`;
  const signature = createHash('sha1').update([...items.keys()].sort().join('\n')).digest('hex');
  let job = lookupJobs.get(jobKey);
  if (job && job.signature !== signature) {
    job.stopped = true;
    if (job.idle) clearTimeout(job.idle);
    job = undefined;
  }
  if (!job) job = startLookups(jobKey, signature, items, lookup);
  const values = await Promise.race([job.result, sleep(envInt('JELLYFIN_HISTORY_IMPORT_LOOKUP_WAIT_SECONDS', 8, 1) * 1000).then(() => null)]);
  // A job a newer upload stopped holds only part of the titles, which are not to be read as all of them.
  return values && !job.stopped ? { values: values as Map<string, V> } : { done: job.done, total: job.total };
}

export type RuntimeAsk = { kind: 'movie' | 'episode'; metaId: string; videoId: string };

export function runtimeAskOf(ids: TitleIds | null | undefined, season: number | null = null, episode: number | null = null): RuntimeAsk | null {
  const imdb = imdbOf(ids?.imdb);
  const tmdb = positive(ids?.tmdb) && `tmdb:${positive(ids?.tmdb)}`;
  const tvdb = positive(ids?.tvdb) && `tvdb:${positive(ids?.tvdb)}`;
  if (season === null || !episode) {
    const metaId = imdb || tmdb;
    return metaId ? { kind: 'movie', metaId, videoId: metaId } : null;
  }
  const metaId = tmdb || imdb || tvdb;
  return metaId ? { kind: 'episode', metaId, videoId: `${metaId}:${season}:${episode}` } : null;
}

const runtimeKey = (ask: RuntimeAsk) => `${ask.kind}\u0000${ask.videoId}`;

export async function runtimesFor(scope: string, userUUID: string, asks: Array<RuntimeAsk | null>): Promise<{ runtimeOf: (ask: RuntimeAsk | null) => number } | Progress> {
  const { runtimeFromMeta } = require('./playstateSync');
  const wanted = new Map<string, RuntimeAsk>();
  for (const ask of asks) if (ask) wanted.set(runtimeKey(ask), ask);
  const looked = await lookupAll(scope, userUUID, wanted, (ask): Promise<number> => runtimeFromMeta(userUUID, ask));
  if (!('values' in looked)) return looked;
  return { runtimeOf: (ask) => (ask ? looked.values.get(runtimeKey(ask)) ?? 0 : 0) };
}

export function unmatchedList(): { miss: (name: string, reason: string) => void; done: () => Pick<SourceRead, 'unmatched' | 'unmatchedCount'> } {
  const unmatched: Unmatched[] = [];
  let unmatchedCount = 0;
  return {
    miss: (name, reason) => {
      unmatchedCount += 1;
      if (unmatched.length < MAX_UNMATCHED_LISTED) unmatched.push({ name: name.slice(0, 160), reason });
    },
    done: () => ({ unmatched, unmatchedCount }),
  };
}

type Viewed = { spellings: string[]; at: number | null; asOf?: number | null };
type Marked = { spellings: string[]; at: number | null; asOf?: number | null };
type Resume = { positionMs: number; runtimeMs: number };
type Resumed = Marked & Resume;
type Rated = Marked & { rating: number; metaType: 'movie' | 'series' };
type Listed = Marked & { mediaType: 'movie' | 'series' | 'anime'; metaType: 'movie' | 'series' };

export type Found = { spellings: string[]; kind: 'movie' | 'series'; mediaType?: 'movie' | 'series' | 'anime' };

export type SectionRule<R> = {
  into: 'viewings' | 'marked' | 'ratings' | 'watchlist' | 'dropped' | 'progress';
  rows: R[];
  at: (row: R) => number | null;
  keep?: (row: R) => boolean;
  rating?: (row: R) => number | null;
  progress?: (row: R) => Resume | null;
  // The state's own date when it is not a play: it moves updatedAt but not lastPlayedAt.
  asOf?: (row: R) => number | null;
};

export async function historyFromSections<R>(origin: string, profileName: string, sameViewingMs: number, find: (row: R) => Promise<Found | null>, rules: SectionRule<R>[], profileKey = ''): Promise<any> {
  const rows = { viewings: [] as Viewed[], marked: [] as Marked[], progress: [] as Resumed[], ratings: [] as Rated[], watchlist: [] as Listed[], dropped: [] as Marked[] };
  for (const rule of rules) {
    for (const row of rule.rows) {
      if (rule.keep && !rule.keep(row)) continue;
      const rating = rule.into === 'ratings' ? rule.rating?.(row) ?? null : null;
      if (rule.into === 'ratings' && rating === null) continue;
      const resume = rule.into === 'progress' ? rule.progress?.(row) ?? null : null;
      if (rule.into === 'progress' && !resume) continue;
      const found = await find(row);
      if (!found?.spellings.length) continue;
      const base = { spellings: found.spellings, at: rule.at(row), asOf: rule.asOf?.(row) ?? null };
      if (rule.into === 'ratings') rows.ratings.push({ ...base, rating: rating!, metaType: found.kind });
      else if (rule.into === 'watchlist') rows.watchlist.push({ ...base, mediaType: found.mediaType ?? found.kind, metaType: found.kind });
      else if (rule.into === 'progress') rows.progress.push({ ...base, ...resume! });
      else rows[rule.into].push(base);
    }
  }
  return historyBody(origin, profileName, sameViewingMs, rows, profileKey);
}

const BODY_SECTIONS = ['playstate', 'watches', 'ratings', 'watchlist', 'dropped', 'matches'] as const;

export function combineHistoryBodies(bodies: any[]): any {
  const out: any = { format: 'aiometadata-history', version: 1, profiles: [] };
  for (const section of BODY_SECTIONS) out[section] = [];
  for (const body of bodies) {
    out.profiles = out.profiles.concat(body.profiles);
    for (const section of BODY_SECTIONS) out[section] = out[section].concat(body[section]);
  }
  return out;
}

type HeldTitle = { spellings: string[]; dated: number[]; undated: number; marked: number | null; played: boolean; asOf: number; resume: (Resume & { at: number }) | null };

function historyBody(
  origin: string,
  profileName: string,
  sameViewingMs: number,
  rows: { viewings: Viewed[]; marked?: Marked[]; progress?: Resumed[]; ratings?: Rated[]; watchlist?: Listed[]; dropped?: Marked[] },
  profile = '',
): any {
  const titles = new Map<string, HeldTitle>();
  const note = (spellings: string[], asOf: number | null | undefined) => {
    const held = titles.get(spellings[0]) ?? { spellings, dated: [], undated: 0, marked: null, played: false, asOf: 0, resume: null };
    if (asOf && asOf > held.asOf) held.asOf = asOf;
    titles.set(spellings[0], held);
    return held;
  };
  for (const { spellings, at, asOf } of rows.viewings) {
    if (!spellings.length) continue;
    const held = note(spellings, asOf);
    held.played = true;
    if (at) held.dated.push(at);
    else held.undated += 1;
  }
  for (const { spellings, at, asOf } of rows.marked ?? []) {
    if (!spellings.length) continue;
    const held = note(spellings, asOf);
    held.played = true;
    if (at && at > (held.marked ?? 0)) held.marked = at;
  }
  for (const { spellings, at, asOf, positionMs, runtimeMs } of rows.progress ?? []) {
    if (!spellings.length) continue;
    const held = note(spellings, asOf);
    if (!held.resume || (at ?? 0) >= held.resume.at) held.resume = { positionMs, runtimeMs, at: at ?? 0 };
  }
  const playstate: any[] = [];
  const watches: any[] = [];
  for (const [title, { spellings, dated, undated, marked, played, asOf, resume: paused }] of titles) {
    const viewings: number[] = [];
    for (const at of dated.sort((a, b) => a - b)) {
      const prior = viewings[viewings.length - 1];
      if (prior === undefined || at - prior > sameViewingMs) viewings.push(at);
      // A source whose rows are each a viewing passes no window; two at one moment are two plays, a millisecond apart.
      else if (sameViewingMs === 0) viewings.push(prior + 1);
    }
    const count = viewings.length + undated;
    const last = viewings.length ? viewings[viewings.length - 1] : null;
    // A position paused before the title was last finished is one the viewer has gone past.
    const finished = Math.max(last ?? 0, marked ?? 0);
    const resume = paused && paused.at && finished > paused.at ? null : paused;
    const lastPlayed = Math.max(last ?? marked ?? 0, resume?.at ?? 0) || null;
    for (const at of viewings) for (const videoId of spellings) watches.push({ profile, videoId, title, watchedAt: isoAt(at), origin });
    for (const videoId of spellings) {
      playstate.push({
        profile, videoId, title, positionMs: resume?.positionMs ?? 0, runtimeMs: resume?.runtimeMs ?? 0, played, playCount: played ? Math.max(1, count) : 0,
        lastPlayedAt: isoAt(lastPlayed), updatedAt: isoAt(Math.max(last ?? 0, marked ?? 0, resume?.at ?? 0, asOf) || 1), origin,
      });
    }
  }
  const mark = ({ spellings, at }: Marked) => ({ profile, metaId: spellings[0], also: spellings.slice(1), updatedAt: isoAt(at ?? 1) });
  return {
    format: 'aiometadata-history',
    version: 1,
    profiles: [{ key: profile, name: profileName }],
    playstate,
    watches,
    ratings: (rows.ratings ?? []).filter((row) => row.spellings.length).map((row) => ({ ...mark(row), rating: row.rating, metaType: row.metaType })),
    watchlist: (rows.watchlist ?? []).filter((row) => row.spellings.length).map((row) => ({ ...mark(row), mediaType: row.mediaType, metaType: row.metaType, listed: true })),
    dropped: (rows.dropped ?? []).filter((row) => row.spellings.length).map(mark),
    matches: [],
  };
}
