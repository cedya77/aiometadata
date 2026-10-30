import { envInt } from '../../utils/envNumber';
import {
  filmSpellings,
  historyFromSections,
  lookupAll,
  positive,
  runtimeAskOf,
  runtimesFor,
  seasonNumber,
  showSpellings,
  tmdbEpisodeSpellings,
  tmdbSeasonSpellings,
  unmatchedList,
  type EpisodeAt,
  type Found,
  type HistorySource,
  type Upload,
} from './historySources';

type Section = 'history' | 'ratings' | 'watchlist' | 'hidden' | 'playback';

const SECTION_FILES: Array<[RegExp, Section]> = [
  [/^watched-history(-\d+)?\.json$/, 'history'],
  [/^ratings-[a-z]+\.json$/, 'ratings'],
  [/^lists-watchlist\.json$/, 'watchlist'],
  [/^hidden-progress-watched\.json$/, 'hidden'],
  [/^watched-playback\.json$/, 'playback'],
];

const sectionOfFile = (name: string): Section | null => SECTION_FILES.find(([pattern]) => pattern.test(name))?.[1] ?? null;

function sectionOfRows(rows: unknown): Section | null {
  if (!Array.isArray(rows)) return null;
  const first = rows.find((row) => row && typeof row === 'object');
  if (!first) return null;
  if (typeof first.watched_at === 'string' && typeof first.action === 'string') return 'history';
  if (typeof first.rated_at === 'string' && 'rating' in first) return 'ratings';
  if (typeof first.listed_at === 'string' && 'rank' in first) return 'watchlist';
  if (typeof first.hidden_at === 'string') return 'hidden';
  if (typeof first.paused_at === 'string' && 'progress' in first) return 'playback';
  return null;
}

const at = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

function labelOf(item: any, suffix = ''): string {
  const title = typeof item?.title === 'string' ? item.title : 'Untitled';
  const year = positive(item?.year);
  return `${title}${suffix}${year ? ` (${year})` : ''}`;
}

const tvdb: any = require('../tvdb');

async function tvdbNumbering(showTvdb: number, config: any): Promise<Map<number, EpisodeAt>> {
  const found = await tvdb.getSeriesEpisodes(String(showTvdb), 'en-US', 'default', config);
  const numbering = new Map<number, EpisodeAt>();
  for (const ep of found?.episodes ?? []) {
    const season = seasonNumber(ep?.seasonNumber);
    const episode = positive(ep?.number);
    if (positive(ep?.id) && season !== null && episode) numbering.set(ep.id, { season, episode });
  }
  return numbering;
}

const episodeLabel = (row: any) => labelOf(row?.show, ` S${row?.episode?.season ?? '?'}E${row?.episode?.number ?? '?'}`);

const pausedPercent = (row: any): number | null => {
  const progress = Number(row?.progress);
  return Number.isFinite(progress) && progress > 0 && progress < 100 ? progress : null;
};

const ofType = (...types: string[]) => (row: any) => types.includes(row?.type);

export const traktHistorySource: HistorySource = {
  id: 'trakt',
  importName: 'Trakt import',

  about: 'Plays, paused positions, ratings, the watchlist and shows hidden from progress come over from Trakt. Nothing already here is lost: the newer state of each title wins, and a viewing already in the history is not added twice. Nothing is sent to the trackers now; what they lack shows in the Trackers section, to send or leave out.',

  sameViewingMs: () => envInt('JELLYFIN_HISTORY_IMPORT_TRAKT_SAME_WATCH_MINUTES', 180, 0) * 60 * 1000,

  detects(upload: Upload): boolean {
    return [...upload.files.keys()].some((name) => !name.includes('/') && sectionOfFile(name) !== null) || sectionOfRows(upload.json) !== null;
  },

  async read(upload: Upload, { userUUID, config }) {
    const sections: Record<Section, any[]> = { history: [], ratings: [], watchlist: [], hidden: [], playback: [] };
    let username: string | null = null;
    const single = sectionOfRows(upload.json);
    if (single && upload.files.size === 1) sections[single].push(...(upload.json as any[]));
    else {
      for (const [name, text] of upload.files) {
        if (name.includes('/')) continue;
        const section = sectionOfFile(name);
        if (!section && name !== 'user-profile.json') continue;
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          return `${name} in this Trakt export is not valid JSON`;
        }
        if (!section) {
          if (typeof parsed?.username === 'string') username = parsed.username;
        } else if (Array.isArray(parsed)) sections[section].push(...parsed);
      }
    }

    const shows = new Map<string, number>();
    for (const row of [...sections.history, ...sections.ratings]) {
      const showTvdb = row?.type === 'episode' ? positive(row.show?.ids?.tvdb) : null;
      if (showTvdb && positive(row.episode?.ids?.tvdb)) shows.set(String(showTvdb), showTvdb);
    }
    const looked = await lookupAll('trakt', userUUID, shows, (showTvdb) => tvdbNumbering(showTvdb, config));
    if (!('values' in looked)) return { matching: { ...looked, label: 'Checking episode numbers' } };
    const onTvdb = (row: any): EpisodeAt | null => looked.values.get(String(positive(row.show?.ids?.tvdb)))?.get(Number(row.episode?.ids?.tvdb)) ?? null;

    const paused = sections.playback.filter((row) => ofType('movie', 'episode')(row) && pausedPercent(row) !== null);
    const askOf = (row: any) => (row.type === 'movie' ? runtimeAskOf(row.movie?.ids) : runtimeAskOf(row.show?.ids, seasonNumber(row.episode?.season), positive(row.episode?.number)));
    const runtimes = await runtimesFor('trakt:runtime', userUUID, paused.map(askOf));
    if (!('runtimeOf' in runtimes)) return { matching: { ...runtimes, label: 'Reading runtimes' } };

    const { miss, done } = unmatchedList();
    const episodes = new Map<string, Promise<string[]>>();
    const episodeOf = (row: any, season: number, episode: number) => {
      const key = `${JSON.stringify(row.show?.ids ?? {})}|${season}|${episode}`;
      if (!episodes.has(key)) episodes.set(key, tmdbEpisodeSpellings(row.show?.ids, season, episode, onTvdb(row)));
      return episodes.get(key)!;
    };
    const spellingsOf = async (row: any): Promise<(Found & { label: string }) | null> => {
      if (row?.type === 'movie') return { spellings: await filmSpellings(row.movie?.ids), label: labelOf(row.movie), kind: 'movie' };
      if (row?.type === 'show') return { spellings: showSpellings(row.show?.ids), label: labelOf(row.show), kind: 'series' };
      if (row?.type === 'season') {
        const season = seasonNumber(row.season?.number);
        return { spellings: season === null ? [] : tmdbSeasonSpellings(row.show?.ids, season), label: labelOf(row.show, ` season ${row.season?.number ?? '?'}`), kind: 'series' };
      }
      if (row?.type === 'episode') {
        const season = seasonNumber(row.episode?.season);
        const episode = positive(row.episode?.number);
        return { spellings: season !== null && episode ? await episodeOf(row, season, episode) : [], label: episodeLabel(row), kind: 'series' };
      }
      return null;
    };
    const matched = async (row: any) => {
      const found = await spellingsOf(row);
      if (found && !found.spellings.length) miss(found.label, 'No id this server can use');
      return found?.spellings.length ? found : null;
    };

    const body = await historyFromSections('trakt', username ? `Trakt: ${username}` : 'Trakt', traktHistorySource.sameViewingMs(), matched, [
      { into: 'viewings', rows: sections.history, keep: ofType('movie', 'episode'), at: (row) => at(row.watched_at) },
      { into: 'ratings', rows: sections.ratings, at: (row) => at(row.rated_at), rating: (row) => positive(row.rating) },
      { into: 'watchlist', rows: sections.watchlist, keep: ofType('movie', 'show'), at: (row) => at(row.listed_at) },
      { into: 'dropped', rows: sections.hidden, keep: ofType('show'), at: (row) => at(row.hidden_at) },
      {
        into: 'progress',
        rows: paused,
        at: (row) => at(row.paused_at),
        progress: (row) => {
          const runtimeMs = runtimes.runtimeOf(askOf(row));
          if (!runtimeMs) {
            miss(row.type === 'movie' ? labelOf(row.movie) : episodeLabel(row), 'No runtime to place the paused position');
            return null;
          }
          return { positionMs: Math.round((runtimeMs * pausedPercent(row)!) / 100), runtimeMs };
        },
      },
    ]);
    return { body, ...done() };
  },
};
