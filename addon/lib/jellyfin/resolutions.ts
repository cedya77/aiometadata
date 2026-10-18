import { envInt } from '../../utils/envNumber';
import { movieBase, videoIdFor, type EpisodeNumbering, type ResolveTrace } from './resume';

const database: any = require('../database');
const DAY = 24 * 60 * 60 * 1000;

/**
 * Resolutions made before the mapping tables load fall back to bare TMDB ids; kept, they
 * would be served to every user for a month. Only a process with them loaded saves.
 */
function mappingsLoaded(): boolean {
  try {
    const { readiness } = require('../lifecycle/runtime');
    const components = readiness.snapshot().components;
    return ['idMapper', 'animeListMapper', 'wikiMappings'].every((name) => components[name]?.state === 'ready');
  } catch {
    return false;
  }
}

type Resolved = { metaId: string; videoId: string; mediaType: 'anime' | 'series' } | null;

function episodeKey(ids: Record<string, any>, season: number, episode: number, numbering: EpisodeNumbering = 'tmdb'): string {
  return `${numbering === 'tvdb' ? 'tv1' : 'ep2'}:${ids?.tmdb ?? ''}:${ids?.tvdb ?? ''}:${ids?.imdb ?? ''}:${season}:${episode}`;
}

/**
 * Resolutions for one snapshot build: what the table already holds is read in one go,
 * only what it lacks is looked up, and the new ones are written back for every user.
 */
export class Resolutions {
  private held = new Map<string, any>();
  private found = new Map<string, any>();
  // Answered around a failed lookup: used for this build, never saved for everyone.
  private unsaved = new Set<string>();
  private tmdbDown = new Set<string>();

  async preload(episodes: Array<[Record<string, any>, number, number, EpisodeNumbering?]>, movies: Array<string | number>): Promise<void> {
    const keys = [
      ...episodes.map(([ids, season, episode, numbering]) => episodeKey(ids, season, episode, numbering)),
      ...movies.map((tmdb) => `movie:${tmdb}`),
    ];
    if (!keys.length) return;
    const now = Date.now();
    const maxAge = envInt('JELLYFIN_ID_RESOLUTION_DAYS', 30, 1) * DAY;
    // An episode nothing resolved is tried again sooner: its mappings may arrive.
    const missAge = Math.min(maxAge, 3 * DAY);
    for (const row of await database.getIdResolutions([...new Set(keys)]).catch(() => [])) {
      let value: any;
      try {
        value = JSON.parse(row.value);
      } catch {
        continue;
      }
      if (now - Number(row.resolved_at) < (value === null ? missAge : maxAge)) this.held.set(row.resolution_key, value);
    }
  }

  async episode(ids: Record<string, any>, season: number, episode: number, config: any, numbering: EpisodeNumbering = 'tmdb'): Promise<Resolved> {
    const key = episodeKey(ids, season, episode, numbering);
    if (this.held.has(key)) return this.held.get(key);
    if (this.found.has(key)) return this.found.get(key);
    const trace: ResolveTrace = { tmdbDown: this.tmdbDown };
    const resolved = await videoIdFor(ids, season, episode, config, trace, numbering);
    this.found.set(key, resolved ?? null);
    if (trace.failed) this.unsaved.add(key);
    return resolved;
  }

  async movie(tmdb: string | number, config: any): Promise<string> {
    const key = `movie:${tmdb}`;
    if (this.held.has(key)) return this.held.get(key);
    if (this.found.has(key)) return this.found.get(key);
    const base = await movieBase(tmdb, config);
    // A film that fell back to its TMDB id may gain an IMDb id later; it is not kept.
    if (!base.startsWith('tmdb:')) this.found.set(key, base);
    return base;
  }

  async save(): Promise<void> {
    if (!this.found.size || !mappingsLoaded()) return;
    const entries = [...this.found]
      .filter(([key]) => !this.unsaved.has(key))
      .map(([key, value]) => ({ key, value: JSON.stringify(value) }));
    if (entries.length) await database.putIdResolutions(entries).catch(() => undefined);
  }
}
