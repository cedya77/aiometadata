import { envInt } from '../../utils/envNumber';
import { comparable } from '../../utils/titleMatch';
import {
  filmSpellings,
  historyFromSections,
  imdbOf,
  lookupAll,
  parseCsv,
  positive,
  runtimeAskOf,
  runtimesFor,
  seasonNumber,
  showSpellings,
  tmdbEpisodeSpellings,
  tmdbSeasonSpellings,
  unmatchedList,
  type Found,
  type HistorySource,
  type TitleIds,
  type Upload,
} from './historySources';
import { settleTitles, titleIdsFor, titleKey, type NamedTitle } from './historyTitles';

const idMapper: any = require('../id-mapper');
const idMappings: any = require('../id-mappings');

type Kind = 'movie' | 'show' | 'season' | 'episode';
type Row = Record<string, unknown>;

const KINDS: Record<string, Kind> = { movie: 'movie', film: 'movie', show: 'show', series: 'show', tv: 'show', season: 'season', episode: 'episode' };
const ID_FIELDS = ['imdb_id', 'tmdb_id', 'tvdb_id'];
const UNKNOWN = 'unknown';

const kindOf = (row: Row): Kind | null => (typeof row.type === 'string' ? KINDS[row.type.trim().toLowerCase()] ?? null : null);

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '');

const describes = (row: unknown): row is Row =>
  Boolean(row) && typeof row === 'object' && !Array.isArray(row) && kindOf(row as Row) !== null && [...ID_FIELDS, 'title'].some((field) => text((row as Row)[field]));

function rowsOf(upload: Upload): Row[] | null {
  if (Array.isArray(upload.json)) return upload.json.some(describes) ? upload.json : null;
  if (upload.json !== undefined || upload.files.size !== 1) return null;
  const [[name, body]] = [...upload.files];
  if (!name.endsWith('.csv')) return null;
  const header = body.slice(0, 1000).replace(/^﻿/, '').split(/\r?\n/)[0]?.split(',').map((cell) => cell.trim().replace(/^"|"$/g, '').toLowerCase()) ?? [];
  if (!header.includes('type') || ![...ID_FIELDS, 'title'].some((field) => header.includes(field))) return null;
  return parseCsv(body).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])));
}

const seasonOf = (row: Row): number | null => (text(row.season) ? seasonNumber(text(row.season)) : null);

const ISO = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/i;

// ISO 8601 only, as the guide says: anything else, like 01/05/2024, reads differently by locale and server.
// A time with no zone is UTC, so the server's own zone never moves it.
const dateAt = (value: string): number | null => {
  const iso = ISO.exec(value);
  if (!iso) return null;
  const [, day, time, zone] = iso;
  const offset = zone && zone.toUpperCase() !== 'Z' ? `${zone.slice(0, 3)}:${zone.slice(-2)}` : 'Z';
  const parsed = Date.parse(time ? `${day}T${time}${offset}` : `${day}T12:00:00Z`);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

type When = { at: number | null } | 'absent' | 'invalid';

function whenOf(row: Row, field: string): When {
  const value = text(row[field]);
  if (!value) return 'absent';
  if (value.toLowerCase() === UNKNOWN) return { at: null };
  const at = dateAt(value);
  return at ? { at } : 'invalid';
}

const atOf = (row: Row, field: string) => {
  const when = whenOf(row, field);
  return typeof when === 'object' ? when.at : null;
};

function ratingOf(row: Row): number | null | 'invalid' {
  const value = text(row.rating);
  if (!value) return null;
  const rating = Number(value);
  return Number.isInteger(rating) && rating >= 1 && rating <= 10 ? rating : 'invalid';
}

const ratingValue = (row: Row): number | null => {
  const rating = ratingOf(row);
  return typeof rating === 'number' ? rating : null;
};

const seconds = (value: unknown): number | null | 'invalid' => {
  const raw = text(value);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 'invalid';
};

type Pause = { positionMs: number | null; runtimeMs: number | null; percent: number | null };

function pauseOf(row: Row): Pause | null | string {
  const position = seconds(row.position_seconds);
  const runtime = seconds(row.runtime_seconds);
  const raw = text(row.progress);
  const percent = raw ? Number(raw) : null;
  if (position === 'invalid') return 'position_seconds is not a number of seconds';
  if (runtime === 'invalid') return 'runtime_seconds is not a number of seconds';
  if (percent !== null && !(Number.isFinite(percent) && percent > 0 && percent < 100)) return 'progress is not a percentage between 0 and 100';
  if (position === null && percent === null) return whenOf(row, 'paused_at') !== 'absent' ? 'paused_at needs position_seconds or progress' : null;
  if (position !== null && runtime !== null && runtime <= position) return 'runtime_seconds is not longer than position_seconds';
  return { positionMs: position === null ? null : Math.round(position * 1000), runtimeMs: runtime === null ? null : Math.round(runtime * 1000), percent };
}

const pauseIn = (row: Row): Pause | null => {
  const pause = pauseOf(row);
  return pause && typeof pause === 'object' ? pause : null;
};

const idsOf = (row: Row): TitleIds => ({ imdb: imdbOf(text(row.imdb_id)), tmdb: positive(text(row.tmdb_id)), tvdb: positive(text(row.tvdb_id)) });

// Seasons and episodes are numbered as on TMDB, so a show named only by IMDb or TVDB is found there first.
function withShowTmdb(ids: TitleIds): TitleIds {
  if (ids.tmdb) return ids;
  const imdb = ids.imdb as string | null;
  const tvdb = ids.tvdb as number | null;
  const anime = (imdb && idMapper.getMappingByImdbId(imdb)) || (tvdb && idMapper.getMappingByTvdbId(tvdb)) || null;
  let tmdb = anime?.themoviedb_type === 'tv' ? positive(anime.themoviedb_id) : null;
  if (!tmdb) {
    try {
      tmdb = positive((imdb ? idMappings.getByImdbId(imdb, 'series') : tvdb ? idMappings.getByTvdbId(String(tvdb), 'series') : null)?.tmdbId);
    } catch {}
  }
  return tmdb ? { ...ids, tmdb } : ids;
}

const hasIds = (row: Row, kind: Kind) => {
  const ids = idsOf(row);
  return Boolean(ids.imdb || ids.tmdb || (kind !== 'movie' && ids.tvdb));
};

const namedOf = (row: Row, kind: Kind): NamedTitle | null => {
  const name = text(row.title).slice(0, 300);
  return comparable(name) ? { name, year: positive(text(row.year)), kind: kind === 'movie' ? 'movie' : 'series' } : null;
};

function labelOf(row: Row, kind: Kind): string {
  const ids = idsOf(row);
  const name = text(row.title) || ids.imdb || (ids.tmdb && `TMDB ${ids.tmdb}`) || (ids.tvdb && `TVDB ${ids.tvdb}`) || 'Untitled';
  const year = positive(text(row.year));
  const where = kind === 'season' ? ` season ${text(row.season) || '?'}` : kind === 'episode' ? ` S${text(row.season) || '?'}E${text(row.episode) || '?'}` : '';
  return `${name}${year ? ` (${year})` : ''}${where}`;
}

function problemOf(row: Row, kind: Kind): string | null {
  if (kind === 'season' && seasonOf(row) === null) return 'A season row needs a season number';
  if (kind === 'episode' && (seasonOf(row) === null || !positive(text(row.episode)))) return 'An episode row needs season and episode numbers';
  for (const field of ['watched_at', 'watchlisted_at', 'rated_at', 'dropped_at', 'paused_at']) {
    if (whenOf(row, field) === 'invalid') return `${field} is not a date`;
  }
  if (ratingOf(row) === 'invalid') return 'rating is not a whole number from 1 to 10';
  if (whenOf(row, 'watched_at') !== 'absent' && kind !== 'movie' && kind !== 'episode') return 'watched_at goes on a movie or an episode row';
  if (whenOf(row, 'watchlisted_at') !== 'absent' && kind !== 'movie' && kind !== 'show') return 'watchlisted_at goes on a movie or a show row';
  if (whenOf(row, 'dropped_at') !== 'absent' && kind !== 'show') return 'dropped_at goes on a show row';
  const pause = pauseOf(row);
  if (typeof pause === 'string') return pause;
  if (pause && kind !== 'movie' && kind !== 'episode') return 'A paused position goes on a movie or an episode row';
  const acts = whenOf(row, 'watched_at') !== 'absent' || whenOf(row, 'watchlisted_at') !== 'absent' || whenOf(row, 'dropped_at') !== 'absent' || ratingOf(row) !== null || pause !== null;
  if (!acts) return 'Nothing to import: no watched_at, rating, position, watchlisted_at or dropped_at';
  if (!hasIds(row, kind) && !namedOf(row, kind)) return kind === 'movie' && idsOf(row).tvdb ? 'A movie needs an imdb_id, a tmdb_id or a title' : 'No id or title this server can use';
  return null;
}

const present = (field: string) => (row: Row) => whenOf(row, field) !== 'absent';

const profileNameOf = (fileName: string | null) => (fileName ? fileName.split(/[\\/]/).pop()!.replace(/\.(json|csv)$/i, '').slice(0, 80) : '') || 'Imported list';

export const listHistorySource: HistorySource = {
  id: 'list',
  importName: 'list import',

  about: 'Viewings, paused positions, ratings, the watchlist and dropped shows come over from the list. Rows with only a title and year are matched on LumiereDB, then TMDB. Nothing already here is lost: the newer state of each title wins, and a viewing already in the history is not added twice. Nothing is sent to the trackers now; what they lack shows in the Trackers section, to send or leave out.',

  sameViewingMs: () => envInt('JELLYFIN_HISTORY_IMPORT_LIST_SAME_WATCH_MINUTES', 180, 0) * 60 * 1000,

  detects: (upload) => rowsOf(upload) !== null,

  async read(upload, { userUUID, config, picks }) {
    const rows = rowsOf(upload) ?? [];
    const { miss, done } = unmatchedList();
    const usable: Array<{ row: Row; kind: Kind }> = [];
    rows.forEach((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return miss(`Row ${index + 1}`, 'Not an object');
      const kind = kindOf(row);
      if (!kind) return miss(labelOf(row, 'movie'), text(row.type) ? `type "${text(row.type).slice(0, 20)}" is not movie, show, season or episode` : 'No type');
      const problem = problemOf(row, kind);
      if (problem) return miss(labelOf(row, kind), problem);
      usable.push({ row, kind });
    });

    const named = new Map<string, NamedTitle>();
    for (const { row, kind } of usable) {
      const title = hasIds(row, kind) ? null : namedOf(row, kind);
      if (title) named.set(titleKey(title.name, title.year, title.kind), title);
    }
    const looked = await lookupAll('list', userUUID, named, (title) => titleIdsFor(title, config));
    if (!('values' in looked)) return { matching: { ...looked, label: 'Matching titles' } };
    const { ids: matched, ambiguous, unpicked } = await settleTitles(looked.values, named, picks, config);

    const keyOf = (row: Row, kind: Kind) => {
      const title = namedOf(row, kind)!;
      return titleKey(title.name, title.year, title.kind);
    };
    const titleIdsOf = (row: Row, kind: Kind): TitleIds | null => {
      if (hasIds(row, kind)) return kind === 'season' || kind === 'episode' ? withShowTmdb(idsOf(row)) : idsOf(row);
      const match = matched.get(keyOf(row, kind));
      return match ? { imdb: match.imdb, tmdb: match.tmdb } : null;
    };

    const paused = usable.filter(({ row }) => pauseIn(row));
    const askOf = (row: Row, kind: Kind) => runtimeAskOf(titleIdsOf(row, kind), kind === 'episode' ? seasonOf(row) : null, kind === 'episode' ? positive(text(row.episode)) : null);
    const runtimes = await runtimesFor('list:runtime', userUUID, paused.filter(({ row }) => pauseIn(row)!.runtimeMs === null).map(({ row, kind }) => askOf(row, kind)));
    if (!('runtimeOf' in runtimes)) return { matching: { ...runtimes, label: 'Reading runtimes' } };

    const kinds = new Map<Row, Kind>(usable.map(({ row, kind }) => [row, kind]));
    const resumeOf = (row: Row) => {
      const pause = pauseIn(row)!;
      const kind = kinds.get(row)!;
      const runtimeMs = pause.runtimeMs ?? runtimes.runtimeOf(askOf(row, kind));
      if (!runtimeMs) {
        // A title that did not match is reported once, by find.
        if (titleIdsOf(row, kind)) miss(labelOf(row, kind), 'No runtime to place the paused position; add runtime_seconds');
        else void find(row);
        return null;
      }
      const positionMs = pause.positionMs ?? Math.round((runtimeMs * pause.percent!) / 100);
      if (positionMs >= runtimeMs) {
        miss(labelOf(row, kind), 'position_seconds is past the runtime');
        return null;
      }
      return { positionMs, runtimeMs };
    };

    const found = new Map<Row, Promise<Found | null>>();
    const resolve = async (row: Row, kind: Kind): Promise<Found | null> => {
      const ids = titleIdsOf(row, kind);
      if (!ids) {
        const key = keyOf(row, kind);
        if (!unpicked.has(key)) miss(labelOf(row, kind), matched.has(key) ? 'No match on LumiereDB or TMDB' : 'LumiereDB and TMDB could not be reached');
        return null;
      }
      const season = seasonOf(row);
      const episode = positive(text(row.episode));
      const spellings =
        kind === 'movie' ? await filmSpellings(ids)
        : kind === 'show' ? showSpellings(ids)
        : kind === 'season' ? tmdbSeasonSpellings(ids, season!)
        : await tmdbEpisodeSpellings(ids, season!, episode!);
      if (!spellings.length) {
        miss(labelOf(row, kind), 'No id this server can use');
        return null;
      }
      return { spellings, kind: kind === 'movie' ? 'movie' : 'series' };
    };
    const find = (row: Row) => {
      if (!found.has(row)) found.set(row, resolve(row, kinds.get(row)!));
      return found.get(row)!;
    };

    const of = (...wanted: Kind[]) => usable.filter(({ kind }) => wanted.includes(kind)).map(({ row }) => row);
    const body = await historyFromSections('list', profileNameOf(upload.fileName), 0, find, [
      { into: 'viewings', rows: of('movie', 'episode'), keep: present('watched_at'), at: (row) => atOf(row, 'watched_at') },
      { into: 'ratings', rows: of('movie', 'show', 'season', 'episode'), at: (row) => atOf(row, 'rated_at'), rating: ratingValue },
      { into: 'watchlist', rows: of('movie', 'show'), keep: present('watchlisted_at'), at: (row) => atOf(row, 'watchlisted_at') },
      { into: 'dropped', rows: of('show'), keep: present('dropped_at'), at: (row) => atOf(row, 'dropped_at') },
      { into: 'progress', rows: paused.map(({ row }) => row), at: (row) => atOf(row, 'paused_at'), progress: resumeOf },
    ]);
    return { body, ...done(), ambiguous };
  },
};
