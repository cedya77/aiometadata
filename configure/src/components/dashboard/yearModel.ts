import type { JellyfinAnimeEntry, JellyfinYearData, JellyfinYearTitle } from "@/hooks/useDashboardQueries";
import { artAt } from "./art";

export interface YearPlay {
  title: JellyfinYearTitle;
  videoId: string;
  at: number;
  runtimeMs: number;
  catchUp: boolean;
  film: boolean;
  day: number;
  hour: number;
  weekday: number;
  month: number;
}

export interface YearModel {
  year: number;
  timeZone: string;
  data: JellyfinYearData;
  ratings: Record<string, number>;
  plays: YearPlay[];
  days: number;
  through: number;
  partial: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

function localParts(timeZone: string): (at: number) => { day: number; hour: number; weekday: number; month: number; year: number } {
  const format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hourCycle: "h23", weekday: "short" });
  return (at) => {
    const parts: Record<string, string> = {};
    for (const part of format.formatToParts(new Date(at))) parts[part.type] = part.value;
    const year = Number(parts.year);
    const month = Number(parts.month) - 1;
    return { year, month, day: Math.round((Date.UTC(year, month, Number(parts.day)) - Date.UTC(year, 0, 1)) / DAY_MS), hour: Number(parts.hour) % 24, weekday: WEEKDAYS[parts.weekday] ?? 0 };
  };
}

export function buildYearModel(data: JellyfinYearData, ratings: Record<string, number> = {}, now = Date.now()): YearModel {
  const local = localParts(data.timeZone);
  const plays: YearPlay[] = [];
  for (const title of data.titles) {
    for (const [videoId, at, runtimeMs, , overfull] of title.plays) {
      const parts = local(at);
      plays.push({ title, videoId, at, runtimeMs, catchUp: overfull === 1, film: title.kind === "movie", day: parts.day, hour: parts.hour, weekday: parts.weekday, month: parts.month });
    }
  }
  plays.sort((a, b) => a.at - b.at);
  const days = Math.round((Date.UTC(data.year + 1, 0, 1) - Date.UTC(data.year, 0, 1)) / DAY_MS);
  const today = local(now);
  const partial = today.year === data.year;
  return { year: data.year, timeZone: data.timeZone, data, ratings, plays, days, through: partial ? today.day : days - 1, partial };
}

// A show's key carries a mark when a film shares its number; the id it opens and names is without it.
export const metaIdOf = (key: string): string => (key.startsWith("series|") ? key.slice("series|".length) : key);

export const displayName = (title: JellyfinYearTitle): string => (title.name ?? metaIdOf(title.key)).replace(/\s+\(\d{4}\)$/, "");

export function localYearOf(at: number, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(new Date(at)));
}

export function episodeLabel(videoId: string): string | null {
  const parts = videoId.split(":");
  if (parts.length < 3) return null;
  const episode = Number(parts[parts.length - 1]);
  const season = Number(parts[parts.length - 2]);
  if (!Number.isFinite(episode)) return null;
  return Number.isFinite(season) ? `S${season} E${episode}` : `E${episode}`;
}

export function seasonOf(videoId: string): number | null {
  const parts = videoId.split(":");
  if (parts.length < 3) return null;
  const season = Number(parts[parts.length - 2]);
  return Number.isFinite(season) ? season : null;
}

export function dateOfDay(year: number, day: number): Date {
  return new Date(Date.UTC(year, 0, 1) + day * DAY_MS);
}

export function formatDay(year: number, day: number, withYear = false, month: "short" | "long" = "short"): string {
  return dateOfDay(year, day).toLocaleDateString(undefined, { timeZone: "UTC", month, day: "numeric", ...(withYear ? { year: "numeric" } : {}) });
}

export function formatHour(hour: number): string {
  return new Date(Date.UTC(2000, 0, 1, hour)).toLocaleTimeString(undefined, { timeZone: "UTC", hour: "numeric" });
}

export function formatPlayTime(at: number, timeZone: string): string {
  const date = new Date(at);
  return `${date.toLocaleTimeString(undefined, { timeZone, hour: "numeric", minute: "2-digit" })} ${date.toLocaleDateString(undefined, { timeZone, month: "short", day: "numeric" })}`;
}

export const WEEKDAY_NAMES = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "long" }));
export const WEEKDAY_SHORT = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short" }));
export const MONTH_NAMES = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2024, i, 1)).toLocaleDateString(undefined, { timeZone: "UTC", month: "long" }));

export const hoursOf = (ms: number): number => Math.round(ms / 3_600_000);

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

export function inWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999) return n.toLocaleString();
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  const rest = n % 100;
  return `${ONES[Math.floor(n / 100)]} hundred${rest ? ` and ${inWords(rest)}` : ""}`;
}

export const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The year's number one show, as the server ranked it. */
export function topShowOf(model: YearModel): JellyfinYearTitle | null {
  const byKey = new Map(model.data.titles.map((title) => [title.key, title]));
  return model.data.topShows.map((key) => byKey.get(key)).find((title): title is JellyfinYearTitle => !!title) ?? null;
}

export const byWatchTime = (model: YearModel): JellyfinYearTitle[] => [...model.data.titles].sort((a, b) => b.watchMs - a.watchMs);

export const rankedAnime = (model: YearModel): JellyfinAnimeEntry[] => [...(model.data.anime?.entries ?? [])].sort((a, b) => b.plays - a.plays || b.watchMs - a.watchMs);

/** The backdrop of the most watched title that has one. */
export const yearBackdrop = (model: YearModel): string | null => byWatchTime(model).find((title) => title.facts?.background)?.facts?.background ?? null;

/** Posters of the most watched titles, repeated to fill the wall when there are fewer. */
export function wallPosters(model: YearModel, count: number): string[] {
  const out: string[] = [];
  for (const title of byWatchTime(model)) {
    const poster = artAt(title.facts?.poster, "w342", 342);
    if (poster) out.push(poster);
    if (out.length === count) break;
  }
  while (out.length && out.length < count) out.push(...out.slice(0, count - out.length));
  return out;
}

export const finishedShows = (model: YearModel): number => model.data.titles.filter((title) => title.kind === "series" && title.progress && title.progress.aired > 0 && title.progress.seen >= title.progress.aired).length;

export function tasteStats(model: YearModel): Array<{ value: number; label: string }> {
  const titles = model.data.titles;
  const finished = finishedShows(model);
  const animeSeries = titles.filter((title) => title.anime && title.kind === "series").length;
  return [
    { value: finished, label: finished === 1 ? "show finished or caught up" : "shows finished or caught up" },
    { value: model.partial ? model.data.taste?.watchlist ?? 0 : 0, label: "waiting on your watchlist" },
    { value: model.data.taste?.dropped ?? 0, label: model.data.taste?.dropped === 1 ? "show dropped" : "shows dropped" },
    { value: animeSeries, label: "anime series" },
  ].filter((stat) => stat.value > 0);
}

interface Week {
  start: number;
  episodes: number;
  films: number;
  catchUp: number;
}

function timeOf(model: YearModel) {
  const lastWeek = Math.floor(model.through / 7);
  const weeks: Week[] = Array.from({ length: lastWeek + 1 }, (_, i) => ({ start: i * 7, episodes: 0, films: 0, catchUp: 0 }));
  const hours = new Array<number>(24).fill(0);
  const weekdays = new Array<number>(7).fill(0);
  const months = new Array<number>(12).fill(0);
  const catchUpDays = new Array<Set<number>>(12).fill(null as never).map(() => new Set<number>());
  const catchUpPlays = new Array<number>(12).fill(0);
  const catchUpFilms = new Array<number>(12).fill(0);
  const days = new Map<number, number>();
  let rhythm = 0;
  for (const play of model.plays) {
    const week = weeks[Math.min(lastWeek, Math.floor(play.day / 7))];
    if (play.catchUp) week.catchUp += 1;
    else if (play.film) week.films += 1;
    else week.episodes += 1;
    months[play.month] += 1;
    days.set(play.day, (days.get(play.day) ?? 0) + 1);
    if (play.catchUp) {
      catchUpDays[play.month].add(play.day);
      catchUpPlays[play.month] += 1;
      if (play.film) catchUpFilms[play.month] += 1;
      continue;
    }
    rhythm += 1;
    hours[play.hour] += 1;
    weekdays[play.weekday] += 1;
  }
  const sorted = [...days.keys()].sort((a, b) => a - b);
  let streak = { length: 0, from: 0, to: 0 };
  let runFrom = sorted[0] ?? 0;
  for (let i = 0; i < sorted.length; i += 1) {
    if (i > 0 && sorted[i] !== sorted[i - 1] + 1) runFrom = sorted[i];
    const length = sorted[i] - runFrom + 1;
    if (length > streak.length) streak = { length, from: runFrom, to: sorted[i] };
  }
  const peak = (list: number[]) => list.reduce((best, n, i) => (n > list[best] ? i : best), 0);
  const busiestMonth = peak(months);
  const afterDark = [18, 19, 20, 21, 22, 23, 0, 1, 2, 3].reduce((sum, h) => sum + hours[h], 0);
  return {
    weeks,
    hours,
    weekdays,
    rhythm,
    streak,
    activeDays: days.size,
    peakHour: peak(hours),
    peakDay: peak(weekdays),
    busiestMonth,
    busiestPlays: months[busiestMonth],
    busiestCatchUpDays: catchUpDays[busiestMonth].size,
    busiestCatchUpPlays: catchUpPlays[busiestMonth],
    busiestCatchUpEpisodesOnly: catchUpFilms[busiestMonth] === 0,
    playsOnDay: days,
    afterMidnight: hours[0] + hours[1] + hours[2] + hours[3],
    afterDark: rhythm > 0 && afterDark / rhythm > 0.5,
  };
}

export type YearTime = ReturnType<typeof timeOf>;

const times = new WeakMap<YearModel, YearTime>();

/** When the year's plays happened: by week, hour, weekday and month, with the longest run of days. Worked out once per model. */
export function yearTime(model: YearModel): YearTime {
  let time = times.get(model);
  if (!time) times.set(model, (time = timeOf(model)));
  return time;
}

/** The genres carried by the most plays, each as its share of all plays. */
export function genreShares(model: YearModel, limit: number): Array<readonly [string, number]> {
  const plays = new Map<string, number>();
  let total = 0;
  for (const title of model.data.titles) {
    total += title.plays.length;
    for (const genre of new Set(title.facts?.genres ?? [])) plays.set(genre, (plays.get(genre) ?? 0) + title.plays.length);
  }
  return [...plays].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, n]) => [name, total ? Math.round((n / total) * 100) : 0] as const);
}
