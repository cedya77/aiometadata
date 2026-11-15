// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import diagnostics from 'node:diagnostics_channel';
import dns from 'node:dns';
import consola from 'consola';
import { envInt } from '../utils/envNumber';

const logger = consola.withTag('HTTP-Timing');

interface Timing {
  start: number;
  sent?: number;
  headers?: number;
  dnsProbe?: string;
  probeTimer?: NodeJS.Timeout;
}

const timings = new WeakMap<object, Timing>();
let installed = false;

function threshold(): number {
  return envInt('HTTP_SLOW_LOG_MS', 2000, 0);
}

function describe(request: any): string {
  const origin = String(request?.origin ?? '').replace(/^https?:\/\//, '');
  const path = String(request?.path ?? '').split('?')[0];
  return `${request?.method ?? 'GET'} ${origin}${path}`;
}

function probeDns(request: any, timing: Timing): void {
  let hostname = '';
  try {
    hostname = new URL(String(request?.origin ?? '')).hostname;
  } catch {
    return;
  }
  if (!hostname) return;
  const started = Date.now();
  dns.lookup(hostname, { all: true }, (error) => {
    timing.dnsProbe = `${hostname} lookup ${Date.now() - started}ms${error ? ` (${error.code ?? error.message})` : ''}`;
  });
}

function finish(request: any, error: any): void {
  const timing = timings.get(request);
  if (!timing) return;
  timings.delete(request);
  if (timing.probeTimer) clearTimeout(timing.probeTimer);
  const now = Date.now();
  const total = now - timing.start;
  if (!error && total < threshold()) return;
  const parts = [
    `waiting for a connection ${(timing.sent ?? now) - timing.start}ms`,
    timing.sent ? `server ${(timing.headers ?? now) - timing.sent}ms` : null,
    timing.headers ? `body ${now - timing.headers}ms` : null,
    timing.dnsProbe ? `DNS probe: ${timing.dnsProbe}` : null,
  ].filter(Boolean);
  const outcome = error ? `failed after ${total}ms (${error?.code ?? error?.name ?? 'error'})` : `took ${total}ms`;
  logger.warn(`${describe(request)} ${outcome}: ${parts.join(', ')}`);
}

export function startHttpTiming(): void {
  if (installed) return;
  installed = true;

  diagnostics.subscribe('undici:request:create', ({ request }: any) => {
    const limit = threshold();
    if (limit <= 0) return;
    const timing: Timing = { start: Date.now() };
    timing.probeTimer = setTimeout(() => {
      if (!timing.sent) probeDns(request, timing);
    }, limit);
    timing.probeTimer.unref();
    timings.set(request, timing);
  });
  diagnostics.subscribe('undici:client:sendHeaders', ({ request }: any) => {
    const timing = timings.get(request);
    if (timing && !timing.sent) timing.sent = Date.now();
  });
  diagnostics.subscribe('undici:request:headers', ({ request }: any) => {
    const timing = timings.get(request);
    if (timing) timing.headers = Date.now();
  });
  diagnostics.subscribe('undici:request:trailers', ({ request }: any) => finish(request, null));
  diagnostics.subscribe('undici:request:error', ({ request, error }: any) => finish(request, error));
}
