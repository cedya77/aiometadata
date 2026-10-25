export interface ViewingWindow {
  start: string;
  end: string;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function viewingWindowOf(value: unknown): ViewingWindow | null {
  const start = (value as any)?.start;
  const end = (value as any)?.end;
  if (typeof start !== 'string' || typeof end !== 'string' || !TIME.test(start) || !TIME.test(end) || start === end) return null;
  return { start, end };
}

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function minuteOfDay(timeZone: string, now: Date): number {
  const read = (zone: string) => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return part('hour') * 60 + part('minute');
  };
  try {
    return read(timeZone);
  } catch {
    return read('UTC');
  }
}

function inWindow(window: ViewingWindow, minute: number): boolean {
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function viewingTimeZone(config: any): string {
  return config?.timezone || process.env.TZ || 'UTC';
}

export function playbackAllowed(windows: ViewingWindow[] | undefined, timeZone: string, now = new Date()): boolean {
  if (!windows?.length) return true;
  const minute = minuteOfDay(timeZone, now);
  return windows.every((window) => inWindow(window, minute));
}
