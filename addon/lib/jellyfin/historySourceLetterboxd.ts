import { createHash } from 'crypto';
import redis from '../redisClient';
import { envInt } from '../../utils/envNumber';
import { movieExternalIds } from '../getTmdb';
import { comparable, matchTitle, titleChoices } from '../../utils/titleMatch';
import { filmSpellings, historyFromSections, imdbOf, lookupAll, parseCsv, positive, unmatchedList, type Ambiguous, type Choice, type HistorySource, type Upload } from './historySources';

const FILES = ['watched.csv', 'diary.csv', 'ratings.csv', 'watchlist.csv'];
const URI = 'Letterboxd URI';

type FilmIds = { tmdb: number; imdb: string | null };

type FilmMatch = FilmIds | { options: Choice[] };

const TMDB_POSTER = 'https://image.tmdb.org/t/p/w154';

const choiceOf = (hit: any): Choice => ({
  tmdb: hit.id,
  title: String(hit.title ?? hit.name ?? '').slice(0, 200),
  originalTitle: hit.original_title && hit.original_title !== hit.title ? String(hit.original_title).slice(0, 200) : null,
  year: positive(String(hit.release_date ?? '').slice(0, 4)),
  poster: typeof hit.poster_path === 'string' ? `${TMDB_POSTER}${hit.poster_path}` : null,
  overview: String(hit.overview ?? '').slice(0, 300),
});

const imdbFor = async (tmdb: number, config: any) => imdbOf((await movieExternalIds(String(tmdb), config).catch(() => null))?.imdb_id);

const headerOf = (text: string) => text.slice(0, 1000).replace(/^\ufeff/, '').split(/\r?\n/)[0] ?? '';

function filesOf(upload: Upload): Map<string, string> {
  if (upload.files.size !== 1) return upload.files;
  const [[name, text]] = [...upload.files];
  if (FILES.includes(name)) return upload.files;
  const header = headerOf(text);
  if (!header.includes(URI)) return upload.files;
  const guessed = header.includes('Watched Date') ? 'diary.csv' : header.includes('Rating') ? 'ratings.csv' : 'watched.csv';
  return new Map([[guessed, text]]);
}

const filmKey = (name: string, year: string) => `${comparable(name)}\u0000${positive(year) ?? ''}`;

const dayAt = (value: string | undefined): number | null => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(at) ? at : null;
};

const choiceKey = (key: string) => createHash('sha1').update(key).digest('hex').slice(0, 16);

async function filmIdsFor(name: string, year: number | null, config: any): Promise<FilmMatch | null> {
  const key = `letterboxd:tmdb:v2:${createHash('sha1').update(filmKey(name, String(year ?? ''))).digest('hex')}`;
  const held = await redis.get(key).catch(() => null);
  if (typeof held === 'string') {
    try {
      return held === '' ? null : JSON.parse(held);
    } catch {
      return null;
    }
  }
  const pick = { title: name, year: year ?? undefined, kind: 'movie' as const, strict: true };
  const matched = await matchTitle(pick, config);
  const tmdb = positive(matched?.hit?.id);
  let value: FilmMatch | null = tmdb ? { tmdb, imdb: imdbOf(matched?.imdbId) ?? (await imdbFor(tmdb, config)) } : null;
  if (!value) {
    const options = (await titleChoices(pick, config)).filter((hit) => positive(hit?.id)).map(choiceOf);
    if (options.length > 1) value = { options };
  }
  const seconds = value ? envInt('LETTERBOXD_FILM_IDS_TTL_DAYS', 30, 1) * 86400 : envInt('LETTERBOXD_FILM_MISS_TTL_HOURS', 24, 1) * 3600;
  redis.set(key, value ? JSON.stringify(value) : '', 'EX', seconds).catch(() => undefined);
  return value;
}

type Film = { name: string; year: number | null };

const stars = (row: Record<string, string>): number | null => {
  const value = Number(row.Rating);
  return Number.isFinite(value) && value > 0 ? value * 2 : null;
};

export const letterboxdHistorySource: HistorySource = {
  id: 'letterboxd',

  about: 'The diary, watched films, ratings and watchlist come over from Letterboxd, each film matched by its name and year on LumiereDB, then TMDB. Nothing already here is lost: the newer state of each title wins, and a viewing already in the history is not added twice. Nothing is sent to the trackers.',

  sameViewingMs: () => envInt('JELLYFIN_HISTORY_IMPORT_LETTERBOXD_SAME_WATCH_HOURS', 36, 0) * 60 * 60 * 1000,

  detects(upload: Upload): boolean {
    const files = filesOf(upload);
    return FILES.some((name) => files.has(name) && headerOf(files.get(name)!).includes(URI));
  },

  async read(upload: Upload, { userUUID, config, picks }) {
    const files = filesOf(upload);
    const csv = (name: string) => (files.has(name) ? parseCsv(files.get(name)!) : []);
    const watched = csv('watched.csv');
    const diary = csv('diary.csv');
    const rated = csv('ratings.csv');
    const listed = csv('watchlist.csv');
    const username = csv('profile.csv')[0]?.Username || null;

    const films = new Map<string, Film>();
    for (const row of [...watched, ...diary, ...rated, ...listed]) {
      if (comparable(row.Name ?? '')) films.set(filmKey(row.Name, row.Year ?? ''), { name: row.Name.slice(0, 300), year: positive(row.Year) });
    }

    const looked = await lookupAll('letterboxd', userUUID, films, (film) => filmIdsFor(film.name, film.year, config));
    if (!('values' in looked)) return { matching: { ...looked, label: 'Matching films' } };
    const matched = { ids: looked.values };
    const ids = new Map<string, FilmIds | null>();
    const ambiguous: Ambiguous[] = [];
    for (const [key, found] of matched.ids) {
      const options = found && 'options' in found ? found.options : null;
      if (!options) {
        ids.set(key, found as FilmIds | null);
        continue;
      }
      const film = films.get(key)!;
      const picked = options.find((option) => option.tmdb === picks[choiceKey(key)])?.tmdb ?? null;
      ambiguous.push({ key: choiceKey(key), name: `${film.name}${film.year ? ` (${film.year})` : ''}`, options, picked });
      ids.set(key, picked ? { tmdb: picked, imdb: await imdbFor(picked, config) } : null);
    }
    const unpicked = new Set([...matched.ids].filter(([key, found]) => found && 'options' in found && !ids.get(key)).map(([key]) => key));
    ambiguous.sort((a, b) => a.name.localeCompare(b.name));

    const { miss, done } = unmatchedList();
    const missed = new Set<string>();
    const spellings = new Map<string, Promise<string[]>>();
    const spellingsOf = async (row: Record<string, string>): Promise<string[]> => {
      const key = filmKey(row.Name ?? '', row.Year ?? '');
      const film = ids.get(key);
      if (film) {
        if (!spellings.has(key)) spellings.set(key, filmSpellings({ imdb: film.imdb, tmdb: film.tmdb }));
        const found = await spellings.get(key)!;
        if (found.length) return found;
      }
      if (!missed.has(key) && !unpicked.has(key)) {
        missed.add(key);
        miss(`${row.Name || 'Untitled'}${row.Year ? ` (${row.Year})` : ''}`, ids.has(key) ? 'No match on LumiereDB or TMDB' : 'LumiereDB and TMDB could not be reached');
      }
      return [];
    };

    const film = async (row: Record<string, string>) => ({ spellings: await spellingsOf(row), kind: 'movie' as const });
    const body = await historyFromSections('letterboxd', username ? `Letterboxd: ${username}` : 'Letterboxd', letterboxdHistorySource.sameViewingMs(), film, [
      { into: 'viewings', rows: diary, at: (row) => dayAt(row['Watched Date']) ?? dayAt(row.Date) },
      { into: 'marked', rows: watched, at: (row) => dayAt(row.Date) },
      { into: 'ratings', rows: rated, at: (row) => dayAt(row.Date), rating: stars },
      { into: 'watchlist', rows: listed, at: (row) => dayAt(row.Date) },
    ]);
    return { body, ...done(), ambiguous };
  },
};
