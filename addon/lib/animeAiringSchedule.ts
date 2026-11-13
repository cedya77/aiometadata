// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import { httpGet } from '../utils/httpClient';
import { getSetting } from './settingsService';

const logger = consola.withTag('AnimeSchedule');

export type ScheduleKind = 'earliest' | 'dub';

interface Snapshot {
  dates: Record<ScheduleKind, Map<number, Map<number, number>>>;
  malToAnilist: Map<number, number>;
  sourceUpdatedAt: number;
}

interface FeedFiles {
  feed: string;
  schedule: string;
}

// AniSchedule's "subbed" files are AniList's airing times, which are the earliest release anywhere.
const FILES: Record<ScheduleKind, FeedFiles> = {
  earliest: { feed: 'raw/sub-episode-feed.json', schedule: 'raw/sub-schedule.json' },
  dub: { feed: 'raw/dub-episode-feed.json', schedule: 'raw/v2/dub-schedule.json' },
};
const MANIFEST_SECTION: Record<ScheduleKind, string> = { earliest: 'subbed', dub: 'dubbed' };

let snapshot: Snapshot | null = null;
let manifestSeen: Record<ScheduleKind, string> = { earliest: '', dub: '' };
let lastCheck = 0;
let lastRefreshAt = 0;
let lastError = '';
let refreshing: Promise<void> | null = null;

function settingNumber(key: string, fallback: number): number {
  const value = Number(getSetting(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function baseUrl(): string {
  return (getSetting('ANIME_SCHEDULE_URL') || '').replace(/\/+$/, '');
}

async function fetchJson(path: string): Promise<any> {
  const response = await httpGet(`${baseUrl()}/${path}`, { timeout: 30000 });
  return typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
}

function record(dates: Map<number, Map<number, number>>, anilistId: unknown, episode: unknown, at: number): void {
  const id = Number(anilistId);
  const number = Number(episode);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(number) || number <= 0 || !Number.isFinite(at)) return;
  let episodes = dates.get(id);
  if (!episodes) dates.set(id, (episodes = new Map()));
  episodes.set(number, at);
}

function buildDates(feed: any[], schedule: any[], malToAnilist: Map<number, number>): Map<number, Map<number, number>> {
  const dates = new Map<number, Map<number, number>>();
  const noteMal = (entry: any) => {
    const mal = Number(entry?.idMal);
    if (Number.isInteger(mal) && mal > 0 && Number(entry?.id) > 0) malToAnilist.set(mal, Number(entry.id));
  };
  for (const entry of Array.isArray(feed) ? feed : []) {
    noteMal(entry);
    record(dates, entry?.id, entry?.episode?.aired, Date.parse(entry?.episode?.airedAt));
  }
  for (const entry of Array.isArray(schedule) ? schedule : []) {
    noteMal(entry);
    for (const node of entry?.airingSchedule?.nodes || []) {
      if (node?.delayed || node?.delayedIndefinitely) continue;
      record(dates, entry?.id, node?.episode, Number(node?.airingAt) * 1000);
    }
  }
  return dates;
}

async function refresh(): Promise<void> {
  const manifest = await fetchJson('raw/last-updated.json');
  const next: Snapshot = snapshot
    ? { dates: { ...snapshot.dates }, malToAnilist: new Map(snapshot.malToAnilist), sourceUpdatedAt: 0 }
    : { dates: { earliest: new Map(), dub: new Map() }, malToAnilist: new Map(), sourceUpdatedAt: 0 };
  const seen = { ...manifestSeen };

  for (const kind of Object.keys(FILES) as ScheduleKind[]) {
    const section = manifest?.[MANIFEST_SECTION[kind]] || {};
    const stamp = `${section.episodes || ''}|${section.schedule || ''}`;
    for (const value of [section.episodes, section.schedule]) {
      const at = Date.parse(value);
      if (Number.isFinite(at)) next.sourceUpdatedAt = Math.max(next.sourceUpdatedAt, at);
    }
    if (snapshot && stamp === manifestSeen[kind]) continue;
    const [feed, schedule] = await Promise.all([fetchJson(FILES[kind].feed), fetchJson(FILES[kind].schedule)]);
    next.dates[kind] = buildDates(feed, schedule, next.malToAnilist);
    seen[kind] = stamp;
  }

  snapshot = next;
  manifestSeen = seen;
  lastRefreshAt = Date.now();
  logger.debug(`Loaded ${next.dates.earliest.size} anime with release times and ${next.dates.dub.size} with dub times`);
}

function startRefresh(): Promise<void> {
  lastCheck = Date.now();
  refreshing = refresh()
    .then(() => { lastError = ''; })
    .catch((error: any) => {
      lastError = error?.message || String(error);
      throw error;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function initializeAnimeSchedule(): Promise<void> {
  if (!baseUrl() || snapshot) return;
  await (refreshing || startRefresh());
}

export function getAnimeScheduleStats() {
  return {
    enabled: !!baseUrl(),
    loaded: !!snapshot,
    running: !!refreshing,
    anime: snapshot?.dates.earliest.size || 0,
    dubbed: snapshot?.dates.dub.size || 0,
    lastCheck: lastCheck || null,
    lastRefreshAt: lastRefreshAt || null,
    sourceUpdatedAt: snapshot?.sourceUpdatedAt || null,
    stale: !!snapshot && Date.now() - snapshot.sourceUpdatedAt > settingNumber('ANIME_SCHEDULE_STALE_HOURS', 6) * 60 * 60 * 1000,
    refreshMinutes: settingNumber('ANIME_SCHEDULE_REFRESH_MINUTES', 15),
    lastError,
  };
}

/** Downloads every schedule file again, whatever the update file says. */
export async function forceUpdateAnimeSchedule(): Promise<{ success: boolean; count: number; message: string }> {
  if (!baseUrl()) return { success: false, count: 0, message: 'The anime release schedule source is turned off' };
  if (refreshing) await refreshing.catch(() => {});
  manifestSeen = { earliest: '', dub: '' };
  try {
    await startRefresh();
    const count = snapshot?.dates.earliest.size || 0;
    return { success: true, count, message: `Anime release schedule updated (${animeScheduleStats()})` };
  } catch (error: any) {
    return { success: false, count: 0, message: `Failed to update the anime release schedule: ${error?.message || error}` };
  }
}

export function animeScheduleStats(): string {
  if (!snapshot) return baseUrl() ? 'not loaded' : 'off';
  return `${snapshot.dates.earliest.size.toLocaleString()} anime, ${snapshot.dates.dub.size.toLocaleString()} with dub times`;
}

/** Starts a refresh when the last check is older than the refresh interval. Never waits for it. */
function refreshInBackground(): void {
  const interval = settingNumber('ANIME_SCHEDULE_REFRESH_MINUTES', 15) * 60 * 1000;
  if (refreshing || !baseUrl() || Date.now() - lastCheck < interval) return;
  startRefresh().catch((error: any) => logger.warn(`Could not refresh the anime release schedule: ${error?.message || error}`));
}

/** True when the published schedule has stopped updating, so the earliest times come from AniList directly. */
export function isStale(): boolean {
  refreshInBackground();
  // While the first download is still running there is nothing to call stale yet.
  if (!snapshot) return !baseUrl() || !refreshing;
  const maxAge = settingNumber('ANIME_SCHEDULE_STALE_HOURS', 6) * 60 * 60 * 1000;
  return Date.now() - snapshot.sourceUpdatedAt > maxAge;
}

export function anilistIdForMal(malId: unknown): number | null {
  const id = Number(malId);
  return snapshot?.malToAnilist.get(id) ?? null;
}

export function hasAnime(kind: ScheduleKind, anilistId: number): boolean {
  refreshInBackground();
  return !!snapshot?.dates[kind].has(anilistId);
}

export function releaseTime(kind: ScheduleKind, anilistId: number, episode: number): number | null {
  return snapshot?.dates[kind].get(anilistId)?.get(episode) ?? null;
}

/** Earliest release times straight from AniList, for when the published schedule is stale. */
export async function anilistReleaseTimes(anilistIds: number[]): Promise<Map<number, Map<number, number>>> {
  const ids = [...new Set(anilistIds)].filter((id) => Number.isInteger(id) && id > 0).sort((a, b) => a - b);
  const dates = new Map<number, Map<number, number>>();
  if (!ids.length) return dates;

  const { cacheWrapGlobal } = require('./getCache');
  const anilist = require('./anilist');
  const refreshSeconds = settingNumber('ANIME_SCHEDULE_REFRESH_MINUTES', 15) * 60;
  const now = Math.floor(Date.now() / 1000);
  const rows: any[] = await cacheWrapGlobal(`anime-schedule:anilist:${ids.join(',')}`, async () => {
    // A year back covers the episodes whose dates still matter; older ones are long out either way.
    return anilist.getAiringSchedules(ids, now - 365 * 86400, now + 365 * 86400);
  }, refreshSeconds).catch((error: any) => {
    logger.warn(`AniList airing times unavailable: ${error?.message || error}`);
    return [];
  });

  for (const row of rows || []) record(dates, row?.mediaId, row?.episode, Number(row?.airingAt) * 1000);
  return dates;
}
