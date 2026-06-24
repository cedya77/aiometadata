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
  service?: string;
}

export interface LogQueryFilters {
  afterCursor?: number;
  level?: string;
  tag?: string;
  search?: string;
  service?: string;
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

// Dual-bounded: byte cap keeps memory predictable regardless of log volume, the
// entry cap is a secondary ceiling. Oldest entries are evicted when either is hit.
const MAX_ENTRIES = parseInt(process.env.LOG_BUFFER_MAX_ENTRIES || process.env.LOG_BUFFER_SIZE || '100000', 10);
const MAX_BYTES = parseInt(process.env.LOG_BUFFER_MAX_BYTES || String(64 * 1024 * 1024), 10);
const ARG_DETAIL_MAX = 20000;

const buffer: (LogEntry | null)[] = new Array(MAX_ENTRIES).fill(null);
const sizes: number[] = new Array(MAX_ENTRIES).fill(0);
let head = 0;        // index of the oldest live entry
let count = 0;       // number of live entries
let totalBytes = 0;  // summed byte estimate of live entries
let nextId = 1;
const tagSet = new Set<string>();
const serviceSet = new Set<string>();

type LogSubscriber = (entry: LogEntry) => void;
const subscribers = new Set<LogSubscriber>();

// ---- redaction (strip secrets before anything is stored or streamed) ----
const SECRET_ENV_KEYS = [
  'ADMIN_KEY', 'TMDB_API', 'BUILT_IN_TMDB_API_KEY', 'MDBLIST_API_KEY',
  'RPDB_API_KEY', 'SIMKL_CLIENT_ID', 'SIMKL_CLIENT_SECRET',
  'TRAKT_CLIENT_ID', 'TRAKT_CLIENT_SECRET', 'ANILIST_CLIENT_SECRET',
  'GITHUB_PAT', 'GITHUB_TOKEN',
];
let secretValues: string[] = [];
function refreshSecrets(): void {
  const found: string[] = [];
  for (const k of SECRET_ENV_KEYS) {
    const v = process.env[k];
    if (v && v.length >= 6) found.push(v);
  }
  secretValues = found;
}
refreshSecrets();

const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/g, '$1***'],
  [/(bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1***'],
  [/\b(api[_-]?key|apikey|access[_-]?token|token|secret|password|client_secret)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-]{6,}/gi, '$1$2***'],
  [/([?&](?:api_?key|apikey|token|key|password|client_secret|access_token)=)[^&\s"'#]+/gi, '$1***'],
];

function redact(s: string): string {
  if (!s) return s;
  let out = s;
  for (const v of secretValues) {
    if (out.includes(v)) out = out.split(v).join('***');
  }
  for (const [re, repl] of REDACTION_PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}

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

function entryByteSize(e: LogEntry): number {
  return (e.message ? e.message.length : 0)
    + (e.args ? e.args.length : 0)
    + (e.tag ? e.tag.length : 0)
    + (e.userId ? e.userId.length : 0)
    + (e.service ? e.service.length : 0)
    + 80; // fixed overhead for id/timestamp/level/object scaffolding
}

function mod(n: number): number {
  return ((n % MAX_ENTRIES) + MAX_ENTRIES) % MAX_ENTRIES;
}

function pushEntry(entry: LogEntry): void {
  const size = entryByteSize(entry);
  if (count === MAX_ENTRIES) {
    // buffer full: overwrite the oldest slot, then advance head
    totalBytes -= sizes[head];
    buffer[head] = entry;
    sizes[head] = size;
    totalBytes += size;
    head = mod(head + 1);
  } else {
    const tail = mod(head + count);
    buffer[tail] = entry;
    sizes[tail] = size;
    totalBytes += size;
    count++;
  }
  // byte-cap eviction: drop oldest until under MAX_BYTES (always keep at least one)
  while (totalBytes > MAX_BYTES && count > 1) {
    totalBytes -= sizes[head];
    buffer[head] = null;
    sizes[head] = 0;
    head = mod(head + 1);
    count--;
  }
  broadcast(entry);
}

function broadcast(entry: LogEntry): void {
  if (subscribers.size === 0) return;
  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {
      // a faulty subscriber must never break logging
    }
  }
}

export function subscribeToLogs(fn: LogSubscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function buildLogFilter(opts: { level?: string; tag?: string; search?: string; service?: string } = {}): (entry: LogEntry) => boolean {
  const levelNum = opts.level ? LEVEL_LABEL_TO_NUM[opts.level.toLowerCase()] : undefined;
  const tag = opts.tag;
  const service = opts.service;
  const searchLower = opts.search ? opts.search.toLowerCase() : undefined;
  return (entry: LogEntry): boolean => {
    if (levelNum !== undefined && entry.level !== levelNum) return false;
    if (tag && entry.tag !== tag) return false;
    if (service && (entry.service || 'addon') !== service) return false;
    if (searchLower
      && !entry.message.toLowerCase().includes(searchLower)
      && !(entry.userId && entry.userId.toLowerCase().includes(searchLower))) return false;
    return true;
  };
}

export function getLogEntries(filters: LogQueryFilters = {}): { entries: LogEntry[]; cursor: number; newestId: number } {
  const { afterCursor = 0, level, tag, search, service, limit = 200 } = filters;
  const effectiveLimit = Math.min(Math.max(1, limit), 1000);
  const match = buildLogFilter({ level, tag, search, service });

  // Walk newest -> oldest. Ids are monotonic in write order, so once we pass the
  // cursor every older entry is too — the live-tail case is O(returned), not O(N).
  const collected: LogEntry[] = [];
  for (let i = 0; i < count; i++) {
    const entry = buffer[mod(head + count - 1 - i)];
    if (!entry) break;
    if (entry.id <= afterCursor) break;
    if (match(entry)) collected.push(entry);
    if (collected.length >= effectiveLimit) break;
  }
  collected.reverse();
  const cursor = collected.length > 0 ? collected[collected.length - 1].id : afterCursor;
  return { entries: collected, cursor, newestId: nextId - 1 };
}

export function getLogTags(): string[] {
  return Array.from(tagSet).sort();
}

export function getLogServices(): string[] {
  return Array.from(serviceSet).sort();
}

// Ingest a log line from a non-consola source (e.g. the bundled nginx poster
// cache). Best-effort: callers must never let a malformed line throw.
export function ingestExternalLog(opts: {
  service: string;
  level: number;
  levelLabel?: string;
  tag?: string;
  message: string;
  timestamp?: string;
}): void {
  const levelNum = typeof opts.level === 'number' ? opts.level : 3;
  const levelLabel = opts.levelLabel || LEVEL_MAP[levelNum] || 'info';
  let message = redact(opts.message || '');
  if (message.length > ARG_DETAIL_MAX) message = message.slice(0, ARG_DETAIL_MAX) + '… (truncated)';
  const tag = opts.tag || '';
  if (tag) tagSet.add(tag);
  if (opts.service) serviceSet.add(opts.service);
  pushEntry({
    id: nextId++,
    timestamp: opts.timestamp || new Date().toISOString(),
    level: levelNum,
    levelLabel,
    tag,
    message,
    service: opts.service,
  });
}

export function getBufferStats(): { size: number; capacity: number; bytes: number; maxBytes: number; oldestId: number; newestId: number } {
  const oldest = count > 0 ? (buffer[head]?.id ?? 0) : 0;
  return { size: count, capacity: MAX_ENTRIES, bytes: totalBytes, maxBytes: MAX_BYTES, oldestId: oldest, newestId: nextId - 1 };
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

  message = redact(message);
  if (args) args = redact(args);

  const tag = logObj.tag || '';
  const levelNum = typeof logObj.level === 'number' ? logObj.level : 3;
  const levelLabel = logObj.type || LEVEL_MAP[levelNum] || 'info';

  if (tag) tagSet.add(tag);
  serviceSet.add('addon');

  const ctx = requestContext.getStore();
  const entry: LogEntry = {
    id: nextId++,
    timestamp: (logObj.date || new Date()).toISOString(),
    level: levelNum,
    levelLabel,
    tag,
    message,
    service: 'addon',
    ...(args && { args }),
    ...(ctx?.userId && { userId: ctx.userId }),
  };

  pushEntry(entry);
}

export function installLogReporter(): void {
  refreshSecrets();
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
