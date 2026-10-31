import { createHash } from 'crypto';
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
import { filmWatched, imdbOfItem, isAnimeId, isStremioLibrary, lastSessionFinished, readStremioLibrary, reallyPlayed, resumeOf, type StremioItem } from './stremioLibrary';
import { anchorWatched, decodeWatched, parseWatched, sortedVideoIds, unanchored, type VideoRef, type WatchedField } from './stremioWatched';

const idMapper: any = require('../id-mapper');

const USABLE_VIDEO = /^(tt\d+|(tmdb|tvdb|kitsu|mal|anilist|anidb):\d+)(:\d+)*$/;
const ONLY_ANCHOR = 'Only the last watched episode could be placed';
const UNPLACED = 'Watched marks saved without a position were left out';
// readHistoryFile keeps no more plays than this.
const MAX_PLAYS = 10000;

type Lists = { own: string[] | null; cinemeta: string[] | null };
type Marks = { field: WatchedField; current: string | null };
type Title = { id: string; marks: Marks[] };
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

const marksDigest = (marks: Marks[]): string =>
  createHash('sha1')
    .update(marks.map(({ field, current }) => `${field.anchor}\u0000${field.anchorLength}\u0000${field.bits.toString('base64')}\u0000${current ?? ''}`).sort().join('\n'))
    .digest('hex')
    .slice(0, 16);

const beforeCurrent = (order: string[], current: string | null): string | null => {
  const at = current ? order.indexOf(current) : -1;
  return at > 0 ? order[at - 1] : null;
};

const fitsCurrent = (episodes: string[], order: string[], current: string | null): boolean =>
  !current || !order.includes(current) || episodes.includes(current) || episodes.includes(beforeCurrent(order, current) ?? '');

const placedFitting = (marks: Marks, ids: string[]): boolean => {
  const placed = decodeWatched(marks.field, ids);
  return Boolean(placed && fitsCurrent(placed, ids, marks.current));
};

// This server's list first, as most Stremio users watch through AIOMetadata; Cinemeta when it cannot place a show's marks.
async function episodeLists(userUUID: string, title: Title): Promise<Lists> {
  let own: string[] | null = null;
  try {
    const meta = await require('./items').fetchMeta(userUUID, 'series', title.id);
    if (Array.isArray(meta?.videos)) own = sortedVideoIds(videoRefs(meta.videos));
  } catch {
    own = null;
  }
  const unplaced = title.marks.find((marks) => imdbOfAnchor(marks.field.anchor) && !(own && placedFitting(marks, own)));
  if (!unplaced) return { own, cinemeta: null };
  const videos = await idMapper.getCinemetaVideosForImdbSeries(imdbOfAnchor(unplaced.field.anchor)).catch(() => null);
  return { own, cinemeta: Array.isArray(videos) ? sortedVideoIds(videoRefs(videos)) : null };
}

function watchedEpisodes(item: StremioItem, lists: Lists | undefined, miss: (name: string, reason: string) => void): { episodes: string[]; last: string | null } {
  const field = parseWatched(item.state.watched);
  let episodes: string[] = [];
  let order: string[] | null = null;
  if (field) {
    const decoded = [lists?.own, lists?.cinemeta].flatMap((ids) => {
      const placed = ids ? decodeWatched(field, ids) : null;
      return placed ? [{ placed, ids: ids! }] : [];
    });
    const chosen = decoded.find(({ placed, ids }) => fitsCurrent(placed, ids, item.state.videoId)) ?? decoded[0];
    if (chosen) {
      episodes = chosen.placed;
      order = chosen.ids;
    }
    if (order && unanchored(field)) {
      const kept = episodes.filter((id) => id === item.state.videoId || id === beforeCurrent(order!, item.state.videoId));
      if (kept.length < episodes.length) miss(item.name, UNPLACED);
      episodes = kept;
    }
    if (!order && anchorWatched(field)) {
      episodes = [field.anchor];
      miss(item.name, ONLY_ANCHOR);
    }
  }
  const latestMark = field && episodes.includes(field.anchor) ? field.anchor : episodes[episodes.length - 1] ?? null;
  const { videoId: current, timeOffset } = item.state;
  // Stremio leaves a season's last episode flagged but its bit unset once it has played through.
  if (item.state.flaggedWatched && current && !episodes.includes(current)) episodes = [...episodes, current];
  const watched = (id: string | null | undefined): id is string => Boolean(id) && episodes.includes(id!);

  // lastWatched dates Stremio's latest session: on the current episode while it is under way, on the one it
  // just moved on from when the position is 1, and otherwise on the current episode or the latest mark.
  let last: string | null;
  if (timeOffset > 1) last = watched(current) ? current : null;
  else if (timeOffset === 1) {
    const at = order && current ? order.indexOf(current) : -1;
    last = at > 0 ? (watched(order![at - 1]) ? order![at - 1] : null) : latestMark;
  } else last = watched(current) ? current : latestMark;
  return { episodes: episodes.filter((id) => USABLE_VIDEO.test(id)), last };
}

export const stremioHistorySource: HistorySource = {
  id: 'stremio',
  importName: 'Stremio import',

  about: 'Watched films and episodes, where you stopped, and the Stremio library as the watchlist come over from each Stremio profile. Nothing already here is lost: the newer state of each title wins, and a viewing already in the history is not added twice. Nothing is sent to the trackers now; what they lack shows in the Trackers section, to send or leave out.',

  sameViewingMs: () => envInt('JELLYFIN_HISTORY_IMPORT_STREMIO_SAME_WATCH_MINUTES', 180, 0) * 60 * 1000,

  // Stremio never records a play made here, so a state here is the same viewing only at the same moment; a newer one wins.
  sameStateMs: () => envInt('JELLYFIN_HISTORY_IMPORT_SAME_WATCH_SECONDS', 60, 0) * 1000,

  detects: (upload) => isStremioLibrary(upload.json),

  async read(upload, { userUUID }) {
    const profiles = readStremioLibrary(upload.json);

    const titles = new Map<string, Title>();
    for (const { items } of profiles) {
      for (const item of items) {
        const field = item.type === 'series' ? parseWatched(item.state.watched) : null;
        if (!field) continue;
        const title = titles.get(item.id) ?? { id: item.id, marks: [] };
        title.marks.push({ field, current: item.state.videoId });
        titles.set(item.id, title);
      }
    }
    // A title's marks decide whether Cinemeta is asked, so lookups held for a later request are keyed by them too.
    const keys = new Map([...titles.values()].map((title) => [title.id, `${title.id}\u0000${marksDigest(title.marks)}`]));
    const lookups = new Map([...titles.values()].map((title) => [keys.get(title.id)!, title]));
    const looked = lookups.size ? await lookupAll('stremio', userUUID, lookups, (title) => episodeLists(userUUID, title)) : { values: new Map<string, Lists>() };
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
            const plays = Math.min(MAX_PLAYS, Math.max(1, Math.round(state.timesWatched)));
            const dated = reallyPlayed(state) && lastSessionFinished(state) && state.lastWatched ? 1 : 0;
            if (dated) rows.viewings.push({ ...row, at: state.lastWatched });
            for (let i = dated; i < plays; i++) rows.viewings.push({ ...row, at: null });
            if (!dated) rows.marked.push({ ...row, at: state.lastWatched });
          }
          if (resume) rows.progress.push({ ...row, at: state.lastWatched, progress: resume });
        } else {
          const { episodes, last } = watchedEpisodes(item, looked.values.get(keys.get(item.id) ?? ''), miss);
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
