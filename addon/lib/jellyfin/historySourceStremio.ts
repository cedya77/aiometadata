import { envInt } from '../../utils/envNumber';
import { videoIdAliases } from './aliases';
import {
  combineHistoryBodies,
  filmSpellings,
  historyFromSections,
  lookupAll,
  showSpellings,
  unique,
  unmatchedList,
  type Found,
  type HistorySource,
  type SectionRule,
} from './historySources';
import { filmWatched, imdbOfItem, isAnimeId, isStremioLibrary, readStremioLibrary, reallyPlayed, resumeOf, type StremioItem } from './stremioLibrary';
import { anchorWatched, decodeWatched, parseWatched, sortedVideoIds, type VideoRef } from './stremioWatched';

const idMapper: any = require('../id-mapper');

const USABLE_VIDEO = /^(tt\d+|(tmdb|tvdb|kitsu|mal|anilist|anidb):\d+)(:\d+)*$/;
const ONLY_ANCHOR = 'Only the last watched episode could be placed';

type Lists = { own: string[] | null; cinemeta: string[] | null };
type Title = { id: string; anchors: Set<string> };
type Row = Found & { at: number | null; asOf?: number | null; progress?: { positionMs: number; runtimeMs: number } };

const numberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const videoRefs = (videos: unknown): VideoRef[] =>
  (Array.isArray(videos) ? videos : [])
    .filter((video: any) => video && typeof video.id === 'string')
    .map((video: any) => ({
      id: video.id,
      season: numberOrNull(video.season),
      episode: numberOrNull(video.episode ?? video.number),
      released: typeof video.released === 'string' ? video.released : null,
    }));

const imdbOfAnchor = (anchor: string): string | null => /^tt\d+/.exec(anchor)?.[0] ?? null;

// This server's list first, as most Stremio users watch through AIOMetadata; Cinemeta when it cannot place an anchor.
async function episodeLists(userUUID: string, title: Title): Promise<Lists> {
  let own: string[] | null = null;
  try {
    const meta = await require('./items').fetchMeta(userUUID, 'series', title.id);
    if (Array.isArray(meta?.videos)) own = sortedVideoIds(videoRefs(meta.videos));
  } catch {
    own = null;
  }
  const unplaced = [...title.anchors].find((anchor) => imdbOfAnchor(anchor) && !own?.includes(anchor));
  if (!unplaced) return { own, cinemeta: null };
  const videos = await idMapper.getCinemetaVideosForImdbSeries(imdbOfAnchor(unplaced)).catch(() => null);
  return { own, cinemeta: Array.isArray(videos) ? sortedVideoIds(videoRefs(videos)) : null };
}

function watchedEpisodes(item: StremioItem, lists: Lists | undefined, miss: (name: string, reason: string) => void): { episodes: string[]; last: string | null } {
  const field = parseWatched(item.state.watched);
  let episodes: string[] = [];
  if (field) {
    const placed = [lists?.own, lists?.cinemeta].map((ids) => (ids ? decodeWatched(field, ids) : null)).find((found) => found !== null);
    if (placed) episodes = placed;
    else if (anchorWatched(field)) {
      episodes = [field.anchor];
      miss(item.name, ONLY_ANCHOR);
    }
  }
  let last = field && episodes.includes(field.anchor) ? field.anchor : episodes[episodes.length - 1] ?? null;
  const current = item.state.videoId;
  // The episode Stremio was playing at lastWatched crossed the watched mark before its bit was set.
  if (item.state.flaggedWatched && current && !episodes.includes(current)) {
    episodes = [...episodes, current];
    last = current;
  }
  return { episodes: episodes.filter((id) => USABLE_VIDEO.test(id)), last };
}

export const stremioHistorySource: HistorySource = {
  id: 'stremio',

  about: 'Watched films and episodes, where you stopped, and the Stremio library as the watchlist come over from each Stremio profile. Nothing already here is lost: the newer state of each title wins, and a viewing already in the history is not added twice. Nothing is sent to the trackers.',

  sameViewingMs: () => envInt('JELLYFIN_HISTORY_IMPORT_STREMIO_SAME_WATCH_MINUTES', 180, 0) * 60 * 1000,

  detects: (upload) => isStremioLibrary(upload.json),

  async read(upload, { userUUID }) {
    const profiles = readStremioLibrary(upload.json);

    const titles = new Map<string, Title>();
    for (const { items } of profiles) {
      for (const item of items) {
        const field = item.type === 'series' ? parseWatched(item.state.watched) : null;
        if (!field) continue;
        const title = titles.get(item.id) ?? { id: item.id, anchors: new Set<string>() };
        title.anchors.add(field.anchor);
        titles.set(item.id, title);
      }
    }
    const looked = titles.size ? await lookupAll('stremio', userUUID, titles, (title) => episodeLists(userUUID, title)) : { values: new Map<string, Lists>() };
    if (!('values' in looked)) return { matching: { ...looked, label: 'Checking episode lists' } };

    const { miss, done } = unmatchedList();
    const memo = new Map<string, Promise<string[]>>();
    const remembered = (key: string, make: () => Promise<string[]>) => {
      if (!memo.has(key)) memo.set(key, make().catch(() => [] as string[]));
      return memo.get(key)!;
    };
    const withAliases = (id: string) => remembered(id, async () => unique([id, ...(await videoIdAliases(id).catch(() => [] as string[]))]));
    const titleSpellings = (item: StremioItem) => {
      if (isAnimeId(item.id)) return withAliases(item.id);
      const [scheme, number] = item.id.split(':');
      const ids = { imdb: imdbOfItem(item), tmdb: scheme === 'tmdb' ? number : undefined, tvdb: scheme === 'tvdb' ? number : undefined };
      return remembered(`${item.type}\u0000${item.id}\u0000${ids.imdb ?? ''}`, async () => (item.type === 'movie' ? filmSpellings(ids) : showSpellings(ids)));
    };

    const bodies: any[] = [];
    for (const profile of profiles) {
      const rows = { viewings: [] as Row[], marked: [] as Row[], progress: [] as Row[], watchlist: [] as Row[] };
      for (const item of profile.items) {
        const { state, type: kind } = item;
        const resume = resumeOf(state);
        if (kind === 'movie') {
          const spellings = await titleSpellings(item);
          if (!spellings.length) continue;
          const row = { spellings, kind, asOf: item.mtime };
          if (filmWatched(state)) {
            const plays = Math.max(1, Math.round(state.timesWatched));
            const dated = reallyPlayed(state) && state.lastWatched ? 1 : 0;
            if (dated) rows.viewings.push({ ...row, at: state.lastWatched });
            for (let i = dated; i < plays; i++) rows.viewings.push({ ...row, at: null });
            if (!dated) rows.marked.push({ ...row, at: state.lastWatched });
          }
          if (resume) rows.progress.push({ ...row, at: state.lastWatched, progress: resume });
        } else {
          const { episodes, last } = watchedEpisodes(item, looked.values.get(item.id), miss);
          for (const episode of episodes) {
            const spellings = await withAliases(episode);
            if (spellings.length) rows.marked.push({ spellings, kind, at: episode === last ? state.lastWatched : null, asOf: item.mtime });
          }
          if (resume && state.videoId && USABLE_VIDEO.test(state.videoId)) {
            rows.progress.push({ spellings: await withAliases(state.videoId), kind, at: state.lastWatched, asOf: item.mtime, progress: resume });
          }
        }
        if (item.listed) {
          const spellings = await titleSpellings(item);
          if (spellings.length) rows.watchlist.push({ spellings, kind, mediaType: isAnimeId(item.id) ? 'anime' : kind, at: item.mtime });
        }
      }
      const asOf = (row: Row) => row.asOf ?? null;
      const rules: SectionRule<Row>[] = [
        { into: 'viewings', rows: rows.viewings, at: (row) => row.at, asOf },
        { into: 'marked', rows: rows.marked, at: (row) => row.at, asOf },
        { into: 'progress', rows: rows.progress, at: (row) => row.at, asOf, progress: (row) => row.progress ?? null },
        { into: 'watchlist', rows: rows.watchlist, at: (row) => row.at },
      ];
      bodies.push(await historyFromSections('stremio', profile.name, stremioHistorySource.sameViewingMs(), async (row: Row) => row, rules, profile.key));
    }
    return { body: combineHistoryBodies(bodies), ...done() };
  },
};
