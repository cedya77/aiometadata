// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import inspector from 'node:inspector';
import path from 'node:path';
import consola from 'consola';
import { envInt } from '../utils/envNumber';

const logger = consola.withTag('EventLoop');

const SAMPLE_INTERVAL_US = 10000;
const TOP_ENTRIES = 6;
const MAX_NOTED = 30;
const STARTUP_GRACE_MS = 1000;
const OWN_FRAMES = 3;

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}

interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  children?: number[];
}

interface Stall {
  at: number;
  lateMs: number;
}

interface Profile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

let session: inspector.Session | null = null;
let running = false;
let busy = false;
let disabled = false;
let windowEndsAt = 0;
let quietUntil = 0;
let windowTimer: NodeJS.Timeout | null = null;
let startedAt = 0;
let stalls: Stall[] = [];
let dropped = 0;

function windowSeconds(): number {
  return envInt('EVENT_LOOP_STALL_PROFILE_SECONDS', 120, 0);
}

function cooldownSeconds(): number {
  return envInt('EVENT_LOOP_STALL_PROFILE_COOLDOWN', 600, 0);
}

function longStallMs(): number {
  return envInt('EVENT_LOOP_STALL_PROFILE_LONG_MS', 5000, 0);
}

function longWindowSeconds(): number {
  return envInt('EVENT_LOOP_STALL_PROFILE_LONG_SECONDS', 1800, 0);
}

function isLong(lateMs: number): boolean {
  return longStallMs() > 0 && lateMs >= longStallMs() && longWindowSeconds() > 0;
}

function post<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    session!.post(method, params, (error: Error | null, result: any) => (error ? reject(error) : resolve(result)));
  });
}

async function start(): Promise<void> {
  if (!session) {
    session = new inspector.Session();
    session.connect();
  }
  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', { interval: SAMPLE_INTERVAL_US });
  await post('Profiler.start');
  running = true;
}

async function stop(): Promise<Profile | null> {
  if (!running) return null;
  running = false;
  const { profile } = await post<{ profile: Profile }>('Profiler.stop');
  return profile;
}

function isOwn(frame: CallFrame): boolean {
  return !!frame.url && !frame.url.startsWith('node:') && !frame.url.includes('node_modules');
}

function frameLabel(frame: CallFrame): string {
  const where = frame.url ? ` (${path.basename(frame.url)}:${frame.lineNumber + 1})` : '';
  return `${frame.functionName || '(anonymous)'}${where}`;
}

function sampleLabel(leaf: number, nodes: Map<number, ProfileNode>, parents: Map<number, number>): string {
  const frame = nodes.get(leaf)!.callFrame;
  if (frame.functionName === '(garbage collector)') return 'garbage collection';
  if (frame.functionName === '(program)') return 'native work outside JavaScript';

  const own: string[] = [];
  for (let id: number | undefined = leaf; id !== undefined && own.length < OWN_FRAMES; id = parents.get(id)) {
    const current = nodes.get(id)!.callFrame;
    if (isOwn(current)) own.push(frameLabel(current));
  }
  if (!own.length) return frameLabel(frame);
  return isOwn(frame) ? own.join(' < ') : `${own.join(' < ')} [in ${frameLabel(frame)}]`;
}

function describeStall(profile: Profile, stoppedAt: number, stall: Stall): string | null {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);

  const times: number[] = [];
  let at = profile.startTime;
  for (const delta of profile.timeDeltas) times.push((at += delta));
  const to = profile.endTime - (stoppedAt - stall.at) * 1000;
  const from = to - (stall.lateMs + 1500) * 1000;

  let best: [number, number] | null = null;
  let runStart = -1;
  for (let i = 0; i <= profile.samples.length; i++) {
    const idle = i === profile.samples.length || times[i] < from || times[i] > to
      || nodes.get(profile.samples[i])!.callFrame.functionName === '(idle)';
    if (!idle && runStart < 0) runStart = i;
    if (idle && runStart >= 0) {
      if (!best || times[i - 1] - times[runStart] > times[best[1]] - times[best[0]]) best = [runStart, i - 1];
      runStart = -1;
    }
  }
  if (!best) return null;

  const spent = new Map<string, number>();
  for (let i = best[0]; i <= best[1]; i++) {
    const label = sampleLabel(profile.samples[i], nodes, parents);
    spent.set(label, (spent.get(label) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  }
  const busyMs = Math.round((times[best[1]] - times[best[0]]) / 1000 + SAMPLE_INTERVAL_US / 1000);
  const began = new Date(stoppedAt - (profile.endTime - times[best[0]]) / 1000).toISOString();
  const top = [...spent.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_ENTRIES)
    .map(([label, ms]) => `${Math.round(ms)}ms ${label}`);
  return `Stall of ${stall.lateMs}ms profiled: busiest stretch ${busyMs}ms from ${began}; ${top.join('; ')}`;
}

function openWindow(seconds: number): void {
  windowEndsAt = Math.max(windowEndsAt, Date.now() + seconds * 1000);
  if (windowTimer) clearTimeout(windowTimer);
  windowTimer = setTimeout(endWindow, windowEndsAt - Date.now());
  windowTimer.unref?.();
}

function endWindow(): void {
  if (windowTimer) clearTimeout(windowTimer);
  windowTimer = null;
  windowEndsAt = 0;
  quietUntil = Date.now() + cooldownSeconds() * 1000;
  const noted = stalls.splice(0);
  const skipped = dropped;
  dropped = 0;
  busy = true;
  stop()
    .then((profile) => {
      const stoppedAt = Date.now();
      if (!profile) return;
      for (const stall of noted) {
        const line = describeStall(profile, stoppedAt, stall);
        if (line) logger.warn(line);
      }
      if (skipped) logger.warn(`${skipped} more stalls in this profile were not described`);
    })
    .catch(() => undefined)
    .finally(() => { busy = false; });
}

function giveUp(error: any): void {
  disabled = true;
  running = false;
  logger.warn(`Stall profiling unavailable: ${error?.message || error}`);
}

function note(lateMs: number): void {
  const now = Date.now();
  if (now - lateMs < startedAt + STARTUP_GRACE_MS) return;
  stalls.push({ at: now, lateMs });
  if (stalls.length > MAX_NOTED) {
    stalls.sort((a, b) => b.lateMs - a.lateMs);
    stalls.pop();
    dropped += 1;
    stalls.sort((a, b) => a.at - b.at);
  }
}

export function onStall(lateMs: number): void {
  if (disabled || windowSeconds() <= 0) return;

  if (running) {
    note(lateMs);
    if (isLong(lateMs)) openWindow(longWindowSeconds());
    return;
  }

  if (busy || (Date.now() < quietUntil && !isLong(lateMs))) return;
  busy = true;
  start()
    .then(() => {
      startedAt = Date.now();
      openWindow(isLong(lateMs) ? longWindowSeconds() : windowSeconds());
      if (isLong(lateMs)) logger.info(`Profiling the next ${longWindowSeconds()}s after a ${lateMs}ms stall, in case it comes back`);
    })
    .catch(giveUp)
    .finally(() => { busy = false; });
}
