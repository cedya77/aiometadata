import { AsyncLocalStorage } from 'node:async_hooks';
import consola from 'consola';

const requestContext = new AsyncLocalStorage<{ userId: string }>();

export function runWithRequestContext<T>(userId: string, fn: () => T): T {
  return requestContext.run({ userId }, fn);
}

export interface LogEntry {
  id: number;
  timestamp: string;
  level: number;
  levelLabel: string;
  tag: string;
  message: string;
  args?: string;
  userId?: string;
}

export interface LogQueryFilters {
  afterCursor?: number;
  level?: string;
  tag?: string;
  search?: string;
  limit?: number;
}

const LEVEL_MAP: Record<number, string> = {
  0: 'error',
  1: 'warn',
  2: 'log',
  3: 'info',
  4: 'debug',
  5: 'trace',
};

const LEVEL_LABEL_TO_NUM: Record<string, number> = {
  error: 0,
  fatal: 0,
  warn: 1,
  log: 2,
  info: 3,
  success: 3,
  debug: 4,
  trace: 5,
  verbose: 5,
};

const BUFFER_SIZE = parseInt(process.env.LOG_BUFFER_SIZE || '100000', 10);

let buffer: (LogEntry | null)[] = new Array(BUFFER_SIZE).fill(null);
let writeIndex = 0;
let nextId = 1;
const tagSet = new Set<string>();

const ARG_DETAIL_MAX = 20000;

function stringify(arg: unknown): string {
  if (arg === null || arg === undefined) return '';
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function prettyDetail(arg: unknown): string {
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg, null, 2);
  } catch {
    return String(arg);
  }
}

function pushEntry(entry: LogEntry): void {
  buffer[writeIndex] = entry;
  writeIndex = (writeIndex + 1) % BUFFER_SIZE;
}

export function getLogEntries(filters: LogQueryFilters = {}): { entries: LogEntry[]; cursor: number; newestId: number } {
  const { afterCursor = 0, level, tag, search, limit = 200 } = filters;
  const effectiveLimit = Math.min(Math.max(1, limit), 1000);
  const searchLower = search?.toLowerCase();
  const levelNum = level ? LEVEL_LABEL_TO_NUM[level.toLowerCase()] : undefined;

  const results: LogEntry[] = [];

  for (let i = 0; i < BUFFER_SIZE; i++) {
    const idx = (writeIndex + i) % BUFFER_SIZE;
    const entry = buffer[idx];
    if (!entry) continue;
    if (entry.id <= afterCursor) continue;
    if (levelNum !== undefined && entry.level !== levelNum) continue;
    if (tag && entry.tag !== tag) continue;
    if (searchLower && !entry.message.toLowerCase().includes(searchLower)
      && !(entry.userId && entry.userId.toLowerCase().includes(searchLower))) continue;
    results.push(entry);
  }

  const sliced = results.slice(-effectiveLimit);
  const cursor = sliced.length > 0 ? sliced[sliced.length - 1].id : afterCursor;

  return { entries: sliced, cursor, newestId: nextId - 1 };
}

export function getLogTags(): string[] {
  return Array.from(tagSet).sort();
}

export function getBufferStats(): { size: number; capacity: number; oldestId: number; newestId: number } {
  let oldest = Infinity;
  let newest = 0;
  let count = 0;
  for (let i = 0; i < BUFFER_SIZE; i++) {
    const entry = buffer[i];
    if (entry) {
      count++;
      if (entry.id < oldest) oldest = entry.id;
      if (entry.id > newest) newest = entry.id;
    }
  }
  return { size: count, capacity: BUFFER_SIZE, oldestId: oldest === Infinity ? 0 : oldest, newestId: newest };
}

function handleLogObj(logObj: any): void {
  const rawArgs: unknown[] = logObj.args || [];

  const messageParts: string[] = [];
  const detailParts: string[] = [];
  for (const arg of rawArgs) {
    if (arg === null || arg === undefined) continue;
    if (typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean') {
      const s = stringify(arg);
      if (s) messageParts.push(s);
    } else {
      detailParts.push(prettyDetail(arg));
    }
  }

  let message = messageParts.join(' ');
  let args: string | undefined = detailParts.length ? detailParts.join('\n') : undefined;
  if (!message && args) message = args.split('\n')[0].slice(0, 300);
  if (args && args.length > ARG_DETAIL_MAX) {
    args = args.slice(0, ARG_DETAIL_MAX) + '\n… (truncated)';
  }

  const tag = logObj.tag || '';
  const levelNum = typeof logObj.level === 'number' ? logObj.level : 3;
  const levelLabel = logObj.type || LEVEL_MAP[levelNum] || 'info';

  if (tag) tagSet.add(tag);

  const ctx = requestContext.getStore();
  const entry: LogEntry = {
    id: nextId++,
    timestamp: (logObj.date || new Date()).toISOString(),
    level: levelNum,
    levelLabel,
    tag,
    message,
    ...(args && { args }),
    ...(ctx?.userId && { userId: ctx.userId }),
  };

  pushEntry(entry);
}

export function installLogReporter(): void {
  // Patch the prototype so ALL consola instances (including withTag children
  // created before this runs) route through our buffer. addReporter() only
  // works for the root instance — child loggers snapshot reporters at creation.
  const proto = Object.getPrototypeOf(consola);
  const original = proto._log;
  proto._log = function patchedLog(logObj: any) {
    handleLogObj(logObj);
    return original.call(this, logObj);
  };
}
