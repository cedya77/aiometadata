import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { reloadPages } from "./jellyfinUtils";

// A shelf's remembered choices, and the swipe that steps its deck.

export function remembered<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const held = localStorage.getItem(key) as T | null;
    return held && allowed.includes(held) ? held : fallback;
  } catch {
    return fallback;
  }
}

export function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

/** The value once it has held for `ms`, so a deck stepped through quickly redraws only where it stops. */
export function useSettled<T>(value: T, ms = 150): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const wait = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(wait);
  }, [value, ms]);
  return settled;
}

export function useSwipe(index: number, count: number, onPick: (i: number) => void) {
  const drag = useRef<{ x: number; moved: boolean } | null>(null);
  const current = useRef(index);
  current.current = index;
  return {
    onPointerDown: (event: React.PointerEvent) => { drag.current = { x: event.clientX, moved: false }; },
    onPointerMove: (event: React.PointerEvent) => {
      const held = drag.current;
      if (!held) return;
      const dx = event.clientX - held.x;
      if (Math.abs(dx) < 48) return;
      held.x = event.clientX;
      held.moved = true;
      current.current = Math.max(0, Math.min(count - 1, current.current - Math.sign(dx)));
      onPick(current.current);
    },
    onPointerUp: () => { setTimeout(() => { drag.current = null; }, 0); },
    onPointerCancel: () => { drag.current = null; },
    onPointerLeave: () => { if (drag.current && !drag.current.moved) drag.current = null; },
    onClickCapture: (event: React.MouseEvent) => { if (drag.current?.moved) { event.preventDefault(); event.stopPropagation(); } },
  };
}

/**
 * Rows read a page at a time, kept in order. A page read again after a change re-reads every page held from where
 * the change began, so a move or removal on one page shows on all after it; a new reset key starts over.
 */
export function usePagedRows<P extends { offset: number }, R>(page: P | undefined, rowsOf: (page: P) => R[], base: readonly unknown[], resetKey: string) {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<R[]>([]);
  const loaded = useRef<number[]>([]);
  const generation = useRef(0);
  const changedFrom = useRef(0);
  useEffect(() => {
    generation.current += 1;
    loaded.current = [];
    setRows([]);
  }, [resetKey]);
  useEffect(() => {
    if (!page) return;
    if (page.offset === 0 || !loaded.current.includes(page.offset)) {
      if (page.offset > 0 && !loaded.current.length) return;
      loaded.current = page.offset === 0 ? [0] : [...loaded.current, page.offset];
      setRows((held) => (page.offset === 0 ? rowsOf(page) : [...held.slice(0, page.offset), ...rowsOf(page)]));
      return;
    }
    const from = changedFrom.current;
    changedFrom.current = 0;
    const offsets = loaded.current.filter((at, i, all) => (all[i + 1] ?? Infinity) > from);
    const started = generation.current;
    void reloadPages<R>(queryClient, base, offsets, (held) => (held ? rowsOf(held) : undefined), from > 0).then((pages) => {
      if (!pages || started !== generation.current) return;
      // Each page goes in at its own offset, so pages that overlap once the list has grown never repeat a row.
      setRows((kept) => pages.reduce<R[]>((held, rows, i) => [...held.slice(0, offsets[i]), ...rows], kept.slice(0, offsets[0] ?? 0)));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);
  return [rows, setRows, changedFrom] as const;
}
