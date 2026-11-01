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
import { episodeRefs, fallbackEpisodeId, isNuvioLibrary, placeEpisode, readNuvioLibrary, resumeOfProgress, USABLE_VIDEO, type EpisodeRef, type NuvioKind } from './nuvioLibrary';
import { isAnimeId } from './stremioLibrary';

const NOT_PLACED = "This episode wasn't found here";
const NO_EPISODE = 'Marked without an episode';
const NOT_FOUND = 'Not found here';

type Row = Found & { at: number | null; progress?: { positionMs: number; runtimeMs: number } };

async function episodeList(userUUID: string, id: string): Promise<EpisodeRef[] | null> {
  try {
    const meta = await require('./items').fetchMeta(userUUID, 'series', id);
    return Array.isArray(meta?.videos) ? episodeRefs(meta.videos) : null;
  } catch {
    return null;
  }
}

const usableVideo = (id: string | null): string | null => (id && USABLE_VIDEO.test(id) ? id : null);

export const nuvioHistorySource: HistorySource = {
  id: 'nuvio',
  importName: 'Nuvio import',

  about: 'Watched films and episodes, where you stopped, and the Nuvio library as the watchlist come over from each Nuvio profile. Nothing already here is lost: the newer state of each title wins, and a viewing already in the history is not added twice. Nothing is sent to the trackers now; what they lack shows in the Trackers section, to send or leave out.',

  sameViewingMs: () => envInt('JELLYFIN_HISTORY_IMPORT_NUVIO_SAME_WATCH_MINUTES', 180, 0) * 60 * 1000,

  sameStateMs: () => envInt('JELLYFIN_HISTORY_IMPORT_SAME_WATCH_SECONDS', 60, 0) * 1000,

  detects: (upload) => isNuvioLibrary(upload.json),

  async read(upload, { userUUID }) {
    const profiles = readNuvioLibrary(upload.json);

    const shows = new Map<string, string>();
    for (const profile of profiles) {
      for (const row of profile.watched) if (row.kind === 'series' && row.episode !== null) shows.set(row.contentId, row.contentId);
      for (const row of profile.progress) if (row.kind === 'series' && !usableVideo(row.videoId)) shows.set(row.contentId, row.contentId);
    }
    const looked = shows.size ? await lookupAll('nuvio', userUUID, shows, (id) => episodeList(userUUID, id)) : { values: new Map<string, EpisodeRef[] | null>() };
    if (!('values' in looked)) return { matching: { ...looked, label: 'Checking episode lists' } };

    const { miss, done } = unmatchedList();
    const memo = new Map<string, Promise<string[]>>();
    const remembered = (key: string, make: () => Promise<string[]>) => {
      if (!memo.has(key)) memo.set(key, make().catch(() => [] as string[]));
      return memo.get(key)!;
    };
    const withAliases = (id: string) => remembered(id, async () => unique([id, ...(await videoIdAliases(id).catch(() => [] as string[]))]));
    const titleSpellings = (id: string, kind: NuvioKind) => {
      if (isAnimeId(id)) return withAliases(id);
      const [scheme, number] = id.split(':');
      const ids = { imdb: number === undefined ? id : undefined, tmdb: scheme === 'tmdb' ? number : undefined, tvdb: scheme === 'tvdb' ? number : undefined };
      return remembered(`${kind}\u0000${id}`, async () => (kind === 'movie' ? filmSpellings(ids) : showSpellings(ids)));
    };
    const episodeSpellings = async (contentId: string, season: number | null, episode: number | null, given: string | null): Promise<string[]> => {
      const list = looked.values.get(contentId) ?? null;
      const placed = given && (!list || list.some((ref) => ref.id === given)) ? given : placeEpisode(contentId, season, episode, list) ?? given;
      if (!placed) return [];
      const also = isAnimeId(contentId) ? [given] : [given, fallbackEpisodeId(contentId, season, episode)];
      return unique([placed, ...also, ...(await withAliases(placed))]);
    };

    const bodies: any[] = [];
    for (const profile of profiles) {
      const rows = { viewings: [] as Row[], progress: [] as Row[], watchlist: [] as Row[] };
      for (const row of profile.watched) {
        if (row.kind === 'series' && row.episode === null) {
          miss(row.title, NO_EPISODE);
          continue;
        }
        const spellings = row.kind === 'movie' ? await titleSpellings(row.contentId, 'movie') : await episodeSpellings(row.contentId, row.season, row.episode, null);
        if (spellings.length) rows.viewings.push({ spellings, kind: row.kind, at: row.watchedAt });
        else miss(row.title, row.kind === 'movie' ? NOT_FOUND : NOT_PLACED);
      }
      for (const row of profile.progress) {
        const resume = resumeOfProgress(row);
        if (!resume) continue;
        const spellings = row.kind === 'movie' ? await titleSpellings(row.contentId, 'movie') : await episodeSpellings(row.contentId, row.season, row.episode, usableVideo(row.videoId));
        if (spellings.length) rows.progress.push({ spellings, kind: row.kind, at: row.lastWatched, progress: resume });
      }
      for (const row of profile.library) {
        const spellings = await titleSpellings(row.contentId, row.kind);
        if (spellings.length) rows.watchlist.push({ spellings, kind: row.kind, mediaType: isAnimeId(row.contentId) ? 'anime' : row.kind, at: row.addedAt });
        else miss(row.name, NOT_FOUND);
      }
      const rules: SectionRule<Row>[] = [
        { into: 'viewings', rows: rows.viewings, at: (row) => row.at },
        { into: 'progress', rows: rows.progress, at: (row) => row.at, progress: (row) => row.progress ?? null },
        { into: 'watchlist', rows: rows.watchlist, at: (row) => row.at },
      ];
      bodies.push(await historyFromSections('nuvio', profile.name, nuvioHistorySource.sameViewingMs(), async (row: Row) => row, rules, profile.key));
    }
    return { body: combineHistoryBodies(bodies), ...done() };
  },
};
