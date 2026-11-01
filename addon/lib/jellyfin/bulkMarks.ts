import { envInt } from '../../utils/envNumber';

/** How many marks in a row, each within the gap of the last, read as one bulk mark rather than viewings. */
export function bulkMarkRule(): { size: number; gapMs: number } {
  return { size: envInt('JELLYFIN_BULK_MARK_SIZE', 6, 2), gapMs: envInt('JELLYFIN_BULK_MARK_GAP_SECONDS', 60, 0) * 1000 };
}

/** Whether each of these times falls in a bulk mark, in the order given. */
export function bulkMarked(times: number[], { size, gapMs } = bulkMarkRule()): boolean[] {
  const order = times.map((_, i) => i).sort((a, b) => times[a] - times[b]);
  const out = times.map(() => false);
  let start = 0;
  for (let i = 1; i <= order.length; i += 1) {
    if (i < order.length && times[order[i]] - times[order[i - 1]] <= gapMs) continue;
    if (i - start >= size) for (let j = start; j < i; j += 1) out[order[j]] = true;
    start = i;
  }
  return out;
}
