import consola from 'consola';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import redis from '../redisClient';

const logger = consola.withTag('Jellyfin');

const TICKS_PER_MS = 10000;

export interface PlayableStream {
  id: string;
  url: string;
  name: string;
  container: string | null;
  size: number | null;
  filename: string | null;
}

function requestTimeoutMs(): number {
  return envInt('JELLYFIN_STREAM_TIMEOUT_MS', 15000, 1000);
}

// Accepts a manifest URL, a bare base, or one already ending in /stream.
export function normaliseStreamBase(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let base = raw.trim();
  if (!base) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(base);
  if (scheme) {
    if (!/^https?$/i.test(scheme[1])) return null;
  } else {
    base = `https://${base}`;
  }

  base = base.replace(/\/+$/, '');
  base = base.replace(/\/manifest\.json$/i, '');
  base = base.replace(/\/stream$/i, '');

  try {
    const parsed = new URL(base);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return base;
  } catch {
    return null;
  }
}

function containerOf(stream: any): string | null {
  const name = stream?.behaviorHints?.filename || stream?.behaviorHints?.bingeGroup || stream?.url || '';
  const match = /\.([a-z0-9]{2,4})(?:\?|$)/i.exec(String(name).split('?')[0]);
  const ext = match ? match[1].toLowerCase() : null;
  return ext && ext !== 'json' ? ext : null;
}

// A client fetches the media URL itself and cannot attach headers, so a stream
// needing them is dropped rather than offered and failing at play time.
function needsHeaders(stream: any): boolean {
  const hints = stream?.behaviorHints?.proxyHeaders;
  if (!hints) return false;
  const request = hints.request && Object.keys(hints.request).length > 0;
  const response = hints.response && Object.keys(hints.response).length > 0;
  return Boolean(request || response);
}

// The upstream mints a fresh playback URL per resolve, so an id derived from it
// stops matching once the memo expires and the client's saved MediaSourceId then
// selects a different file mid-playback. The name and description are no better:
// they are presentation, and the upstream rewrites them as state changes, for
// one adding a marker once the file lands in the debrid cache, which starting
// to play it is exactly what causes. Only the file itself names a release.
export function mediaSourceIdFor(stream: any): string {
  const size = Number(stream?.behaviorHints?.videoSize);
  const filename = String(stream?.behaviorHints?.filename || '');
  const parts = [filename, Number.isFinite(size) && size > 0 ? String(size) : ''];

  // A stream with no filename has nothing stable to be named by, so the text
  // is used with the volatile markers folded out of it.
  if (!filename) {
    parts.push(
      foldLabel(String(stream?.name || '')),
      foldLabel(String(stream?.title || stream?.description || ''))
    );
  }

  return createHash('md5').update(parts.join('\u0000')).digest('hex');
}

/**
 * The playback URL each source id was handed out with. The stream addon's URL
 * is self-contained, it names the file and needs no search to serve it, so
 * once a client holds one it is served the same URL for as long as it keeps
 * asking, rather than the whole list being resolved again and hoped to still
 * contain the file. Resolving is for choosing a source, not for playing one.
 *
 * Held in Redis so a playback survives this process restarting under it, with
 * memory behind it for the case where Redis is not there.
 */
const issued = new LRUCache<string, string>({
  max: envInt('JELLYFIN_ISSUED_SOURCE_MAX', 5000, 1),
  ttl: envInt('JELLYFIN_ISSUED_SOURCE_TTL', 12 * 60 * 60, 60) * 1000,
});

function issuedTtlSeconds(): number {
  return envInt('JELLYFIN_ISSUED_SOURCE_TTL', 12 * 60 * 60, 60);
}

export function rememberIssued(id: string, url: string): void {
  if (!id || !url) return;
  issued.set(id, url);
  if (redis) {
    redis.set(`jf:src:${id}`, url, 'EX', issuedTtlSeconds()).catch(() => undefined);
  }
}

export async function recallIssued(id: string): Promise<string | undefined> {
  const local = issued.get(id);
  if (local) return local;

  if (!redis) return undefined;
  try {
    const stored = await redis.get(`jf:src:${id}`);
    if (stored) issued.set(id, stored);
    return stored ?? undefined;
  } catch {
    return undefined;
  }
}

export function toPlayable(stream: any): PlayableStream | null {
  if (!stream || typeof stream.url !== 'string' || !stream.url) return null;
  if (needsHeaders(stream)) return null;

  const label = [stream.name, stream.title || stream.description]
    .filter(Boolean)
    .join('\n');

  const size = Number(stream?.behaviorHints?.videoSize);
  const id = mediaSourceIdFor(stream);
  const filename = String(stream?.behaviorHints?.filename || '');
  rememberIssued(id, stream.url);

  return {
    id,
    url: stream.url,
    name: label || 'Stream',
    container: containerOf(stream),
    size: Number.isFinite(size) && size > 0 ? size : null,
    filename: filename || null,
  };
}

// A client resolves the same item twice: opening it, then pressing play.
const resolved = new LRUCache<string, any[]>({
  max: envInt('JELLYFIN_STREAM_CACHE_MAX', 2000, 1),
  ttl: envInt('JELLYFIN_STREAM_CACHE_TTL', 60, 1) * 1000,
});

const inFlight = new Map<string, Promise<any[]>>();

export function rememberStreams(key: string, streams: any[]): void {
  resolved.set(key, streams);
}

export function recallStreams(key: string): any[] | undefined {
  return resolved.get(key);
}

export function coalesce(key: string, work: () => Promise<any[]>): Promise<any[]> {
  const running = inFlight.get(key);
  if (running) return running;

  const started = work().finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}

export async function fetchStreams(
  base: string,
  type: string,
  id: string
): Promise<any[]> {
  const url = `${base}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs());

  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.debug(`Streams ${type}/${id} returned ${response.status}`);
      return [];
    }
    const body: any = await response.json();
    return Array.isArray(body?.streams) ? body.streams : [];
  } catch (error: any) {
    logger.warn(`Streams ${type}/${id} failed: ${error?.message || error}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stream names arrive in Unicode small capitals with zero-width separators
 * carrying hidden metadata, so `\bUHD\b` never matches what a user plainly
 * reads as UHD. Folded to ASCII before anything is matched against it.
 */
const SMALL_CAPS: Record<string, string> = {
  '\u1D00': 'a', '\u0299': 'b', '\u1D04': 'c', '\u1D05': 'd', '\u1D07': 'e',
  '\u0493': 'f', '\uA730': 'f', '\u0262': 'g', '\u029C': 'h', '\u026A': 'i',
  '\u1D0A': 'j', '\u1D0B': 'k', '\u029F': 'l', '\u1D0D': 'm', '\u0274': 'n',
  '\u1D0F': 'o', '\u1D18': 'p', '\u01EB': 'q', '\u0280': 'r', '\uA731': 's',
  '\u1D1B': 't', '\u1D1C': 'u', '\u1D20': 'v', '\u1D21': 'w', '\u028F': 'y',
  '\u1D22': 'z',
};

const ZERO_WIDTH = /[\u200B-\u200D\u2060-\u2064\uFEFF]/g;

export function foldLabel(value: string): string {
  let out = '';
  for (const ch of String(value || '').replace(ZERO_WIDTH, '')) {
    out += SMALL_CAPS[ch] ?? ch;
  }
  return out;
}

// Order matters: the shorthands are checked before the bare `hd` they contain.
const RESOLUTIONS: Array<[RegExp, number, number]> = [
  [/\b(4k|2160p|uhd)\b/i, 3840, 2160],
  [/\b(1440p|qhd)\b/i, 2560, 1440],
  [/\b(1080p|fhd)\b/i, 1920, 1080],
  [/\b(720p|hd)\b/i, 1280, 720],
  [/\b(480p|sd)\b/i, 854, 480],
];

const CODECS: Array<[RegExp, string]> = [
  [/\b(hevc|h\.?265|x265)\b/i, 'hevc'],
  [/\b(avc|h\.?264|x264)\b/i, 'h264'],
  [/\bav1\b/i, 'av1'],
];

// A source with no video stream is treated as unplayable however good its URL
// is. Nothing here knows the real file, so numbers stay absent, not invented.
function buildMediaStreams(playable: PlayableStream): any[] {
  const label = foldLabel(playable.name);
  const resolution = RESOLUTIONS.find(([re]) => re.test(label));
  const codec = CODECS.find(([re]) => re.test(label));

  const displayTitle = [resolution ? `${resolution[2]}p` : null, codec ? codec[1] : null]
    .filter(Boolean)
    .join(' ') || 'Video';

  return [
    {
      Type: 'Video',
      Index: 0,
      Codec: codec ? codec[1] : undefined,
      Width: resolution ? resolution[1] : undefined,
      Height: resolution ? resolution[2] : undefined,
      IsDefault: true,
      IsForced: false,
      IsHearingImpaired: false,
      IsOriginal: false,
      IsExternal: false,
      IsInterlaced: false,
      IsTextSubtitleStream: false,
      SupportsExternalStream: false,
      VideoRange: 'SDR',
      VideoRangeType: 'SDR',
      DisplayTitle: displayTitle,
      AspectRatio: resolution ? '16:9' : undefined,
    },
    {
      Type: 'Audio',
      Index: 1,
      IsDefault: true,
      IsForced: false,
      IsHearingImpaired: false,
      IsOriginal: false,
      IsExternal: false,
      IsInterlaced: false,
      IsTextSubtitleStream: false,
      SupportsExternalStream: false,
      DisplayTitle: 'Audio',
    },
  ];
}

export function mediaSourceFor(
  playable: PlayableStream,
  runtimeTicks: number | null
): any {
  return {
    Protocol: 'Http',
    Id: playable.id,
    Path: playable.url,
    DirectStreamUrl: playable.url,
    Type: 'Default',
    Container: playable.container,
    Size: playable.size,
    Name: playable.name,
    IsRemote: true,
    ETag: playable.id,
    RunTimeTicks: runtimeTicks,
    ReadAtNativeFramerate: false,
    IgnoreDts: false,
    IgnoreIndex: false,
    GenPtsInput: false,
    SupportsTranscoding: false,
    SupportsDirectStream: true,
    SupportsDirectPlay: true,
    IsInfiniteStream: false,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiresLooping: false,
    SupportsProbing: true,
    TranscodingSubProtocol: 'http',
    VideoType: 'VideoFile',
    MediaStreams: buildMediaStreams(playable),
    MediaAttachments: [],
    Formats: [],
    RequiredHttpHeaders: {},
    DefaultAudioStreamIndex: 1,
    DefaultSubtitleStreamIndex: null,
    HasSegments: false,
  };
}

export function runtimeTicksFrom(meta: any): number | null {
  const runtime = meta?.runtime;
  if (typeof runtime !== 'string') return null;
  const hours = /(\d+)\s*h/.exec(runtime);
  const minutes = /(\d+)\s*min/.exec(runtime);
  const total = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  return total > 0 ? total * 60 * 1000 * TICKS_PER_MS : null;
}

const PLACEHOLDER_PATH = '/jellyfin/placeholder.mp4';

// An item with no MediaSources is treated as unplayable and never reaches
// PlaybackInfo, so a listed item carries this rather than a request per item.
export function placeholderMediaSource(id: string, name: string): any {
  return {
    Protocol: 'Http',
    Id: id,
    Path: PLACEHOLDER_PATH,
    Type: 'Placeholder',
    Container: 'mp4',
    Name: name,
    IsRemote: true,
    ETag: id,
    IsInfiniteStream: false,
    SupportsTranscoding: false,
    SupportsDirectStream: true,
    SupportsDirectPlay: true,
    SupportsProbing: true,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiresLooping: false,
    TranscodingSubProtocol: 'http',
    VideoType: 'VideoFile',
    MediaAttachments: [],
    Formats: [],
    RequiredHttpHeaders: {},
    MediaStreams: [
      {
        Type: 'Video',
        Index: 0,
        Codec: 'h264',
        IsDefault: true,
        IsForced: false,
        IsHearingImpaired: false,
        IsOriginal: false,
        IsExternal: false,
        IsInterlaced: false,
        IsTextSubtitleStream: false,
        SupportsExternalStream: false,
        DisplayTitle: name,
      },
    ],
  };
}

export function placeholderSources(itemId: string): any[] {
  return [placeholderMediaSource(itemId, 'Streams resolve on play')];
}
