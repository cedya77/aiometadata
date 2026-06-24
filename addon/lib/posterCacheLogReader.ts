import * as fs from 'node:fs';
import * as readline from 'node:readline';
import consola from 'consola';
import { ingestExternalLog } from './logBuffer.js';

const SERVICE = 'poster-cache';

// nginx access line (our 'cache' log_format):
//   1.2.3.4 - [24/Jun/2026:13:06:39 +0000] "GET /https:/... HTTP/1.1" 200 68072 HIT
const ACCESS_RE = /"[A-Z]+ [^"]*"\s+(\d{3})\s+\d+\s+(\S+)\s*$/;
// nginx error line:
//   2026/06/24 13:00:00 [warn] 18#18: *1 message...
const ERROR_RE = /^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d \[(\w+)\]\s*(.*)$/;

const NGINX_LEVEL: Record<string, number> = {
  emerg: 0, alert: 0, crit: 0, error: 0,
  warn: 1, notice: 3, info: 3, debug: 4,
};

function parseLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  const err = ERROR_RE.exec(trimmed);
  if (err) {
    const level = NGINX_LEVEL[err[1].toLowerCase()] ?? 1;
    ingestExternalLog({ service: SERVICE, level, message: err[2] || trimmed });
    return;
  }

  const acc = ACCESS_RE.exec(trimmed);
  if (acc) {
    const status = parseInt(acc[1], 10);
    const level = status >= 500 ? 0 : status >= 400 ? 1 : 3;
    ingestExternalLog({ service: SERVICE, level, message: trimmed });
    return;
  }

  ingestExternalLog({ service: SERVICE, level: 3, message: trimmed });
}

function attach(pipePath: string): void {
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(pipePath, { encoding: 'utf8' });
  } catch (e: any) {
    consola.warn(`[PosterCacheLogs] Could not open ${pipePath}: ${e?.message}`);
    return;
  }

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  rl.on('line', (line) => {
    try { parseLine(line); } catch { /* a bad line must never break ingestion */ }
  });

  const reopen = () => {
    rl.close();
    stream.destroy();
    // The entrypoint holds the pipe open, so EOF is not expected; reconnect
    // defensively in case nginx is restarted out from under us.
    setTimeout(() => attach(pipePath), 2000).unref?.();
  };
  stream.on('end', reopen);
  stream.on('error', (e: any) => {
    consola.debug(`[PosterCacheLogs] stream error: ${e?.message}`);
    reopen();
  });
}

export function startPosterCacheLogReader(): void {
  const pipePath = process.env.POSTER_CACHE_LOG_PIPE || '/var/log/nginx/poster-cache.pipe';
  if (!fs.existsSync(pipePath)) {
    consola.warn(`[PosterCacheLogs] pipe ${pipePath} not found; nginx logs will not appear in the dashboard`);
    return;
  }
  consola.info(`[PosterCacheLogs] streaming bundled poster-cache logs from ${pipePath}`);
  attach(pipePath);
}
