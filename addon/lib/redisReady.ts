// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import redis from './redisClient';

const READY_EVENT_TIMEOUT_MS = parseInt(process.env.REDIS_READY_TIMEOUT_MS || '15000', 10);
const MAX_RETRY_DELAY_MS = 5_000;

export interface WaitingInfo {
  attempt: number;
  elapsedMs: number;
  status: string;
  reason: string;
}

export interface WaitOptions {
  readyTimeoutMs?: number;
  retryDelayMs?: (attempt: number) => number;
  onWaiting?: (info: WaitingInfo) => void;
  signal?: AbortSignal;
}

const defaultRetryDelay = (attempt: number): number =>
  Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** (attempt - 1));

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Redis wait aborted');
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Redis wait aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Resolves on `ready`; rejects (retryably) on `end` or when the attempt budget runs out. */
function waitForReadyEvent(client: any, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      client.off('ready', onReady);
      client.off('end', onEnd);
      signal?.removeEventListener('abort', onAbort);
    };

    const onReady = () => { cleanup(); resolve(); };
    const onEnd = () => { cleanup(); reject(new Error('Redis connection ended before becoming ready')); };
    const onAbort = () => { cleanup(); reject(new Error('Redis wait aborted')); };

    client.on('ready', onReady);
    client.on('end', onEnd);
    signal?.addEventListener('abort', onAbort, { once: true });

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Redis did not become ready within ${timeoutMs}ms (status: ${client.status})`));
    }, timeoutMs);
  });
}

const isBenignConnectError = (message: string): boolean =>
  message.includes('Redis is already connecting') || message.includes('Redis is already connected');

export async function waitForClientReady(client: any, options: WaitOptions = {}): Promise<void> {
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_EVENT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelay;
  const startedAt = Date.now();
  let attempt = 0;

  for (;;) {
    throwIfAborted(options.signal);

    if (String(client.status) === 'ready') {
      return;
    }

    attempt++;
    try {
      if (['wait', 'end', 'close'].includes(String(client.status))) {
        try {
          await client.connect();
        } catch (error: any) {
          if (!isBenignConnectError(error?.message || '')) {
            throw error;
          }
        }
      }

      if (String(client.status) === 'ready') {
        return;
      }

      await waitForReadyEvent(client, readyTimeoutMs, options.signal);
      return;
    } catch (error: any) {
      throwIfAborted(options.signal);

      options.onWaiting?.({
        attempt,
        elapsedMs: Date.now() - startedAt,
        status: String(client.status),
        reason: error?.message || String(error)
      });

      await sleep(retryDelayMs(attempt), options.signal);
    }
  }
}

/** Waits for the shared client. Resolves only when Redis is usable. */
export function waitForRedisReady(options: WaitOptions = {}): Promise<void> {
  return waitForClientReady(redis, options);
}
