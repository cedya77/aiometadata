// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { monitorEventLoopDelay } from 'node:perf_hooks';
import consola from 'consola';
import { envInt } from '../utils/envNumber';
import { onStall } from './stallProfiler';

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;

const logger = consola.withTag('EventLoop');

export interface EventLoopLag {
  meanMs: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  stallsOverSecond: number;
  sinceMs: number;
}

let histogram: IntervalHistogram | null = null;
let startedAt = 0;
let stalls = 0;
let lastMax = 0;
let timer: NodeJS.Timeout | null = null;
// Reset each second, so its max is the longest stall in that second alone.
let window: IntervalHistogram | null = null;

// Background work that says what it is doing, so a stall is logged beside it.
const activities: Array<() => string | null> = [];

export function registerStallActivity(describe: () => string | null): void {
  activities.push(describe);
}

function logStall(lateMs: number): void {
  const doing = activities
    .map((describe) => {
      try {
        return describe();
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  logger.warn(`Event loop stalled for ${lateMs}ms in the second before ${new Date().toISOString()}${doing.length ? `; ${doing.join('; ')}` : ''}`);
}

export function startEventLoopMonitor(): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  startedAt = Date.now();
  window = monitorEventLoopDelay({ resolution: 20 });
  window.enable();
  timer = setInterval(() => {
    if (!histogram) return;
    if (window) {
      const worst = Math.round(window.max / 1e6);
      window.reset();
      if (worst >= envInt('EVENT_LOOP_STALL_LOG_MS', 1000, 100)) {
        logStall(worst);
        onStall(worst);
      }
    }
    const max = histogram.max / 1e6;
    if (max > lastMax && max >= 1000) stalls += 1;
    lastMax = max;
  }, 1000);
  timer.unref?.();
}

export function eventLoopLag(): EventLoopLag | null {
  if (!histogram) return null;
  const ms = (value: number) => Math.round((value / 1e6) * 10) / 10;
  return {
    meanMs: ms(histogram.mean),
    p50Ms: ms(histogram.percentile(50)),
    p99Ms: ms(histogram.percentile(99)),
    maxMs: ms(histogram.max),
    stallsOverSecond: stalls,
    sinceMs: Date.now() - startedAt,
  };
}

export function stopEventLoopMonitor(): void {
  if (timer) clearInterval(timer);
  histogram?.disable();
  histogram = null;
  window?.disable();
  window = null;
  timer = null;
}

module.exports = { startEventLoopMonitor, eventLoopLag, stopEventLoopMonitor, registerStallActivity };
