import { envInt } from '../../utils/envNumber';
import { comparable } from '../../utils/titleMatch';
import { filmSpellings, historyFromSections, lookupAll, parseCsv, positive, unmatchedList, type HistorySource, type Upload } from './historySources';
import { settleTitles, titleIdsFor, titleKey, type NamedTitle } from './historyTitles';

const FILES = ['watched.csv', 'diary.csv', 'ratings.csv', 'watchlist.csv'];
const URI = 'Letterboxd URI';

const headerOf = (text: string) => text.slice(0, 1000).replace(/^\ufeff/, '').split(/\r?\n/)[0] ?? '';

function filesOf(upload: Upload): Map<string, string> {
  if (upload.files.size !== 1) return upload.files;
  const [[name, text]] = [...upload.files];
  if (FILES.includes(name)) return upload.files;
  const header = headerOf(text);
  if (!header.includes(URI)) return upload.files;
  // watched.csv and watchlist.csv share one header, so only the file's name tells them apart.
  const guessed = header.includes('Watched Date') ? 'diary.csv'
    : header.includes('Rating') ? 'ratings.csv'
    : name.includes('watchlist') ? 'watchlist.csv'
    : name.includes('watched') ? 'watched.csv'
    : null;
  return guessed ? new Map([[guessed, text]]) : upload.files;
}

const filmKey = (name: string, year: string) => titleKey(name, year, 'movie');

const dayAt = (value: string | undefined): number | null => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(at) ? at : null;
};

const stars = (row: Record<string, string>): number | null => {
  const value = Number(row.Rating);
  return Number.isFinite(value) && value > 0 ? value * 2 : null;
};

export const letterboxdHistorySource: HistorySource = {
  id: 'letterboxd',
  importName: 'Letterboxd import',

  about: 'The diary, watched films, ratings and watchlist come over from Letterboxd, each film matched by its name and year on LumiereDB, then TMDB. Nothing already here is lost: the newer state of each title wins, and a viewing already in the history is not added twice. Nothing is sent to the trackers now; what they lack shows in the Trackers section, to send or leave out.',

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

    const films = new Map<string, NamedTitle>();
    for (const row of [...watched, ...diary, ...rated, ...listed]) {
      if (comparable(row.Name ?? '')) films.set(filmKey(row.Name, row.Year ?? ''), { name: row.Name.slice(0, 300), year: positive(row.Year), kind: 'movie' });
    }

    const looked = await lookupAll('letterboxd', userUUID, films, (film) => titleIdsFor(film, config));
    if (!('values' in looked)) return { matching: { ...looked, label: 'Matching films' } };
    const { ids, ambiguous, unpicked } = await settleTitles(looked.values, films, picks, config);

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
    const body = await historyFromSections('letterboxd', username ? `Letterboxd: ${username}` : 'Letterboxd', 0, film, [
      { into: 'viewings', rows: diary, at: (row) => dayAt(row['Watched Date']) ?? dayAt(row.Date) },
      { into: 'marked', rows: watched, at: (row) => dayAt(row.Date) },
      { into: 'ratings', rows: rated, at: (row) => dayAt(row.Date), rating: stars },
      { into: 'watchlist', rows: listed, at: (row) => dayAt(row.Date) },
    ]);
    return { body, ...done(), ambiguous };
  },
};
