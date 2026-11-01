import { useEffect, useMemo, useRef, useState } from "react";
import { titlePage, useDashboardOpen } from "./DashboardLink";
import { FadeScroll, TitleLink, plural, type YearAccent } from "./JellyfinYearShared";
import { sizedArt } from "./art";
import { metaIdOf } from "./yearModel";

const TILE_GAP = 4;
const TILE_LABEL_W = 80;
const TILE_LABEL_H = 60;
const TILE_ROW = 5;
const TILE_ROW_H = 72;
const WALL_MAX_H = 560;

const FOCUS_RING: Record<YearAccent, string> = {
  blue: "shadow-[inset_0_0_0_2px_rgba(96,165,250,0.85)]",
  pink: "shadow-[inset_0_0_0_2px_rgba(244,114,182,0.85)]",
};

export interface CoverTile {
  id: string;
  name: string;
  short: string;
  image: string | null;
  weight: number;
  detail: string;
  target: { key: string; kind: "movie" | "series" };
}

type Tile = { x: number; y: number; w: number; h: number };

function squarify(values: number[], width: number, height: number): Tile[] {
  const out: Tile[] = [];
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!total || width <= 0 || height <= 0) return values.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  const areas = values.map((value) => (value / total) * width * height);
  const worst = (sum: number, largest: number, smallest: number, side: number) => Math.max((side * side * largest) / (sum * sum), (sum * sum) / (side * side * smallest));
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h);
    let end = i + 1;
    let sum = areas[i];
    while (end < areas.length && worst(sum + areas[end], areas[i], areas[end], side) <= worst(sum, areas[i], areas[end - 1], side)) {
      sum += areas[end];
      end += 1;
    }
    if (w >= h) {
      const strip = sum / h;
      let at = y;
      for (let k = i; k < end; k += 1) {
        const size = areas[k] / strip;
        out.push({ x, y: at, w: strip, h: size });
        at += size;
      }
      x += strip;
      w -= strip;
    } else {
      const strip = sum / w;
      let at = x;
      for (let k = i; k < end; k += 1) {
        const size = areas[k] / strip;
        out.push({ x: at, y, w: size, h: strip });
        at += size;
      }
      y += strip;
      h -= strip;
    }
    i = end;
  }
  return out;
}

/** Covers sized by weight in the space they are given; a tap shows one, a second tap opens it. */
export function CoverTreemap({ tiles: items, label, accent }: { tiles: CoverTile[]; label: string; accent: YearAccent }) {
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [focus, setFocus] = useState<string | null>(null);
  const open = useDashboardOpen();
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setBox({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const tiles = useMemo(() => squarify(items.map((item) => item.weight), box.w, box.h), [items, box]);
  const placed = new Map(items.map((item, i) => [item.id, tiles[i]]));
  const focused = items.find((item) => item.id === focus) ?? null;
  const height = Math.max(200, Math.ceil(items.length / TILE_ROW) * TILE_ROW_H);
  const scrolls = height > WALL_MAX_H;
  return (
    <div className="mt-5 flex min-h-[220px] flex-1 flex-col">
      <FadeScroll scrolls={scrolls} maxHeight={WALL_MAX_H} label={`${plural(items.length, "cover")}, scroll for more`} className="flex flex-1 flex-col">
      <div ref={stage} className="relative flex-1" style={scrolls ? { height } : { minHeight: height }} onPointerLeave={(event) => event.pointerType === "mouse" && setFocus(null)}>
        {items.map((item) => {
          const tile = placed.get(item.id);
          if (!tile) return null;
          const big = tile.w >= TILE_LABEL_W && tile.h >= TILE_LABEL_H;
          const on = focus === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-label={`Open ${item.name}, ${item.detail}`}
              onPointerEnter={(event) => event.pointerType === "mouse" && setFocus(item.id)}
              onFocus={(event) => event.currentTarget.matches(":focus-visible") && setFocus(item.id)}
              onClick={() => {
                if (on && open) open(titlePage(metaIdOf(item.target.key), item.target.kind));
                else setFocus(item.id);
              }}
              className="absolute overflow-hidden rounded-lg transition-[left,top,width,height] duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"
              style={{ left: tile.x + TILE_GAP / 2, top: tile.y + TILE_GAP / 2, width: Math.max(0, tile.w - TILE_GAP), height: Math.max(0, tile.h - TILE_GAP) }}
            >
              {item.image
                ? <img src={sizedArt(item.image, 342) ?? item.image} alt="" loading="lazy" draggable={false} className={`h-full w-full object-cover object-top transition-transform duration-500 ${on ? "scale-105" : ""}`} />
                : <div className="h-full w-full bg-gradient-to-br from-zinc-700 to-zinc-900" />}
              <span aria-hidden="true" className={`pointer-events-none absolute inset-0 rounded-lg transition-shadow ${on ? FOCUS_RING[accent] : "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]"}`} />
              {big && (
                <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-2 pb-1.5 pt-5 text-left">
                  <span className="block truncate text-[11px] font-semibold leading-tight">{item.short}</span>
                  <span className="block text-[10px] text-white/70">{item.detail}</span>
                </span>
              )}
            </button>
          );
        })}
      </div>
      </FadeScroll>
      <p className="mt-3 text-[12px] text-muted-foreground">
        {focused
          ? <><TitleLink title={focused.target} name={focused.name} className="font-semibold text-foreground decoration-white/35 underline-offset-4 hover:underline">{focused.short}</TitleLink> · {focused.detail}</>
          : label}
      </p>
    </div>
  );
}
