import { envInt } from '../../utils/envNumber';
import { parseStremioId } from './idsCodec';

/** How long after a finish another finish of the same title is still that viewing, not a rewatch. */
export function rewatchGapMs(runtimeMs: number): number {
  return runtimeMs > 0 ? runtimeMs / 2 : envInt('JELLYFIN_REWATCH_MIN_GAP_MINUTES', 10, 0) * 60_000;
}

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

/** The times among these marks that fall in a bulk mark; a title's ids differ in type, so a moment counts the most titles one id type names. */
export function bulkTimes(marks: Array<{ at: number; videoId: string }>, rule = bulkMarkRule()): Set<number> {
  const moments = new Map<number, Map<string, Set<string>>>();
  for (const { at, videoId } of marks) {
    if (!(at > 0)) continue;
    const parsed = parseStremioId(videoId);
    const byType = moments.get(at) ?? new Map<string, Set<string>>();
    moments.set(at, byType);
    const type = parsed?.idType ?? '';
    const titles = byType.get(type) ?? new Set<string>();
    byType.set(type, titles);
    titles.add(parsed ? `${parsed.base}|${parsed.season ?? ''}:${parsed.episode ?? ''}` : videoId);
  }
  const times: number[] = [];
  for (const [at, byType] of moments) {
    const titles = Math.max(...[...byType.values()].map((names) => names.size));
    for (let i = 0; i < titles; i += 1) times.push(at);
  }
  const out = new Set<number>();
  bulkMarked(times, rule).forEach((bulk, i) => {
    if (bulk) out.add(times[i]);
  });
  return out;
}
