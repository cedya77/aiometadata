import consola from 'consola';
import type { WatchedKind, WatchedRow } from './history';

const logger = consola.withTag('Recommendations');

const ANIME_IDS = /^(kitsu|mal|anilist|anidb):/;

function envInt(name: string, fallback: number, min: number): number {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function preferredBase(bases: string[]): string {
  return bases.find((id) => id.startsWith('tt')) ?? bases.find((id) => id.startsWith('tmdb:')) ?? bases[0];
}

function yearOf(meta: any): number | undefined {
  const year = parseInt(String(meta?.year ?? meta?.releaseInfo ?? '').slice(0, 4), 10);
  return Number.isFinite(year) && year > 1870 ? year : undefined;
}

export async function localPlayVersion(userUUID: string, profile: string): Promise<string> {
  const database: any = require('../../lib/database');
  return database.playstateVersion(userUUID, profile);
}

export async function collectLocalRows(config: any, userUUID: string, profile: string, limit?: number): Promise<WatchedRow[]> {
  const database: any = require('../../lib/database');
  const { groupBySpelling }: any = require('../../lib/jellyfin/aliases');
  const { parseStremioId }: any = require('../../lib/jellyfin/ids');
  const { cacheWrapMetaSmart }: any = require('../../lib/getCache');
  const lookup = async (type: string, id: string) => (await cacheWrapMetaSmart(userUUID, id,
    async () => ({ meta: null }), undefined, { config }, type, false))?.meta ?? null;
  const { mapWithConcurrency }: any = require('../concurrency');

  const plays = (await database.listPlayedForProfile(userUUID, profile)) as any[];
  if (!plays.length) return [];

  type Title = { bases: Set<string>; episode: boolean; episodes: Set<string>; played: boolean; at: number };
  const titles = new Map<string, Title>();
  const titleOf = new Map<string, string>();
  for (const group of (await groupBySpelling(plays)) as any[][]) {
    const bases = new Set<string>();
    let number: string | null = null;
    for (const row of group) {
      const parsed = parseStremioId(String(row.video_id));
      if (!parsed?.base) continue;
      bases.add(parsed.base);
      if (parsed.episode !== null && parsed.episode !== undefined) number ??= `${parsed.season ?? ''}:${parsed.episode}`;
    }
    if (!bases.size) continue;
    const key = [...bases].map((base) => titleOf.get(base)).find(Boolean) ?? [...bases][0];
    const title = titles.get(key) ?? { bases: new Set<string>(), episode: false, episodes: new Set<string>(), played: false, at: 0 };
    for (const base of bases) {
      const other = titleOf.get(base);
      const absorbed = other && other !== key ? titles.get(other) : undefined;
      if (absorbed) {
        for (const id of absorbed.bases) { title.bases.add(id); titleOf.set(id, key); }
        for (const episode of absorbed.episodes) title.episodes.add(episode);
        title.episode ||= absorbed.episode;
        title.played ||= absorbed.played;
        title.at = Math.max(title.at, absorbed.at);
        titles.delete(other!);
      }
      title.bases.add(base);
      titleOf.set(base, key);
    }
    const played = group.some((row) => Number(row.played) === 1);
    if (number !== null) {
      title.episode = true;
      if (played) title.episodes.add(number);
    }
    title.played ||= played;
    title.at = Math.max(title.at, ...group.map((row) => Number(row.last_played_at) || Number(row.updated_at) || 0));
    titles.set(key, title);
  }

  const ratings = new Map<string, number>();
  for (const row of (await database.listProfileRatings(userUUID, profile, 5000).catch(() => [])) as any[]) {
    if (!ratings.has(String(row.meta_id))) ratings.set(String(row.meta_id), Number(row.rating));
  }

  const ordered = [...titles.values()]
    .filter((title) => title.played)
    .sort((a, b) => b.at - a.at);
  const max = limit ?? envInt('RECOMMENDATION_LOCAL_HISTORY_MAX', 500, 1);
  const width = envInt('RECOMMENDATION_ENRICH_CONCURRENCY', 6, 1);

  const merged = new Map<string, { row: WatchedRow; episodic: boolean; episodes: Set<string> }>();
  let looked = 0;
  let unnamed = 0;
  for (let at = 0; at < ordered.length && merged.size < max; at += width * 4) {
    const batch = ordered.slice(at, at + width * 4);
    looked += batch.length;
    const resolved = await mapWithConcurrency(batch, width, async (title: Title) => {
      const meta = await lookup(title.episode ? 'series' : 'movie', preferredBase([...title.bases])).catch(() => null);
      const name = String(meta?.name || '').trim();
      return name ? { title, meta, name } : null;
    });
    for (const found of resolved) {
      if (!found) { unnamed += 1; continue; }
      const { title, meta, name } = found;
      const bases = [...title.bases];
      const anime = bases.some((id) => ANIME_IDS.test(id));
      const kind: WatchedKind = anime ? 'anime' : title.episode ? 'series' : 'movie';
      const imdbId = bases.find((id) => id.startsWith('tt'))
        ?? [meta?.imdb_id, meta?._imdbId].find((id) => typeof id === 'string' && id.startsWith('tt'));
      const tmdbId = Number(bases.find((id) => id.startsWith('tmdb:'))?.slice(5) ?? meta?._tmdbId);
      const hasTmdb = Number.isFinite(tmdbId) && tmdbId > 0;
      const key = imdbId || (hasTmdb ? `local:${kind}:tmdb:${tmdbId}` : `local:${meta?.id || preferredBase(bases)}`);
      const rating = [...bases, meta?.id, imdbId].map((id) => (id ? ratings.get(String(id)) : undefined)).find((value) => Number.isFinite(value) && value! > 0);
      const held = merged.get(key);
      if (held) {
        held.episodic ||= title.episode;
        for (const episode of title.episodes) held.episodes.add(episode);
        held.row.rating ??= rating;
        if (title.at && (!held.row.watchedAt || new Date(title.at).toISOString() > held.row.watchedAt)) held.row.watchedAt = new Date(title.at).toISOString();
        continue;
      }
      if (merged.size >= max) continue;
      merged.set(key, {
        episodic: title.episode,
        episodes: new Set(title.episodes),
        row: {
          key,
          imdbId,
          tmdbId: hasTmdb ? tmdbId : undefined,
          title: name,
          year: yearOf(meta),
          kind,
          rating,
          watchedAt: title.at ? new Date(title.at).toISOString() : undefined,
          status: 'completed',
          source: 'local',
        },
      });
    }
  }

  logger.debug(`Read ${merged.size} titles from ${plays.length} Jellyfin plays (${ordered.length} found, ${looked} looked up, ${unnamed} without a name)`);
  return [...merged.values()].map(({ row, episodic, episodes }) => (episodic ? { ...row, watchedEpisodes: episodes.size } : row));
}

module.exports = { collectLocalRows, localPlayVersion };
