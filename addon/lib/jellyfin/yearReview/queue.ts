import consola from 'consola';
import { envInt } from '../../../utils/envNumber';

const logger = consola.withTag('YearReview');

export type Ticket = { state: 'queued'; ahead: number } | { state: 'building' } | { state: 'busy' } | { state: 'failed'; retryAt: number };

type Job = { key: string; work: (waitedMs: number) => Promise<void>; queuedAt: number };

const waiting: Job[] = [];
const running = new Set<string>();
// A build that threw waits before it is tried again, longer each time, so a page left open does not rerun it on every poll.
const failures = new Map<string, { count: number; retryAt: number }>();

export function ticketFor(key: string): Ticket | null {
  if (running.has(key)) return { state: 'building' };
  const at = waiting.findIndex((job) => job.key === key);
  if (at >= 0) return { state: 'queued', ahead: at + running.size };
  const failed = failures.get(key);
  return failed && failed.retryAt > Date.now() ? { state: 'failed', retryAt: failed.retryAt } : null;
}

export function enqueue(key: string, work: (waitedMs: number) => Promise<void>): Ticket {
  const held = ticketFor(key);
  if (held) return held;
  if (waiting.length >= envInt('JELLYFIN_YEAR_REVIEW_QUEUE_MAX', 50, 1)) return { state: 'busy' };
  waiting.push({ key, work, queuedAt: Date.now() });
  pump();
  return ticketFor(key) ?? { state: 'building' };
}

function pump(): void {
  const width = envInt('JELLYFIN_YEAR_REVIEW_BUILDS', 1, 1);
  while (running.size < width && waiting.length) {
    const job = waiting.shift()!;
    running.add(job.key);
    job.work(Date.now() - job.queuedAt)
      .then(() => failures.delete(job.key))
      .catch((error: any) => {
        const count = (failures.get(job.key)?.count ?? 0) + 1;
        const retryAt = Date.now() + Math.min(60, 2 ** (count - 1)) * 60_000;
        failures.set(job.key, { count, retryAt });
        logger.warn(`Build ${job.key.slice(0, 8)} failed (${count}), next try ${new Date(retryAt).toISOString()}: ${error?.message || error}`);
      })
      .finally(() => {
        running.delete(job.key);
        pump();
      });
  }
}
