import consola from 'consola';
import { createHash } from 'crypto';
import { envInt } from '../../utils/envNumber';

const logger = consola.withTag('Jellyfin');

const TICKS_PER_MS = 10000;

export interface PlayableStream {
  id: string;
  url: string;
  name: string;
  container: string | null;
  size: number | null;
}

function requestTimeoutMs(): number {
  return envInt('JELLYFIN_STREAM_TIMEOUT_MS', 15000, 1000);
}

/**
 * Accepts whatever a user pastes: a manifest URL, a base with or without a
 * trailing slash, or one already ending in /stream.
 */
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

/**
 * A Jellyfin client fetches the media URL itself and cannot attach arbitrary
 * headers, so a stream that needs them is unplayable rather than merely awkward
 * and is dropped instead of being offered and failing at play time.
 */
function needsHeaders(stream: any): boolean {
  const hints = stream?.behaviorHints?.proxyHeaders;
  if (!hints) return false;
  const request = hints.request && Object.keys(hints.request).length > 0;
  const response = hints.response && Object.keys(hints.response).length > 0;
  return Boolean(request || response);
}

export function mediaSourceIdFor(stream: any): string {
  return createHash('md5').update(String(stream?.url || '')).digest('hex');
}

export function toPlayable(stream: any): PlayableStream | null {
  if (!stream || typeof stream.url !== 'string' || !stream.url) return null;
  if (needsHeaders(stream)) return null;

  const label = [stream.name, stream.title || stream.description]
    .filter(Boolean)
    .join('\n');

  const size = Number(stream?.behaviorHints?.videoSize);

  return {
    id: mediaSourceIdFor(stream),
    url: stream.url,
    name: label || 'Stream',
    container: containerOf(stream),
    size: Number.isFinite(size) && size > 0 ? size : null,
  };
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

/**
 * A client builds its playback plan from the tracks, so a source with no video
 * stream is treated as unplayable however good its URL is. Nothing here knows
 * the real file, so the label is read off the stream name and the numbers stay
 * absent rather than invented.
 */
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

/**
 * A client treats an item with no MediaSources as unplayable and never asks for
 * playback, so every playable item carries one. Resolving streams for a whole
 * list would fan out a request per item, so a listed item gets this instead and
 * the real sources arrive from PlaybackInfo when someone presses play.
 */
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
