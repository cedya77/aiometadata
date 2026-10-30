import consola from 'consola';
import { envInt } from '../../../utils/envNumber';

const logger = consola.withTag('YearReview');

export type Ticket = { state: 'queued'; ahead: number } | { state: 'building' } | { state: 'busy' };

type Job = { key: string; work: (waitedMs: number) => Promise<void>; queuedAt: number };

const waiting: Job[] = [];
const running = new Set<string>();

export function ticketFor(key: string): Ticket | null {
  if (running.has(key)) return { state: 'building' };
  const at = waiting.findIndex((job) => job.key === key);
  return at >= 0 ? { state: 'queued', ahead: at + running.size } : null;
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
      .catch((error: any) => logger.warn(`Build ${job.key.slice(0, 8)} failed: ${error?.message || error}`))
      .finally(() => {
        running.delete(job.key);
        pump();
      });
  }
}
