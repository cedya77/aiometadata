import type { JellyfinYearData, JellyfinYearTitle } from "@/hooks/useDashboardQueries";

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
