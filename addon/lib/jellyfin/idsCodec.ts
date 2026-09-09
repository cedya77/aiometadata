import { createHash } from 'crypto';

const PACKED = 0xa1;
const HASHED = 0xb2;
const CODEC_VERSION = 1;
const NONE16 = 0xffff;
const MAX48 = 2 ** 48 - 1;

export type PackableKind = 'movie' | 'series' | 'season' | 'episode';
export type HashedKind = 'view' | 'genre' | 'person' | 'studio';
export type JellyfinKind = PackableKind | HashedKind;

export type Descriptor =
  | { k: 'movie' | 'series'; t: string; i: string }
  | { k: 'season'; t: string; i: string; s: number }
  | { k: 'episode'; t: string; i: string; s: number | null; e: number }
  | { k: 'view'; t: string; c: string }
  | { k: 'genre'; t: string; c: string; g: string }
  | { k: 'person' | 'studio'; n: string };

const KIND_CODES: Record<PackableKind, number> = {
  movie: 1,
  series: 2,
  season: 3,
  episode: 4,
};
const KIND_BY_CODE: Record<number, PackableKind> = {
  1: 'movie',
  2: 'series',
  3: 'season',
  4: 'episode',
};

const ID_TYPE_CODES: Record<string, number> = {
  imdb: 1,
  tmdb: 2,
  tvdb: 3,
  kitsu: 4,
  mal: 5,
  anilist: 6,
  anidb: 7,
  tvmaze: 8,
};
const ID_TYPE_BY_CODE: Record<number, string> = Object.fromEntries(
  Object.entries(ID_TYPE_CODES).map(([k, v]) => [v, k])
);

const ID_PREFIXES: Record<string, string> = {
  imdb: 'tt',
  tmdb: 'tmdb:',
  tvdb: 'tvdb:',
  kitsu: 'kitsu:',
  mal: 'mal:',
  anilist: 'anilist:',
  anidb: 'anidb:',
  tvmaze: 'tvmaze:',
};

const MEDIA_TYPE_CODES: Record<string, number> = {
  movie: 1,
  series: 2,
  anime: 3,
  'anime.movie': 4,
  'anime.series': 5,
  collection: 6,
  Trakt: 7,
};
const MEDIA_TYPE_BY_CODE: Record<number, string> = Object.fromEntries(
  Object.entries(MEDIA_TYPE_CODES).map(([k, v]) => [v, k])
);

export interface ParsedStremioId {
  idType: string;
  numeric: number;
  base: string;
  season: number | null;
  episode: number | null;
}

/**
 * Splits a Stremio id into its base and any season/episode tail.
 *
 * Colon count alone is ambiguous: `tt1234567:1:5` is base + season + episode,
 * while `kitsu:12345:7` is base + absolute episode. The base is taken from the
 * known prefix instead, and whatever follows is read by length.
 */
export function parseStremioId(id: string): ParsedStremioId | null {
  if (!id || typeof id !== 'string') return null;

  let idType: string | null = null;
  let base: string;
  let tail: string[];

  if (id.startsWith('tt')) {
    const parts = id.split(':');
    if (!/^tt\d+$/.test(parts[0])) return null;
    idType = 'imdb';
    base = parts[0];
    tail = parts.slice(1);
  } else {
    const entry = Object.entries(ID_PREFIXES).find(
      ([type, prefix]) => type !== 'imdb' && id.startsWith(prefix)
    );
    if (!entry) return null;
    const parts = id.split(':');
    if (parts.length < 2 || !/^\d+$/.test(parts[1])) return null;
    idType = entry[0];
    base = `${parts[0]}:${parts[1]}`;
    tail = parts.slice(2);
  }

  let season: number | null = null;
  let episode: number | null = null;
  if (tail.length === 1) {
    if (!/^\d+$/.test(tail[0])) return null;
    episode = Number(tail[0]);
  } else if (tail.length === 2) {
    if (!/^\d+$/.test(tail[0]) || !/^\d+$/.test(tail[1])) return null;
    season = Number(tail[0]);
    episode = Number(tail[1]);
  } else if (tail.length > 2) {
    return null;
  }

  const raw = idType === 'imdb' ? base.slice(2) : base.split(':')[1];
  const numeric = Number(raw);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > MAX48) return null;

  return { idType, numeric, base, season, episode };
}

function rebuildBase(idType: string, numeric: number): string {
  if (idType === 'imdb') return `tt${String(numeric).padStart(7, '0')}`;
  return `${ID_PREFIXES[idType]}${numeric}`;
}

export function buildVideoId(
  base: string,
  season: number | null,
  episode: number
): string {
  return season === null
    ? `${base}:${episode}`
    : `${base}:${season}:${episode}`;
}

function tryPack(d: Descriptor): string | null {
  if (d.k !== 'movie' && d.k !== 'series' && d.k !== 'season' && d.k !== 'episode') {
    return null;
  }

  const mediaCode = MEDIA_TYPE_CODES[d.t];
  if (!mediaCode) return null;

  const parsed = parseStremioId(d.i);
  if (!parsed) return null;
  if (parsed.season !== null || parsed.episode !== null) return null;
  if (rebuildBase(parsed.idType, parsed.numeric) !== d.i) return null;

  const idTypeCode = ID_TYPE_CODES[parsed.idType];
  if (!idTypeCode) return null;

  let season = NONE16;
  let episode = NONE16;

  if (d.k === 'season') {
    if (!Number.isInteger(d.s) || d.s < 0 || d.s >= NONE16) return null;
    season = d.s;
  } else if (d.k === 'episode') {
    if (!Number.isInteger(d.e) || d.e < 0 || d.e >= NONE16) return null;
    if (d.s !== null) {
      if (!Number.isInteger(d.s) || d.s < 0 || d.s >= NONE16) return null;
      season = d.s;
    }
    episode = d.e;
  }

  const buf = Buffer.alloc(16);
  buf[0] = PACKED;
  buf[1] = (KIND_CODES[d.k] << 4) | idTypeCode;
  buf[2] = mediaCode;
  buf.writeUIntBE(parsed.numeric, 3, 6);
  buf.writeUInt16BE(season, 9);
  buf.writeUInt16BE(episode, 11);
  buf[13] = CODEC_VERSION;
  return buf.toString('hex');
}

function tryUnpack(hex: string): Descriptor | null {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 16 || buf[0] !== PACKED) return null;

  const kind = KIND_BY_CODE[buf[1] >> 4];
  const idType = ID_TYPE_BY_CODE[buf[1] & 0x0f];
  const mediaType = MEDIA_TYPE_BY_CODE[buf[2]];
  if (!kind || !idType || !mediaType) return null;

  const numeric = buf.readUIntBE(3, 6);
  const season = buf.readUInt16BE(9);
  const episode = buf.readUInt16BE(11);
  const base = rebuildBase(idType, numeric);

  switch (kind) {
    case 'movie':
    case 'series':
      return { k: kind, t: mediaType, i: base };
    case 'season':
      if (season === NONE16) return null;
      return { k: 'season', t: mediaType, i: base, s: season };
    case 'episode':
      if (episode === NONE16) return null;
      return {
        k: 'episode',
        t: mediaType,
        i: base,
        s: season === NONE16 ? null : season,
        e: episode,
      };
  }
  return null;
}

export function canonicalDescriptor(d: Descriptor): string {
  switch (d.k) {
    case 'view':
      return `view|${d.t}|${d.c}`;
    case 'genre':
      return `genre|${d.t}|${d.c}|${d.g}`;
    case 'movie':
    case 'series':
      return `${d.k}|${d.t}|${d.i}`;
    case 'season':
      return `season|${d.t}|${d.i}|${d.s}`;
    case 'episode':
      return `episode|${d.t}|${d.i}|${d.s === null ? '' : d.s}|${d.e}`;
    case 'person':
    case 'studio':
      return `${d.k}|${d.n}`;
  }
}

export function normaliseJellyfinId(id: string): string {
  return String(id || '').replace(/-/g, '').toLowerCase();
}

export function dashedGuid(hex32: string): string {
  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20)}`;
}

export function packJellyfinId(d: Descriptor): string | null {
  return tryPack(d);
}

export function unpackJellyfinId(raw: string): Descriptor | null {
  const id = normaliseJellyfinId(raw);
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  return tryUnpack(id);
}

export function hashJellyfinId(d: Descriptor): string {
  const hash = createHash('md5').update(canonicalDescriptor(d)).digest();
  hash[0] = HASHED;
  return hash.toString('hex');
}

export function isHashedJellyfinId(id: string): boolean {
  return normaliseJellyfinId(id).slice(0, 2) === HASHED.toString(16);
}

export function isPackedJellyfinId(id: string): boolean {
  return normaliseJellyfinId(id).slice(0, 2) === PACKED.toString(16);
}

/**
 * The Stremio id a descriptor addresses, which is what stream delegation needs.
 */
export function stremioIdFor(d: Descriptor): string | null {
  switch (d.k) {
    case 'movie':
    case 'series':
      return d.i;
    case 'episode':
      return buildVideoId(d.i, d.s, d.e);
    default:
      return null;
  }
}

export { CODEC_VERSION };
