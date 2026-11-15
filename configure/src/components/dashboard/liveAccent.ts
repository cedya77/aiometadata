import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties } from "react";
import type { JellyfinSessionRow } from "@/hooks/useDashboardQueries";
import { pixelsFor, sizedArt } from "./art";

// The poster cache's widest copy; past it the original is the only sharper one.
const WIDEST_COPY = 1280;
// Stretching the copy by up to this much is not visible, so the original is only worth its size past it.
const MAX_STRETCH = 1.25;
// Tailwind's md breakpoint. Below it the art sits dimmed behind the text, where the widest copy is plenty.
const WIDE_SCREEN = "(min-width: 768px)";
// Backdrops and stills are 16:9, and the art covers its box, so a tall box draws it wider than the box.
const ART_ASPECT = 16 / 9;
const SAMPLE_PX = 342;

const artOf = (s: JellyfinSessionRow) => s.backdropUrl ?? s.imageUrl;

/**
 * The art a live session shows behind it, the title's backdrop or its still. `src` stays null until `box`,
 * the element drawing it, is measured; it is the original only when a wide screen would stretch the widest copy visibly.
 */
export function useLiveArt(s: JellyfinSessionRow | undefined, box: HTMLElement | null): { art: string | null; src: string | null } {
  const art = s ? artOf(s) : null;
  const [measured, setMeasured] = useState<string | null>(null);
  // Once a screen has needed the original it keeps it, so a resize never fetches the art twice.
  const [full, setFull] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!art || !box) return;
    const check = () => {
      const { width, height } = box.getBoundingClientRect();
      if (window.matchMedia(WIDE_SCREEN).matches && pixelsFor(Math.max(width, height * ART_ASPECT)) > WIDEST_COPY * MAX_STRETCH) setFull(art);
      setMeasured(art);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(box);
    return () => observer.disconnect();
  }, [art, box]);
  if (!art || measured !== art) return { art, src: null };
  return { art, src: full === art ? art : sizedArt(art, WIDEST_COPY) };
}

type Tone = { hue: number; sat: number };

// Hue buckets 10 degrees wide; the busiest run of three wins, so a colour split across a bucket edge still counts as one.
const BUCKETS = 36;
const SAMPLE_W = 48;
const SAMPLE_H = 27;
// Below this share of colourful pixels the art reads as grey and keeps the default tone.
const MIN_COLOUR = 0.04;
const DEFAULT_TONE: Tone = { hue: 217, sat: 0.9 };

function toneOf(img: HTMLImageElement): Tone | null {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_W;
  canvas.height = SAMPLE_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, SAMPLE_W, SAMPLE_H);
  const { data } = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
  const buckets = Array.from({ length: BUCKETS }, () => ({ weight: 0, x: 0, y: 0, sat: 0 }));
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const light = (max + min) / 2, spread = max - min;
    if (spread === 0 || light < 0.12 || light > 0.9) continue;
    const sat = spread / (1 - Math.abs(2 * light - 1));
    if (sat < 0.25) continue;
    const hue = 60 * (max === r ? ((g - b) / spread + 6) % 6 : max === g ? (b - r) / spread + 2 : (r - g) / spread + 4);
    // Vivid mid tones count most; near-black and washed-out pixels barely at all.
    const weight = sat * (1 - Math.abs(light - 0.5));
    const bucket = buckets[Math.floor(hue / (360 / BUCKETS)) % BUCKETS];
    bucket.weight += weight;
    bucket.x += Math.cos((hue * Math.PI) / 180) * weight;
    bucket.y += Math.sin((hue * Math.PI) / 180) * weight;
    bucket.sat += sat * weight;
    total += weight;
  }
  if (total < SAMPLE_W * SAMPLE_H * MIN_COLOUR) return null;
  const run = (i: number) => [-1, 0, 1].map((d) => buckets[(i + d + BUCKETS) % BUCKETS]);
  let best = 0, bestWeight = -1;
  for (let i = 0; i < BUCKETS; i++) {
    const weight = run(i).reduce((n, bucket) => n + bucket.weight, 0);
    if (weight > bestWeight) { best = i; bestWeight = weight; }
  }
  const picked = run(best);
  const x = picked.reduce((n, bucket) => n + bucket.x, 0);
  const y = picked.reduce((n, bucket) => n + bucket.y, 0);
  const sat = picked.reduce((n, bucket) => n + bucket.sat, 0) / bestWeight;
  return { hue: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360, sat };
}

/** The colours a live session wears, as custom properties: a vivid accent, its light and deep ends, and a dark field of the same hue. */
function paletteOf({ hue, sat }: Tone): CSSProperties {
  const h = Math.round(hue);
  const s = Math.round(Math.max(0.75, Math.min(1, sat)) * 100);
  return {
    "--live": `hsl(${h} ${s}% 62%)`,
    "--live-deep": `hsl(${h} ${Math.round(s * 0.75)}% 42%)`,
    "--live-light": `hsl(${h} ${s}% 82%)`,
    "--live-glow": `hsl(${h} ${s}% 62% / 0.7)`,
    "--live-dim": `hsl(${h} ${Math.round(s * 0.5)}% 70% / 0.65)`,
    "--live-tint": `hsl(${h} ${s}% 62% / 0.16)`,
    "--live-edge": `hsl(${h} ${s}% 62% / 0.45)`,
    "--live-field": `radial-gradient(ellipse 80% 90% at 15% 30%, hsl(${h} 62% 22%) 0%, hsl(${h} 62% 10%) 55%, hsl(${h} 50% 5%) 100%)`,
  } as CSSProperties;
}

const known = new Map<string, Tone | null>();
// Several parts of the page wear the same session's colours, so a sample under way is shared rather than repeated.
const sampling = new Map<string, Promise<Tone | null>>();
const sameOrigin = (src: string) => {
  try { return new URL(src, window.location.href).origin === window.location.origin; } catch { return false; }
};

function sampleTone(src: string): Promise<Tone | null> {
  const pending = sampling.get(src);
  if (pending) return pending;
  const sample = new Promise<Tone | null>((resolve) => {
    const img = new Image();
    img.onload = () => {
      try { resolve(toneOf(img)); } catch { resolve(null); /* a canvas the browser will not read back */ }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  }).then((tone) => {
    known.set(src, tone);
    sampling.delete(src);
    return tone;
  });
  sampling.set(src, sample);
  return sample;
}

/**
 * The palette for a live session, taken from its art. Only art this page serves itself can be read back,
 * so anything else, and art with no real colour, wears the default blue. `ready` turns true once that is settled.
 */
export function useLiveAccent(s: JellyfinSessionRow | undefined): { style: CSSProperties; ready: boolean } {
  const src = s ? sizedArt(artOf(s), SAMPLE_PX) : null;
  const readable = src && sameOrigin(src) ? src : null;
  const [found, setFound] = useState<{ src: string; tone: Tone | null } | null>(null);
  useEffect(() => {
    if (!readable || known.has(readable)) return;
    let current = true;
    sampleTone(readable).then((tone) => { if (current) setFound({ src: readable, tone }); });
    return () => { current = false; };
  }, [readable]);
  const settled = !readable || known.has(readable) || found?.src === readable;
  const tone = readable ? (found?.src === readable ? found.tone : known.get(readable)) ?? null : null;
  const style = useMemo(() => paletteOf(tone ?? DEFAULT_TONE), [tone]);
  return { style, ready: settled };
}
