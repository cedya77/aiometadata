// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
export type Closer = () => void | Promise<void>;

export type ShutdownPhase = 'traffic' | 'resource';

export interface RegisterOptions {
  phase?: ShutdownPhase;
}

export interface ShutdownOptions {
  timeoutMs?: number;
}

export interface ShutdownResult {
  closed: string[];
  failed: string[];
}

export function createShutdownSequence(options: ShutdownOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const entries: Array<{ name: string; close: Closer; phase: ShutdownPhase }> = [];
  let result: Promise<ShutdownResult> | null = null;

  async function closeOne(name: string, close: Closer): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(close),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${name} did not close within ${timeoutMs}ms`)), timeoutMs);
        })
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function runAll(): Promise<ShutdownResult> {
    const closed: string[] = [];
    const failed: string[] = [];

    const ordered = [
      ...entries.filter((entry) => entry.phase === 'traffic').reverse(),
      ...entries.filter((entry) => entry.phase === 'resource').reverse()
    ];

    for (const { name, close } of ordered) {
      if (await closeOne(name, close)) {
        closed.push(name);
      } else {
        failed.push(name);
      }
    }

    return { closed, failed };
  }

  return {
    register(name: string, close: Closer, options: RegisterOptions = {}): void {
      entries.push({ name, close, phase: options.phase ?? 'resource' });
    },

    run(): Promise<ShutdownResult> {
      if (!result) {
        result = runAll();
      }
      return result;
    }
  };
}
