import consola from 'consola';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../../utils/envNumber';
import { asProfile } from '../dashboard';
import { profileKey } from '../profiles';
import { viewingTimeZone } from '../viewingHours';
import { titleKeys } from '../ratings';
import { animeYear, type AnimeYear } from './anime';
import { metaContextDigest } from './facts';
import { networkLogo, peopleYear, type PeopleYear } from './people';
import { safeTimeZone, yearBounds, yearPlays, type YearPlay } from './plays';
import { showProgress, type ShowProgress } from './progress';
import { enqueue, ticketFor } from './queue';
import { timeYear, type TimedYear, type YearTitle } from './timed';

const logger = consola.withTag('YearReview');
const database: any = require('../../database');

const REVIEW_VERSION = 1;
const RATING_BATCH = 500;
const SETUP_DIGEST = 12;

type Stored = { fingerprint: string; builtAt: number; data: any };

const memory = new LRUCache<string, Stored>({ max: envInt('JELLYFIN_YEAR_REVIEW_MEMORY', 20, 1) });

const reviewKey = (userUUID: string, historyKey: string, year: number) => `${userUUID}|${historyKey}|${year}`;

function localYear(at: number, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(new Date(at)));
}

async function yearsOf(userUUID: string, historyKey: string, timeZone: string): Promise<number[]> {
  const stats = await database.watchStatsBetween(userUUID, historyKey, 0, Number.MAX_SAFE_INTEGER);
  if (stats.first === null || stats.last === null) return [];
  const years: number[] = [];
  for (let year = localYear(stats.last, timeZone); year >= localYear(stats.first, timeZone); year -= 1) years.push(year);
  return years;
}

async function fingerprintOf(userUUID: string, historyKey: string, year: number, timeZone: string): Promise<string> {
  const { from, to } = yearBounds(year, timeZone);
  const [stats, meta] = await Promise.all([database.watchStatsBetween(userUUID, historyKey, from, to), metaContextDigest(userUUID)]);
  const setup = [REVIEW_VERSION, timeZone, meta, envInt('JELLYFIN_YEAR_REVIEW_BATCH_PLAYS', 6, 2), envInt('JELLYFIN_YEAR_REVIEW_BULK_GAP_SECONDS', 60, 0), envInt('JELLYFIN_REWATCH_MIN_GAP_MINUTES', 10, 0)];
  const watches = [stats.count, stats.last, stats.sum];
  return digest(setup) + digest(watches);
}

const digest = (parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, SETUP_DIGEST);

const sameSetup = (a: string, b: string): boolean => a.slice(0, SETUP_DIGEST) === b.slice(0, SETUP_DIGEST);

function episodesOf(title: YearTitle): number {
  return new Set(title.plays.filter((play) => play.episode !== null).map((play) => `${play.season ?? ''}:${play.episode}`)).size;
}

function rankShows(timed: TimedYear): YearTitle[] {
  return timed.titles.filter((title) => title.kind === 'series').map((title) => ({ title, episodes: episodesOf(title) }))
    .sort((a, b) => b.episodes - a.episodes || b.title.watchMs - a.title.watchMs).map(({ title }) => title);
}

async function networkOf(config: any, show: YearTitle | undefined): Promise<{ name: string; logo: string | null } | null> {
  const name = show?.facts?.networks[0];
  return name ? { name, logo: await networkLogo(config, name) } : null;
}

function summarise(year: number, timeZone: string, timed: TimedYear, progress: Map<string, ShowProgress>, network: { name: string; logo: string | null } | null, animeLayer: AnimeYear | null, people: PeopleYear | null, bulk: YearPlay[]): any {
  const films = timed.titles.filter((title) => title.kind === 'movie');
  const shows = timed.titles.filter((title) => title.kind === 'series');
  const anime = timed.titles.filter((title) => title.anime);
  const sum = (list: typeof timed.titles, pick: (title: (typeof timed.titles)[number]) => number) => list.reduce((total, title) => total + pick(title), 0);
  return {
    version: REVIEW_VERSION,
    year,
    timeZone,
    counts: timed.counts,
    topShows: rankShows(timed).map((title) => title.key),
    network,
    anime: animeLayer,
    people,
    totals: {
      plays: timed.plays.length,
      watchMs: timed.plays.reduce((total, play) => total + play.runtimeMs, 0),
      films: { titles: films.length, plays: sum(films, (title) => title.plays.length), watchMs: sum(films, (title) => title.watchMs) },
      shows: { titles: shows.length, plays: sum(shows, (title) => title.plays.length), watchMs: sum(shows, (title) => title.watchMs) },
      anime: { titles: anime.length, plays: sum(anime, (title) => title.plays.length) },
      rhythmPlays: timed.plays.filter((play) => !play.overfull).length,
      bulk: { plays: bulk.length, titles: new Set(bulk.map((play) => play.titleKey)).size },
    },
    titles: timed.titles.map((title) => ({
      key: title.key,
      kind: title.kind,
      name: title.facts?.name ?? null,
      anime: title.anime,
      watchMs: title.watchMs,
      ids: title.facts ? titleKeys(title.facts.id, title.facts.ids).filter((id) => id !== title.key) : [],
      episodes: episodesOf(title),
      progress: progress.get(title.key) ?? null,
      facts: title.facts ? { source: title.facts.source, year: title.facts.year, status: title.facts.status, runtimeMs: title.facts.runtimeMs, genres: title.facts.genres, countries: title.facts.countries, networks: title.facts.networks, studios: title.facts.studios, language: title.facts.language, poster: title.facts.poster, background: title.facts.background, logo: title.facts.logo } : null,
      plays: title.plays.map((play) => [play.videoId, play.at, play.runtimeMs, play.runtimeSource, play.overfull ? 1 : 0, play.spellings]),
    })),
  };
}

async function buildYear(userUUID: string, profile: string | null, year: number, waitedMs: number): Promise<void> {
  await asProfile(userUUID, profile, async (config) => {
    const timeZone = safeTimeZone(viewingTimeZone(config));
    const historyKey = profileKey(config);
    const started = Date.now();
    const fingerprint = await fingerprintOf(userUUID, historyKey, year, timeZone);
    const played = await yearPlays(userUUID, historyKey, year, timeZone);
    const bulk = played.filter((play) => play.batch);
    const timed = await timeYear(userUUID, historyKey, played.filter((play) => !play.batch), timeZone);
    const animeLayer = animeYear(timed).catch(() => null);
    const [progress, network, anime, people] = await Promise.all([
      showProgress(userUUID, historyKey, yearBounds(year, timeZone).to, timed),
      networkOf(config, rankShows(timed)[0]),
      animeLayer,
      animeLayer.then((layer) => peopleYear(config, timed.titles, layer)).catch(() => null),
    ]);
    const builtAt = Date.now();
    const stored: Stored = { fingerprint, builtAt, data: summarise(year, timeZone, timed, progress, network, anime, people, bulk) };
    memory.set(reviewKey(userUUID, historyKey, year), stored);
    await database.putYearReview(userUUID, historyKey, year, fingerprint, builtAt, stored.data);
    const maxAgeMs = envInt('JELLYFIN_YEAR_REVIEW_FACTS_HOURS', 7 * 24, 1) * 60 * 60 * 1000;
    const pruned = await database.pruneTitleFacts(Date.now() - maxAgeMs).catch(() => 0);
    const { counts } = timed;
    logger.info(`${userUUID.slice(0, 8)} ${year}: ${timed.plays.length} plays, ${timed.titles.length} titles, facts ${counts.stored} stored, ${counts.held} cached, ${counts.built} built, ${counts.missing} missing, waited ${waitedMs}ms, built in ${builtAt - started}ms${pruned ? `, ${pruned} old facts pruned` : ''}`);
  });
}

export async function dashboardYear(userUUID: string, profile: string | null, year: number, have: number | null = null): Promise<any | null> {
  return asProfile(userUUID, profile, async (config) => {
    const timeZone = safeTimeZone(viewingTimeZone(config));
    const historyKey = profileKey(config);
    const key = reviewKey(userUUID, historyKey, year);
    const [fingerprint, years] = await Promise.all([fingerprintOf(userUUID, historyKey, year, timeZone), yearsOf(userUUID, historyKey, timeZone)]);
    let stored = memory.get(key) ?? null;
    if (!stored) {
      stored = await database.getYearReview(userUUID, historyKey, year).catch(() => null);
      if (stored) memory.set(key, stored);
    }
    const fresh = stored?.fingerprint === fingerprint;
    const recent = !!stored && sameSetup(stored.fingerprint, fingerprint) && Date.now() - stored.builtAt < envInt('JELLYFIN_YEAR_REVIEW_MIN_REBUILD_MINUTES', 30, 0) * 60 * 1000;
    const ticket = fresh || recent ? ticketFor(key) : enqueue(key, (waitedMs) => buildYear(userUUID, profile, year, waitedMs));
    const unchanged = !!stored && stored.builtAt === have;
    return {
      year,
      years,
      status: stored ? 'ready' : ticket?.state ?? 'queued',
      ...(ticket?.state === 'queued' ? { ahead: ticket.ahead } : {}),
      stale: !!stored && !fresh,
      rebuilding: stored && ticket ? ticket.state : null,
      builtAt: stored?.builtAt ?? null,
      ...(unchanged ? { unchanged: true, data: null } : { data: stored?.data ?? null }),
      ratings: stored?.data ? await ratingsOf(userUUID, historyKey, stored.data) : {},
    };
  });
}

async function ratingsOf(userUUID: string, historyKey: string, data: any): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const kind of ['movie', 'series'] as const) {
    const ownerOf = new Map<string, string>();
    for (const title of data.titles ?? []) {
      if (title.kind !== kind) continue;
      for (const id of [title.key, ...(title.ids ?? [])]) if (!ownerOf.has(id)) ownerOf.set(id, title.key);
    }
    const ids = [...ownerOf.keys()];
    for (let at = 0; at < ids.length; at += RATING_BATCH) {
      const rows: any[] = await database.listRatings(userUUID, historyKey, ids.slice(at, at + RATING_BATCH), kind).catch(() => []);
      for (const row of rows) {
        const key = ownerOf.get(String(row.meta_id));
        if (key && out[key] === undefined) out[key] = Number(row.rating);
      }
    }
  }
  return out;
}
