// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../../utils/envNumber';
import { bulkMarkRule } from '../bulkMarks';
import { asProfile } from '../dashboard';
import { profileKey } from '../profiles';
import { viewingTimeZone } from '../viewingHours';
import { titleKeys } from '../ratings';
import { animeYear, type AnimeYear } from './anime';
import { metaContextDigest } from './facts';
import { networkLogo, peopleYear, type PeopleYear } from './people';
import { safeTimeZone, yearBounds, yearPlays, type YearPlay } from './plays';
import { showProgress, type ShowProgress } from './progress';
import { enqueue, ticketFor, type Ticket } from './queue';
import { timeYear, type TimedYear, type YearTitle } from './timed';

const logger = consola.withTag('YearReview');
const database: any = require('../../database');
const redis: any = require('../../redisClient');

const REVIEW_VERSION = 1;
const RATING_BATCH = 500;
const SETUP_DIGEST = 12;

type Stored = { fingerprint: string; builtAt: number; data: any };

const memory = new LRUCache<string, Stored>({ max: envInt('JELLYFIN_YEAR_REVIEW_MEMORY', 20, 1) });
const yearLists = new LRUCache<string, Promise<number[]>>({ max: 500, ttl: 60 * 1000 });

const reviewKey = (userUUID: string, historyKey: string, year: number) => `${userUUID}|${historyKey}|${year}`;

function localYear(at: number, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(new Date(at)));
}

function yearsOf(userUUID: string, historyKey: string, timeZone: string): Promise<number[]> {
  const key = `${userUUID}|${historyKey}|${timeZone}`;
  const held = yearLists.get(key);
  if (held) return held;
  const read = readYears(userUUID, historyKey, timeZone);
  yearLists.set(key, read);
  read.catch(() => yearLists.delete(key));
  return read;
}

async function readYears(userUUID: string, historyKey: string, timeZone: string): Promise<number[]> {
  const stats = await database.watchStatsBetween(userUUID, historyKey, 0, Number.MAX_SAFE_INTEGER);
  if (stats.first === null || stats.last === null) return [];
  const years: number[] = [];
  for (let year = localYear(stats.last, timeZone); year >= localYear(stats.first, timeZone); year -= 1) years.push(year);
  return years;
}

async function fingerprintOf(userUUID: string, historyKey: string, year: number, timeZone: string): Promise<string> {
  const { from, to } = yearBounds(year, timeZone);
  // Show progress reads the watches before the year too, so a change to those makes the review stale as well.
  const [stats, before, meta] = await Promise.all([database.watchStatsBetween(userUUID, historyKey, from, to), database.watchStatsBetween(userUUID, historyKey, 0, from), metaContextDigest(userUUID)]);
  const bulk = bulkMarkRule();
  const setup = [REVIEW_VERSION, timeZone, meta, bulk.size, bulk.gapMs / 1000, envInt('JELLYFIN_REWATCH_MIN_GAP_MINUTES', 10, 0)];
  const watches = [stats.count, stats.last, stats.sum, before.count, before.sum];
  return digest(setup) + digest(watches);
}

const digest = (parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, SETUP_DIGEST);

const sameSetup = (a: string, b: string): boolean => a.slice(0, SETUP_DIGEST) === b.slice(0, SETUP_DIGEST);

type StaleReason = 'settings' | 'plays';

// Kept for the polls made while it builds, which skip the fingerprint.
const rebuildReasons = new Map<string, StaleReason>();

const saveRebuildDays = () => envInt('JELLYFIN_YEAR_REVIEW_SAVE_REBUILD_DAYS', 7, 0);
const openedKey = (key: string) => `jf:yearopened:${key}`;
const openedMarks = new LRUCache<string, number>({ max: 2000 });

// A save rebuilds only the reviews someone opened lately; the rest rebuild on their next visit.
function markOpened(key: string): void {
  const days = saveRebuildDays();
  if (!redis || days === 0) return;
  const now = Date.now();
  if (now - (openedMarks.get(key) ?? 0) < 60 * 60 * 1000) return;
  openedMarks.set(key, now);
  Promise.resolve(redis.set(openedKey(key), '1', 'EX', days * 24 * 60 * 60)).catch(() => openedMarks.delete(key));
}

async function openedLately(key: string): Promise<boolean> {
  if (!redis || saveRebuildDays() === 0) return false;
  try {
    return (await redis.exists(openedKey(key))) === 1;
  } catch {
    return false;
  }
}

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

type Taste = { watchlist: number | null; dropped: number };

function summarise(year: number, timeZone: string, timed: TimedYear, progress: Map<string, ShowProgress>, network: { name: string; logo: string | null } | null, animeLayer: AnimeYear | null, people: PeopleYear | null, taste: Taste, bulk: YearPlay[], incomplete: boolean): any {
  const films = timed.titles.filter((title) => title.kind === 'movie');
  const shows = timed.titles.filter((title) => title.kind === 'series');
  const anime = timed.titles.filter((title) => title.anime);
  const sum = (list: typeof timed.titles, pick: (title: (typeof timed.titles)[number]) => number) => list.reduce((total, title) => total + pick(title), 0);
  return {
    version: REVIEW_VERSION,
    year,
    timeZone,
    incomplete,
    counts: timed.counts,
    topShows: rankShows(timed).map((title) => title.key),
    network,
    anime: animeLayer,
    people,
    taste,
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

// The watchlist is counted as it stands when the review is built, from the merged shelves a client sees.
// The watchlist is only what it holds today, so only the current year reads it.
async function tasteOf(userUUID: string, historyKey: string, config: any, bounds: { from: number; to: number }, current: boolean): Promise<Taste> {
  const [dropped, watchlist] = await Promise.all([
    database.listDropped(userUUID, historyKey).catch(() => []),
    current ? require('../watchlist').watchlistEntries(userUUID, config).then((held: { entries: unknown[] }) => held.entries.length).catch(() => null) : null,
  ]);
  return { watchlist, dropped: (dropped as Array<{ updated_at: number }>).filter((row) => Number(row.updated_at) >= bounds.from && Number(row.updated_at) < bounds.to).length };
}

async function buildYear(userUUID: string, profile: string | null, year: number, waitedMs: number): Promise<void> {
  await asProfile(userUUID, profile, async (config) => {
    const timeZone = safeTimeZone(viewingTimeZone(config));
    const historyKey = profileKey(config);
    const started = Date.now();
    const fingerprint = await fingerprintOf(userUUID, historyKey, year, timeZone);
    const played = await yearPlays(userUUID, historyKey, year, timeZone, config);
    const bulk = played.filter((play) => play.batch);
    const timed = await timeYear(userUUID, historyKey, played.filter((play) => !play.batch), timeZone);
    let incomplete = timed.counts.unbuilt > 0;
    const lost = () => {
      incomplete = true;
      return null;
    };
    const animeLayer = animeYear(timed).catch(lost);
    const [progress, network, anime, people, taste] = await Promise.all([
      showProgress(userUUID, historyKey, yearBounds(year, timeZone).to, timed),
      networkOf(config, rankShows(timed)[0]),
      animeLayer,
      animeLayer.then((layer) => peopleYear(config, timed.titles, layer)).catch(lost),
      tasteOf(userUUID, historyKey, config, yearBounds(year, timeZone), year === localYear(Date.now(), timeZone)),
    ]);
    const builtAt = Date.now();
    const stored: Stored = { fingerprint, builtAt, data: summarise(year, timeZone, timed, progress, network, anime, people, taste, bulk, incomplete) };
    memory.set(reviewKey(userUUID, historyKey, year), stored);
    await database.putYearReview(userUUID, historyKey, year, fingerprint, builtAt, stored.data);
    const maxAgeMs = envInt('JELLYFIN_YEAR_REVIEW_FACTS_HOURS', 7 * 24, 1) * 60 * 60 * 1000;
    const pruned = await database.pruneTitleFacts(Date.now() - maxAgeMs).catch(() => 0);
    const { counts } = timed;
    logger.info(`${userUUID.slice(0, 8)} ${year}: ${timed.plays.length} plays, ${timed.titles.length} titles, facts ${counts.stored} stored, ${counts.held} cached, ${counts.built} built, ${counts.missing} missing, waited ${waitedMs}ms, built in ${builtAt - started}ms${pruned ? `, ${pruned} old facts pruned` : ''}`);
  });
}

function rebuild(key: string, userUUID: string, profile: string | null, year: number, reason: StaleReason): Ticket {
  const held = ticketFor(key);
  if (held) return held;
  rebuildReasons.set(key, reason);
  const ticket = enqueue(key, (waitedMs) => buildYear(userUUID, profile, year, waitedMs).finally(() => rebuildReasons.delete(key)));
  if (ticket.state === 'busy') rebuildReasons.delete(key);
  return ticket;
}

/** A save that changes how titles are named or dated starts this year's reviews again, so the next visit finds them done. */
export async function rebuildAfterSave(userUUID: string): Promise<void> {
  const rows: Array<{ profile: string; year: number; fingerprint: string }> = await database.listYearReviews(userUUID).catch(() => []);
  for (const row of rows) {
    const profile = row.profile || null;
    await asProfile(userUUID, profile, async (config) => {
      // A profile that has since started sharing the main history reads the main review.
      if (profileKey(config) !== row.profile) return;
      const timeZone = safeTimeZone(viewingTimeZone(config));
      if (row.year !== localYear(Date.now(), timeZone)) return;
      const key = reviewKey(userUUID, row.profile, row.year);
      if (!(await openedLately(key))) return;
      const held = memory.get(key)?.fingerprint ?? row.fingerprint;
      if (sameSetup(held, await fingerprintOf(userUUID, row.profile, row.year, timeZone))) return;
      const ticket = rebuild(key, userUUID, profile, row.year, 'settings');
      logger.debug(`${userUUID.slice(0, 8)} ${row.year}: settings changed, review ${ticket.state}`);
    });
  }
}

export async function dashboardYear(userUUID: string, profile: string | null, year: number, have: number | null = null): Promise<any | null> {
  return asProfile(userUUID, profile, async (config) => {
    const timeZone = safeTimeZone(viewingTimeZone(config));
    if (year > localYear(Date.now(), timeZone)) return { notBegun: true };
    const historyKey = profileKey(config);
    const key = reviewKey(userUUID, historyKey, year);
    markOpened(key);
    // While this review builds, a poll only asks how far it got, so what the build will settle is not worked out again.
    const inFlight = ticketFor(key);
    const building = inFlight?.state === 'queued' || inFlight?.state === 'building';
    const [fingerprint, years] = await Promise.all([building ? null : fingerprintOf(userUUID, historyKey, year, timeZone), yearsOf(userUUID, historyKey, timeZone)]);
    let stored = memory.get(key) ?? null;
    if (!stored) {
      stored = await database.getYearReview(userUUID, historyKey, year).catch(() => null);
      if (stored) memory.set(key, stored);
    }
    const settleMs = envInt('JELLYFIN_YEAR_REVIEW_MIN_REBUILD_MINUTES', 30, 0) * 60 * 1000;
    // A review a failed fetch or the build budget left short is built again once it has settled, though no play changed.
    const fresh = !building && stored?.fingerprint === fingerprint && !(stored.data?.incomplete && Date.now() - stored.builtAt >= settleMs);
    const recent = !building && !!stored && sameSetup(stored.fingerprint, fingerprint!) && Date.now() - stored.builtAt < settleMs;
    const settingsChanged = !!stored && !!fingerprint && !sameSetup(stored.fingerprint, fingerprint);
    const ticket = building ? inFlight : fresh || recent ? ticketFor(key) : rebuild(key, userUUID, profile, year, settingsChanged ? 'settings' : 'plays');
    const unchanged = !!stored && stored.builtAt === have;
    return {
      year,
      years,
      status: stored ? 'ready' : ticket?.state ?? 'queued',
      ...(ticket?.state === 'queued' ? { ahead: ticket.ahead } : {}),
      ...(ticket?.state === 'failed' ? { retryAt: ticket.retryAt } : {}),
      stale: !!stored && !fresh,
      staleBecause: stored && !fresh ? (rebuildReasons.get(key) ?? (settingsChanged ? 'settings' : 'plays')) : null,
      rebuilding: stored && ticket ? ticket.state : null,
      builtAt: stored?.builtAt ?? null,
      ...(unchanged ? { unchanged: true, data: null } : { data: stored?.data ?? null }),
      ...(building && unchanged ? {} : { ratings: stored?.data ? await ratingsOf(userUUID, historyKey, stored.data) : {} }),
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
