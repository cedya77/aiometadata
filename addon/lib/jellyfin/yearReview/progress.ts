import { parseStremioId } from '../idsCodec';
import { episodeKey } from './facts';
import { foldPlays } from './plays';
import type { TimedYear } from './timed';

const database: any = require('../../database');

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ShowProgress {
  aired: number;
  seen: number;
  seasons: number;
  finishedAt: number | null;
}

const baseOf = (id: string): string => {
  const parsed = parseStremioId(id);
  return parsed?.base ? String(parsed.base) : id;
};

export async function showProgress(userUUID: string, historyKey: string, to: number, timed: TimedYear): Promise<Map<string, ShowProgress>> {
  const out = new Map<string, ShowProgress>();
  const shows = timed.titles.filter((title) => title.kind === 'series' && Object.keys(title.facts?.releases ?? {}).length);
  const owner = new Map<string, string>();
  for (const title of shows) {
    for (const play of title.plays) for (const id of play.spellings) owner.set(baseOf(id), title.key);
    // Episodes watched in earlier years may sit under another of the show's ids than this year's plays used.
    const { imdb, tmdb, tvdb } = title.facts!.ids;
    for (const base of [imdb, tmdb && `tmdb:${tmdb}`, tvdb && `tvdb:${tvdb}`]) if (base && !owner.has(base)) owner.set(base, title.key);
  }
  if (!owner.size) return out;

  const releasesOf = new Map(shows.map((title) => [title.key, title.facts!.releases]));
  const rows = (await database.listEpisodeWatchesBefore(userUUID, historyKey, [...owner.keys()], to)).filter((row: { video_id: string }) => owner.has(baseOf(row.video_id)));
  const firstSeen = new Map<string, Map<string, number>>();
  for (const play of await foldPlays(rows)) {
    if (play.episode === null) continue;
    const key = play.spellings.map((id) => owner.get(baseOf(id))).find(Boolean);
    if (!key) continue;
    const releases = releasesOf.get(key)!;
    const own = episodeKey(play.season, play.episode);
    const episode = own in releases || play.season !== null ? own : episodeKey(1, play.episode);
    const seen = firstSeen.get(key) ?? new Map<string, number>();
    firstSeen.set(key, seen);
    seen.set(episode, Math.min(seen.get(episode) ?? Infinity, play.at));
  }

  const cutDay = Math.floor(Math.min(to, Date.now()) / DAY_MS);
  for (const title of shows) {
    const releases = releasesOf.get(title.key)!;
    const aired = Object.keys(releases).filter((episode) => releases[episode] <= cutDay);
    if (!aired.length) continue;
    const seen = firstSeen.get(title.key) ?? new Map<string, number>();
    const watched = aired.filter((episode) => seen.has(episode));
    out.set(title.key, {
      aired: aired.length,
      seen: watched.length,
      seasons: new Set(aired.map((episode) => episode.split(':')[0])).size,
      finishedAt: watched.length === aired.length ? Math.max(...watched.map((episode) => seen.get(episode)!)) : null,
    });
  }
  return out;
}
