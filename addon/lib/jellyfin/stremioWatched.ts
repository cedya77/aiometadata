import { inflateSync } from 'zlib';

// Stremio's per-episode watched marks: `<anchorVideoId>:<anchorLength>:<base64(zlib(bits))>`, one bit per video
// in the order Stremio sorts a title's videos, anchored on the last watched one so lists that changed still line up.

export type VideoRef = { id: string; season?: number | null; episode?: number | null; released?: string | null };
export type WatchedField = { anchor: string; anchorLength: number; bits: Buffer };

const MAX_BYTES = 65536;

export function parseWatched(value: unknown): WatchedField | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(':');
  if (parts.length < 3) return null;
  const payload = parts.pop()!;
  const anchorLength = Number(parts.pop());
  const anchor = parts.join(':');
  if (!anchor || anchor === 'undefined' || !Number.isInteger(anchorLength) || anchorLength < 1) return null;
  try {
    return { anchor, anchorLength, bits: inflateSync(Buffer.from(payload, 'base64'), { maxOutputLength: MAX_BYTES }) };
  } catch {
    return null;
  }
}

const orderOf = (video: VideoRef): number[] => {
  const released = video.released ? Date.parse(video.released) : NaN;
  return [video.season ?? -Infinity, video.episode ?? -Infinity, Number.isFinite(released) ? released : -Infinity];
};

export function sortedVideoIds(videos: VideoRef[]): string[] {
  return videos
    .map((video) => ({ id: video.id, order: orderOf(video) }))
    .sort((a, b) => {
      for (let i = 0; i < 3; i++) if (a.order[i] !== b.order[i]) return a.order[i] < b.order[i] ? -1 : 1;
      return 0;
    })
    .map((video) => video.id);
}

const bitAt = (bits: Buffer, at: number): boolean => at >= 0 && at >> 3 < bits.length && ((bits[at >> 3] >> (at & 7)) & 1) === 1;

export function anchorWatched(field: WatchedField): boolean {
  return bitAt(field.bits, field.anchorLength - 1);
}

export function decodeWatched(field: WatchedField, ids: string[]): string[] | null {
  const at = ids.indexOf(field.anchor);
  if (at < 0) return null;
  const offset = field.anchorLength - 1 - at;
  for (let bit = 0; bit < field.bits.length * 8; bit++) {
    const index = bit - offset;
    if (bitAt(field.bits, bit) && (index < 0 || index >= ids.length)) return null;
  }
  return ids.filter((_, index) => bitAt(field.bits, index + offset));
}
