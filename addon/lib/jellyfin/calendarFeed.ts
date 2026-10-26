import crypto from 'crypto';
import { envInt } from '../../utils/envNumber';
import { listProfiles } from './profiles';

const database: any = require('../database');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EVENT_MS = 30 * 60 * 1000;

const profileColumn = (profile: string | null): string => profile ?? '';

export async function calendarFeedSecret(userUUID: string, profile: string | null): Promise<string | null> {
  return database.getCalendarFeed(userUUID, profileColumn(profile));
}

function withViewer<T>(userUUID: string, profile: string | null, work: (config: any, name: string) => Promise<T | null>): Promise<T | null> {
  const { runInViewerScope } = require('./viewer');
  const { loadConfig } = require('./context');
  return runInViewerScope(false, async () => {
    const config = await loadConfig({ jellyfin: { userUUID, profileId: profile } }).catch(() => null);
    const viewer = config ? listProfiles(config, userUUID).find((p) => p.id === profile) : null;
    return viewer ? work(config, viewer.name) : null;
  });
}

export async function issueCalendarFeed(userUUID: string, profile: string | null): Promise<string | null> {
  return withViewer(userUUID, profile, async () => {
    const secret = crypto.randomBytes(24).toString('base64url');
    await database.saveCalendarFeed(userUUID, profileColumn(profile), secret);
    return secret;
  });
}

export async function revokeCalendarFeed(userUUID: string, profile: string | null): Promise<void> {
  await database.deleteCalendarFeed(userUUID, profileColumn(profile));
}

const escapeText = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

function fold(line: string): string {
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += bytes;
  }
  out.push(current);
  return out.join('\r\n ');
}

const stamp = (at: number): string => new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateOnly = (at: number): string => new Date(at).toISOString().slice(0, 10).replace(/-/g, '');

function isDateOnly(at: number): boolean {
  const date = new Date(at);
  return date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0;
}

function summaryOf(item: any): string {
  const watched = item?.UserData?.Played === true ? '✓ ' : '';
  if (item?.Type !== 'Episode') return `${watched}${item?.Name ?? ''}`;
  const season = Number.isFinite(item.ParentIndexNumber) ? `S${item.ParentIndexNumber}` : '';
  const number = Number.isFinite(item.IndexNumber) ? `E${item.IndexNumber}` : '';
  const code = `${season}${number}`;
  const name = item.Name && !/^(Episode \d+|TBA|TBD)$/i.test(item.Name.trim()) ? `: ${item.Name}` : '';
  return `${watched}${item.SeriesName ?? ''}${code ? ` ${code}` : ''}${name}`;
}

function eventOf(item: any, now: number): string[] | null {
  const at = Date.parse(item?.PremiereDate || '');
  if (!Number.isFinite(at) || !item?.Id) return null;
  const runtime = Number(item.RunTimeTicks) / 10_000;
  const lines = [
    'BEGIN:VEVENT',
    `UID:${item.Id}@aiometadata`,
    `DTSTAMP:${stamp(now)}`,
  ];
  if (isDateOnly(at)) {
    lines.push(`DTSTART;VALUE=DATE:${dateOnly(at)}`, `DTEND;VALUE=DATE:${dateOnly(at + DAY_MS)}`);
  } else {
    lines.push(`DTSTART:${stamp(at)}`, `DTEND:${stamp(at + (runtime > 0 ? runtime : DEFAULT_EVENT_MS))}`);
  }
  lines.push(`SUMMARY:${escapeText(summaryOf(item))}`);
  if (item.Overview) lines.push(`DESCRIPTION:${escapeText(String(item.Overview))}`);
  lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  return lines;
}

export function renderCalendar(name: string, items: any[], now = Date.now()): string {
  const refresh = envInt('JELLYFIN_CALENDAR_FEED_REFRESH_MINUTES', 60, 5);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AIOMetadata//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    `X-PUBLISHED-TTL:PT${refresh}M`,
    `REFRESH-INTERVAL;VALUE=DURATION:PT${refresh}M`,
  ];
  for (const item of items) {
    const event = eventOf(item, now);
    if (event) lines.push(...event);
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

export async function calendarFeed(secret: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(secret)) return null;
  const held = await database.findCalendarFeed(secret);
  if (!held) return null;
  const userUUID = String(held.user_uuid);
  const profile = held.profile ? String(held.profile) : null;
  return withViewer(userUUID, profile, async (config, name) => {
    const { readCalendar } = require('./index');
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const from = today - envInt('JELLYFIN_CALENDAR_FEED_PAST_DAYS', 30, 0) * DAY_MS;
    const to = today + (envInt('JELLYFIN_CALENDAR_FUTURE_DAYS', 365, 1) + 1) * DAY_MS;
    const items: any[] | null = await readCalendar(userUUID, config, from, to, true);
    return items ? renderCalendar(`${name}'s calendar`, items) : null;
  });
}
