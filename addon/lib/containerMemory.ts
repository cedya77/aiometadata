// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import * as fs from 'node:fs';

export interface ContainerMemory {
  source: 'cgroup-v2' | 'cgroup-v1' | null;
  currentBytes: number | null;
  limitBytes: number | null;
  peakBytes: number | null;
  usedPct: number | null;
  /** Reclaimable page cache is counted against the limit, so it is reported apart from anon. */
  breakdown: { anon: number | null; file: number | null; slab: number | null; shmem: number | null };
  /** Non-zero oomKills is the whole question answered: the kernel has killed something here. */
  events: { limitHits: number | null; oom: number | null; oomKills: number | null };
}

const read = (path: string): string | null => {
  try { return fs.readFileSync(path, 'utf8').trim(); } catch { return null; }
};

const num = (value: string | null): number | null => {
  if (value === null || value === 'max') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function fields(raw: string | null, wanted: string[]): Record<string, number | null> {
  const out: Record<string, number | null> = Object.fromEntries(wanted.map((k) => [k, null]));
  for (const line of (raw || '').split('\n')) {
    const [key, value] = line.split(' ');
    if (wanted.includes(key)) out[key] = num(value);
  }
  return out;
}

export function containerMemory(): ContainerMemory {
  const empty: ContainerMemory = {
    source: null, currentBytes: null, limitBytes: null, peakBytes: null, usedPct: null,
    breakdown: { anon: null, file: null, slab: null, shmem: null },
    events: { limitHits: null, oom: null, oomKills: null },
  };

  const v2 = read('/sys/fs/cgroup/memory.current');
  if (v2 !== null) {
    const stat = fields(read('/sys/fs/cgroup/memory.stat'), ['anon', 'file', 'slab', 'shmem']);
    const events = fields(read('/sys/fs/cgroup/memory.events'), ['max', 'oom', 'oom_kill']);
    const current = num(v2);
    const limit = num(read('/sys/fs/cgroup/memory.max'));
    return {
      source: 'cgroup-v2',
      currentBytes: current,
      limitBytes: limit,
      peakBytes: num(read('/sys/fs/cgroup/memory.peak')),
      usedPct: current !== null && limit ? Math.round((current / limit) * 1000) / 10 : null,
      breakdown: { anon: stat.anon, file: stat.file, slab: stat.slab, shmem: stat.shmem },
      events: { limitHits: events.max, oom: events.oom, oomKills: events.oom_kill },
    };
  }

  const v1 = read('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  if (v1 !== null) {
    const stat = fields(read('/sys/fs/cgroup/memory/memory.stat'), ['total_rss', 'total_cache']);
    const current = num(v1);
    // v1 reports no limit as a sentinel near the top of the address space.
    const raw = num(read('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
    const limit = raw !== null && raw < Number.MAX_SAFE_INTEGER / 2 ? raw : null;
    return {
      source: 'cgroup-v1',
      currentBytes: current,
      limitBytes: limit,
      peakBytes: num(read('/sys/fs/cgroup/memory/memory.max_usage_in_bytes')),
      usedPct: current !== null && limit ? Math.round((current / limit) * 1000) / 10 : null,
      breakdown: { anon: stat.total_rss, file: stat.total_cache, slab: null, shmem: null },
      events: { limitHits: num(read('/sys/fs/cgroup/memory/memory.failcnt')), oom: null, oomKills: null },
    };
  }

  return empty;
}

module.exports = { containerMemory };
