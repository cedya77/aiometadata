import { LRUCache } from 'lru-cache';

/** Where a walk stopped: the position a client asks for next, how many shown titles came before it, and what the walk needs to go on. */
export interface WalkPlace<S> {
  at: number;
  seenCount: number;
  state: S;
}

export interface Resumed<S> {
  record: number;
  place: WalkPlace<S>;
  seen: Set<string>;
}

interface WalkRecord<S> {
  id: number;
  keys: string[];
  places: Array<WalkPlace<S>>;
}

/**
 * One record per walk: the titles it showed, in order, held once, and the places it stopped at, each pointing into them.
 * A walk read again with the same titles keeps the record, one that runs on extends it, and one that differs starts another
 * from where they part.
 */
export function walkRecords<S>(options: { max: number; maxIds: number; ttlMs: number; seenCap?: number }) {
  const records = new LRUCache<string, WalkRecord<S>>({
    max: options.max,
    maxSize: options.maxIds,
    sizeCalculation: (record) => record.keys.length + record.places.length + 1,
    ttl: options.ttlMs,
  });
  let ids = 0;

  /** The latest place at or before `index`, with the titles shown before it. */
  function resume(key: string, index: number): Resumed<S> | null {
    const record = records.get(key);
    if (!record) return null;
    let low = 0;
    let high = record.places.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (record.places[mid].at <= index) {
        found = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    if (found < 0) return null;
    const place = record.places[found];
    const from = options.seenCap ? Math.max(0, place.seenCount - options.seenCap) : 0;
    return { record: record.id, place, seen: new Set(record.keys.slice(from, place.seenCount)) };
  }

  /** A window read from `from` (null for one read from the start) that showed `added`, in order, and stopped at `at`. */
  function save(key: string, from: Resumed<S> | null, added: string[], at: number, state: S): void {
    const base = from?.place.seenCount ?? 0;
    const held = records.get(key);
    const kept = held && (!from || held.id === from.record) && held.keys.length >= base ? held : null;
    const place: WalkPlace<S> = { at, seenCount: base + added.length, state };
    let id = kept?.id ?? -1;
    let keys: string[];
    let places: Array<WalkPlace<S>>;
    const ahead = kept ? kept.keys.slice(base, base + added.length) : [];
    if (kept && ahead.length === added.length && ahead.every((k, i) => k === added[i])) {
      keys = kept.keys;
      places = kept.places;
    } else if (kept && kept.keys.length === base) {
      keys = [...kept.keys, ...added];
      places = kept.places;
    } else {
      id = ++ids;
      keys = [...(kept ? kept.keys.slice(0, base) : []), ...added];
      places = kept ? kept.places.filter((p) => p.seenCount <= base) : [];
    }
    records.set(key, { id, keys, places: [...places.filter((p) => p.at !== at), place].sort((a, b) => a.at - b.at) });
  }

  return { resume, save };
}
