// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
export type WindowJob = 'CATALOG_WARMUP' | 'MAL_WARMUP' | 'CACHE_CLEANUP';

export interface RunWindow {
  start: number;
  end: number;
  utc: boolean;
  text: string;
}

const QUIET_HOURS: Record<WindowJob, { enabled: string; range: string; fallback: string; pauses: boolean; utc: boolean }> = {
  CATALOG_WARMUP: { enabled: 'CATALOG_WARMUP_QUIET_HOURS_ENABLED', range: 'CATALOG_WARMUP_QUIET_HOURS', fallback: '02:00-06:00', pauses: true, utc: false },
  MAL_WARMUP: { enabled: 'MAL_WARMUP_QUIET_HOURS_ENABLED', range: 'MAL_WARMUP_QUIET_HOURS_RANGE', fallback: '2-8', pauses: false, utc: true },
  CACHE_CLEANUP: { enabled: 'CACHE_CLEANUP_QUIET_HOURS_ENABLED', range: 'CACHE_CLEANUP_QUIET_HOURS', fallback: '02:00-06:00', pauses: true, utc: false },
};

export const WINDOW_JOBS = Object.keys(QUIET_HOURS) as WindowJob[];

export function quietHoursKeys(job: WindowJob): { enabled: string; range: string } {
  return { enabled: QUIET_HOURS[job].enabled, range: QUIET_HOURS[job].range };
}

function hourOf(part: string): number | null {
  const match = /^\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(part);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  if (hours > 24 || minutes > 59 || (hours === 24 && minutes > 0)) return null;
  return (hours % 24) + minutes / 60;
}

function parse(text: string, utc: boolean): RunWindow | null {
  const parts = text.split('-');
  if (parts.length !== 2) return null;
  const start = hourOf(parts[0]);
  const end = hourOf(parts[1]);
  if (start === null || end === null || start === end) return null;
  return { start, end, utc, text: text.trim() };
}

function clock(hours: number): string {
  const total = Math.round((((hours % 24) + 24) % 24) * 60);
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function isWindowValue(value: string): boolean {
  return value.trim() === '' || parse(value, false) !== null;
}

function fromQuietHours(job: WindowJob, enabled: string | undefined, range: string | undefined): RunWindow | null {
  if (enabled !== 'true') return null;
  const legacy = QUIET_HOURS[job];
  const quiet = parse(range?.trim() || legacy.fallback, legacy.utc);
  if (!quiet) return null;
  return legacy.pauses
    ? { start: quiet.end, end: quiet.start, utc: quiet.utc, text: `${clock(quiet.end)}-${clock(quiet.start)}` }
    : { ...quiet, text: `${clock(quiet.start)}-${clock(quiet.end)}` };
}

export function windowSettingFromQuietHours(job: WindowJob, enabled: string | undefined, range: string | undefined): string | null {
  const window = fromQuietHours(job, enabled, range);
  if (!window) return null;
  if (!window.utc) return window.text;
  const offset = -new Date().getTimezoneOffset() / 60;
  return `${clock(window.start + offset)}-${clock(window.end + offset)}`;
}

export function runWindow(job: WindowJob): RunWindow | null {
  const set = process.env[`${job}_WINDOW`]?.trim();
  if (set) return parse(set, false);
  const legacy = QUIET_HOURS[job];
  return fromQuietHours(job, process.env[legacy.enabled], process.env[legacy.range]);
}

function hourAt(window: RunWindow, at: Date): number {
  return window.utc ? at.getUTCHours() + at.getUTCMinutes() / 60 : at.getHours() + at.getMinutes() / 60;
}

export function insideWindow(window: RunWindow | null, at: Date = new Date()): boolean {
  if (!window) return true;
  const now = hourAt(window, at);
  return window.start < window.end ? now >= window.start && now < window.end : now >= window.start || now < window.end;
}

export function msUntilWindow(window: RunWindow | null, at: Date = new Date()): number {
  if (!window || insideWindow(window, at)) return 0;
  const hours = (window.start - hourAt(window, at) + 24) % 24;
  return Math.max(60_000, Math.round(hours * 3_600_000) - at.getSeconds() * 1000 - at.getMilliseconds());
}
