import type { CSSProperties } from "react";

export interface ArtPalette {
  main: [number, number, number];
  second: [number, number, number];
  brightness: number;
}

const cache = new Map<string, Promise<ArtPalette | null>>();

function toHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

export function artPalette(src: string): Promise<ArtPalette | null> {
  const known = cache.get(src);
  if (known) return known;
  const reading = new Promise<ArtPalette | null>((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onerror = () => resolve(null);
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 18;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return resolve(null);
        context.drawImage(image, 0, 0, 32, 18);
        const { data } = context.getImageData(0, 0, 32, 18);
        const buckets = Array.from({ length: 24 }, () => ({ weight: 0, s: 0, l: 0 }));
        let brightness = 0;
        for (let i = 0; i < data.length; i += 4) {
          const [h, s, l] = toHsl(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
          brightness += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          const weight = s * (1 - Math.abs(l - 0.5) * 1.6);
          if (weight <= 0) continue;
          const bucket = buckets[Math.floor(h / 15) % 24];
          bucket.weight += weight;
          bucket.s += s * weight;
          bucket.l += l * weight;
        }
        const pixels = data.length / 4;
        const ranked = buckets
          .map((bucket, index) => ({ ...bucket, hue: index * 15 + 7.5 }))
          .filter((bucket) => bucket.weight > 0)
          .sort((a, b) => b.weight - a.weight);
        const pick = (bucket?: (typeof ranked)[number]): [number, number, number] => (bucket ? [bucket.hue, bucket.s / bucket.weight, bucket.l / bucket.weight] : [30, 0.1, 0.3]);
        const main = ranked[0];
        const apart = ranked.find((bucket) => Math.min(Math.abs(bucket.hue - (main?.hue ?? 0)), 360 - Math.abs(bucket.hue - (main?.hue ?? 0))) >= 45);
        resolve({ main: pick(main), second: pick(apart ?? main), brightness: brightness / pixels / 255 });
      } catch {
        resolve(null);
      }
    };
    image.src = src;
  });
  cache.set(src, reading);
  return reading;
}

export const hsl = ([h, s, l]: [number, number, number], alpha = 1) => `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}% / ${alpha})`;

export function inkGround(palette: ArtPalette | null): CSSProperties {
  const [h, s] = palette?.main ?? [30, 0.1, 0];
  return {
    backgroundColor: hsl([h, Math.min(s, 0.5), 0.075]),
    backgroundImage: `radial-gradient(130% 55% at 50% 0%, ${hsl([h, Math.min(s, 0.6), 0.22], 0.75)}, transparent 75%)`,
    transition: "background-color 600ms",
  };
}
