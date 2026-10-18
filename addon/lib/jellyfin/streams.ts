import consola from 'consola';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import redis from '../redisClient';
import { streamSubtitleTracks, type FileHints, type SubtitleTrack } from './subtitles';
const buildInfo: any = require('../buildInfo');

const logger = consola.withTag('Jellyfin');

const TICKS_PER_MS = 10000;

export interface PlayableStream {
  id: string;
  url: string;
  name: string;
  container: string | null;
  size: number | null;
  filename: string | null;
  videoHash: string | null;
  /** The file's own length when the addon knows it, ahead of the meta's runtime. */
  durationMs: number | null;
  /** Bits per second, when probed. */
  bitrate: number | null;
  /** Subtitle files the stream itself offers. */
  subtitles: SubtitleTrack[];
  parsed?: any;
  /** The addon's own title and lines, apart, for a picker that shows them apart. */
  title: string;
  description: string;
  bingeGroup: string | null;
  needsHeaders: boolean;
  requestHeaders: Record<string, string> | null;
}

// The stream addon adds what it parsed from a release only for a user agent it knows.
export function streamUserAgent(forwarded?: string): string {
  return process.env.JELLYFIN_STREAM_USER_AGENT?.trim() || forwarded?.trim() || `AIOStreams/aiometadata-${buildInfo.version}`;
}

export interface StreamClient {
  tag: string;
  userAgent?: string;
  client: string;
  version: string;
  device: string;
}

const lastClients = new LRUCache<string, StreamClient>({ max: 5000, ttl: 6 * 60 * 60 * 1000 });

export function streamClient(owner: string, info: { client: string; version: string; device: string }, userAgent?: string): StreamClient | undefined {
  if (info.client && info.client !== 'Unknown') {
    const client = { tag: `${info.client}/${info.version}@${info.device}`, userAgent: userAgent || undefined, client: info.client, version: info.version, device: info.device };
    lastClients.set(owner, client);
    return client;
  }
  return lastClients.get(owner);
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

// A client fetches the media URL itself, so a stream needing headers is offered
// only to one that says its player sends a source's RequiredHttpHeaders.
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
  const data = stream?.streamData && typeof stream.streamData === 'object' ? stream.streamData : {};
  // The release itself names the source where the addon says what it is: the
  // torrent and file, the nzb, or its release key, under the service serving it.
  const identity = data?.torrent?.infoHash
    ? `${data.torrent.infoHash}:${data.torrent.fileIdx ?? ''}`
    : typeof data?.nzbUrl === 'string' && data.nzbUrl
      ? data.nzbUrl
      : typeof data?.releaseKey === 'string' && data.releaseKey
        ? data.releaseKey
        : '';
  if (identity) {
    return createHash('md5').update([String(data?.service?.id ?? ''), identity].join('\u0000')).digest('hex');
  }

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

const issuedDuration = new LRUCache<string, number>({
  max: envInt('JELLYFIN_ISSUED_SOURCE_MAX', 5000, 1),
  ttl: envInt('JELLYFIN_ISSUED_SOURCE_TTL', 12 * 60 * 60, 60) * 1000,
});

function issuedTtlSeconds(): number {
  return envInt('JELLYFIN_ISSUED_SOURCE_TTL', 12 * 60 * 60, 60);
}

export function rememberIssued(id: string, url: string, durationMs: number | null = null): void {
  if (!id || !url) return;
  issued.set(id, url);
  if (durationMs) rememberDuration(id, durationMs);
  if (redis) redis.set(`jf:src:${id}`, url, 'EX', issuedTtlSeconds()).catch(() => undefined);
}

export function rememberDuration(id: string, durationMs: number): void {
  if (!id || !durationMs) return;
  issuedDuration.set(id, durationMs);
  if (redis) redis.set(`jf:dur:${id}`, String(durationMs), 'EX', issuedTtlSeconds()).catch(() => undefined);
}

export function forgetDuration(id: string): void {
  if (!id) return;
  issuedDuration.delete(id);
  if (redis) redis.del(`jf:dur:${id}`).catch(() => undefined);
}

/** The file's own length, when the stream addon reported one for this source. */
export async function recallDuration(id: string | undefined): Promise<number | null> {
  if (!id) return null;
  const local = issuedDuration.get(id);
  if (local) return local;
  if (!redis) return null;
  try {
    const stored = Number(await redis.get(`jf:dur:${id}`));
    if (stored > 0) issuedDuration.set(id, stored);
    return stored > 0 ? stored : null;
  } catch {
    return null;
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

export interface StreamNotice {
  id: string;
  name: string;
}

// Sources another client could play, so an entry carrying one is not a notice.
const PLAYABLE_SOURCES = ['url', 'infoHash', 'ytId', 'nzbUrl', 'rarUrls', 'zipUrls', '7zipUrls', 'tgzUrls', 'tarUrls'];

export function toNotice(stream: any): StreamNotice | null {
  if (!stream || PLAYABLE_SOURCES.some((key) => {
    const value = stream[key];
    return Array.isArray(value) ? value.length > 0 : !!value;
  })) return null;

  const name = [stream.name, stream.title || stream.description]
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!name) return null;

  const seed = [String(stream.externalUrl || ''), name].join('\u0000');
  return { id: createHash('md5').update(`notice\u0000${seed}`).digest('hex'), name };
}

function requestHeadersOf(stream: any): Record<string, string> | null {
  const request = stream?.behaviorHints?.proxyHeaders?.request;
  if (!request || typeof request !== 'object') return null;
  const entries = Object.entries(request).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length ? Object.fromEntries(entries) : null;
}

export function toPlayable(stream: any, allowHeaders = false): PlayableStream | null {
  if (!stream || typeof stream.url !== 'string' || !stream.url) return null;
  const headers = needsHeaders(stream);
  if (headers && !allowHeaders) return null;

  const label = [stream.name, stream.title || stream.description]
    .filter(Boolean)
    .join('\n');

  const size = Number(stream?.behaviorHints?.videoSize);
  const id = mediaSourceIdFor(stream);
  const filename = String(stream?.behaviorHints?.filename || '');
  const durationMs = Number.isFinite(Number(stream?.streamData?.duration)) && Number(stream.streamData.duration) > 0 ? Number(stream.streamData.duration) : null;
  rememberIssued(id, stream.url, durationMs);

  return {
    id,
    url: stream.url,
    name: label || 'Stream',
    container: containerOf(stream),
    size: Number.isFinite(size) && size > 0 ? size : null,
    filename: filename || null,
    videoHash: typeof stream?.behaviorHints?.videoHash === 'string' && stream.behaviorHints.videoHash ? stream.behaviorHints.videoHash : null,
    durationMs,
    bitrate: Number.isFinite(Number(stream?.streamData?.bitrate)) && Number(stream.streamData.bitrate) > 0 ? Number(stream.streamData.bitrate) : null,
    subtitles: streamSubtitleTracks(stream),
    parsed: stream?.streamData?.parsedFile && typeof stream.streamData.parsedFile === 'object' ? stream.streamData.parsedFile : undefined,
    title: String(stream.name || '').trim(),
    description: String(stream.title || stream.description || '').trim(),
    bingeGroup: typeof stream?.behaviorHints?.bingeGroup === 'string' && stream.behaviorHints.bingeGroup ? stream.behaviorHints.bingeGroup : null,
    needsHeaders: headers,
    requestHeaders: headers ? requestHeadersOf(stream) : null,
  };
}

// Lifetimes are read on every write, not when the cache is built, so a change made
// in the dashboard applies to the next entry without a restart.
const streamTtlMs = () => envInt('JELLYFIN_STREAM_CACHE_TTL', 180, 1) * 1000;
const subtitleTtlMs = () => envInt('JELLYFIN_SUBTITLE_TTL', 60 * 60, 60) * 1000;

// A source is renamed to its item's id when it is the default one, so what
// belongs to the file is kept by the URL, which survives that.
const fileOf = new LRUCache<string, { subtitles: SubtitleTrack[]; hints: FileHints }>({
  max: envInt('JELLYFIN_STREAM_CACHE_MAX', 2000, 1),
  ttl: envInt('JELLYFIN_SUBTITLE_TTL', 60 * 60, 60) * 1000,
});

export function fileFor(source: any): { subtitles: SubtitleTrack[]; hints: FileHints } {
  return fileOf.get(String(source?.Path ?? '')) ?? { subtitles: [], hints: {} };
}

// A client resolves the same item twice: opening it, then pressing play.
const resolved = new LRUCache<string, any[]>({
  max: envInt('JELLYFIN_STREAM_CACHE_MAX', 2000, 1),
  ttl: envInt('JELLYFIN_STREAM_CACHE_TTL', 180, 1) * 1000,
});

const inFlight = new Map<string, Promise<any[]>>();

// Why the last resolve came back empty, worded for the version picker.
const failures = new LRUCache<string, string>({
  max: envInt('JELLYFIN_STREAM_CACHE_MAX', 2000, 1),
  ttl: envInt('JELLYFIN_STREAM_CACHE_TTL', 180, 1) * 1000,
});

export function rememberStreams(key: string, streams: any[]): void {
  resolved.set(key, streams, { ttl: streamTtlMs() });
  failures.delete(key);
}

export function rememberFailure(key: string, reason: string): void {
  failures.set(key, reason, { ttl: streamTtlMs() });
}

export function recallFailure(key: string): string | undefined {
  return failures.get(key);
}

export function describeStatus(status: number): string {
  const hint =
    status === 403 ? 'check the addon URL'
    : status === 400 || status === 401 ? 'check the UUID and password in the addon URL'
    : status === 404 ? 'the addon URL is not a stream addon'
    : status === 429 ? 'too many requests, try again later'
    : status >= 500 ? 'the addon is having trouble'
    : '';
  return `Stream addon answered ${status}${hint ? `: ${hint}` : ''}`;
}

export function recallStreams(key: string): any[] | undefined {
  return resolved.get(key);
}

export function streamsState(key: string): 'cached' | 'fetching' | null {
  return resolved.has(key) ? 'cached' : inFlight.has(key) ? 'fetching' : null;
}

export function coalesce(key: string, work: () => Promise<any[]>): Promise<any[]> {
  const running = inFlight.get(key);
  if (running) return running;

  const started = work().finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}

// Header values carry Latin-1 only.
function headerValue(value: string): string {
  return /^[\x20-\x7E]*$/.test(value) ? value : encodeURIComponent(value);
}

export async function fetchStreams(
  base: string,
  type: string,
  id: string,
  client?: StreamClient
): Promise<{ streams: any[]; failure?: string }> {
  const url = `${base}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs());

  try {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': streamUserAgent(client?.userAgent) };
    if (client) {
      headers['x-jellyfin-client'] = headerValue(`${client.client}/${client.version}`);
      headers['x-jellyfin-device'] = headerValue(client.device);
    }
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      logger.debug(`Streams ${type}/${id} returned ${response.status}`);
      return { streams: [], failure: describeStatus(response.status) };
    }
    const body: any = await response.json();
    const streams = Array.isArray(body?.streams) ? body.streams : [];
    return streams.length ? { streams } : { streams, failure: 'No streams found for this title' };
  } catch (error: any) {
    logger.warn(`Streams ${type}/${id} failed: ${error?.message || error}`);
    const failure = error?.name === 'AbortError'
      ? `Stream addon did not answer within ${Math.round(requestTimeoutMs() / 1000)}s`
      : 'Stream addon not reachable';
    return { streams: [], failure };
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

const LANGUAGE_CODES: Record<string, string> = {
  english: 'eng', japanese: 'jpn', french: 'fre', german: 'ger', spanish: 'spa', italian: 'ita', portuguese: 'por',
  russian: 'rus', korean: 'kor', chinese: 'chi', mandarin: 'chi', cantonese: 'chi', hindi: 'hin', arabic: 'ara',
  dutch: 'dut', polish: 'pol', swedish: 'swe', danish: 'dan', finnish: 'fin', norwegian: 'nor', turkish: 'tur',
  czech: 'cze', hungarian: 'hun', greek: 'gre', hebrew: 'heb', thai: 'tha', vietnamese: 'vie', indonesian: 'ind',
  ukrainian: 'ukr', romanian: 'rum', bulgarian: 'bul', croatian: 'hrv', serbian: 'srp', slovak: 'slo', slovenian: 'slv',
  tamil: 'tam', telugu: 'tel', malayalam: 'mal', kannada: 'kan', bengali: 'ben', persian: 'per', malay: 'may', filipino: 'fil',
  latino: 'spa', 'brazilian portuguese': 'por',
};

const LANGUAGE_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(LANGUAGE_CODES)
    .filter(([name]) => !/ /.test(name) && name !== 'latino' && name !== 'mandarin' && name !== 'cantonese')
    .map(([name, code]) => [code, name.charAt(0).toUpperCase() + name.slice(1)])
);

export function languageName(code: string): string | undefined {
  return LANGUAGE_NAMES[code];
}

export function languageCode(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const key = name.trim().toLowerCase();
  if (/^[a-z]{3}$/.test(key)) return key;
  return LANGUAGE_CODES[key];
}

const AUDIO_CODECS: Array<[RegExp, string]> = [
  [/truehd|atmos/i, 'truehd'],
  [/dts-?hd|dts:x|dts/i, 'dts'],
  [/dd\+|e-?ac-?3|ddp/i, 'eac3'],
  [/\bdd\b|ac-?3|dolby digital/i, 'ac3'],
  [/flac/i, 'flac'],
  [/opus/i, 'opus'],
  [/aac/i, 'aac'],
  [/mp3/i, 'mp3'],
];

function audioCodec(tag: unknown): string | undefined {
  if (typeof tag !== 'string') return undefined;
  return AUDIO_CODECS.find(([re]) => re.test(tag))?.[1];
}

function channelCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '');
  const layout = /(\d)\.(\d)/.exec(text);
  if (layout) return Number(layout[1]) + Number(layout[2]);
  const plain = /^(\d+)$/.exec(text.trim());
  return plain ? Number(plain[1]) : undefined;
}

function videoRange(tags: string[]): { VideoRange: string; VideoRangeType: string } {
  const joined = tags.join(' ');
  if (/\bDV\b|dolby ?vision/i.test(joined)) return { VideoRange: 'HDR', VideoRangeType: 'DOVI' };
  if (/hdr10\+/i.test(joined)) return { VideoRange: 'HDR', VideoRangeType: 'HDR10Plus' };
  if (/hdr10|\bhdr\b/i.test(joined)) return { VideoRange: 'HDR', VideoRangeType: 'HDR10' };
  if (/hlg/i.test(joined)) return { VideoRange: 'HDR', VideoRangeType: 'HLG' };
  return { VideoRange: 'SDR', VideoRangeType: 'SDR' };
}

const STREAM_FLAGS = {
  IsForced: false,
  IsHearingImpaired: false,
  IsOriginal: false,
  IsExternal: false,
  IsInterlaced: false,
  IsTextSubtitleStream: false,
  SupportsExternalStream: false,
};

// The addon's parsed release first, the label as fallback; an unknown stays absent.
function buildMediaStreams(playable: PlayableStream): any[] {
  const parsed = playable.parsed || {};
  const label = foldLabel(playable.name);
  const resolution =
    RESOLUTIONS.find(([re]) => re.test(String(parsed.resolution || ''))) ??
    RESOLUTIONS.find(([re]) => re.test(label));
  const codec =
    CODECS.find(([re]) => re.test(String(parsed.encode || ''))) ??
    CODECS.find(([re]) => re.test(label));
  const visual: string[] = Array.isArray(parsed.visualTags) ? parsed.visualTags.map(String) : [];
  const range = videoRange(visual.length ? visual : [label]);

  const streams: any[] = [{
    Type: 'Video',
    Index: 0,
    Codec: codec ? codec[1] : undefined,
    ...(playable.bitrate ? { BitRate: playable.bitrate } : {}),
    Width: resolution ? resolution[1] : undefined,
    Height: resolution ? resolution[2] : undefined,
    IsDefault: true,
    ...STREAM_FLAGS,
    ...range,
    DisplayTitle: [resolution ? `${resolution[2]}p` : null, codec ? codec[1] : null, range.VideoRangeType !== 'SDR' ? range.VideoRangeType : null]
      .filter(Boolean).join(' ') || 'Video',
    AspectRatio: resolution ? '16:9' : undefined,
  }];

  const audioTags: string[] = Array.isArray(parsed.audioTags) ? parsed.audioTags.map(String) : [];
  const atmosTagged = audioTags.some((t) => /atmos/i.test(t)) || /atmos/i.test(label);
  const audioTracks: any[] = Array.isArray(parsed.audioTracks) && parsed.audioTracks.length
    ? parsed.audioTracks
    : [{
        codec: audioTags.find((t) => !/atmos/i.test(t)) ?? audioTags[0],
        channels: Array.isArray(parsed.audioChannels) ? parsed.audioChannels[0] : undefined,
        language: Array.isArray(parsed.languages) ? parsed.languages.find((l: unknown) => languageCode(l)) : undefined,
      }];
  audioTracks.forEach((track: any, i: number) => {
    const language = languageCode(track?.language ?? track?.lang);
    const codecName = audioCodec(track?.codec ?? track?.format) ?? (typeof track?.codec === 'string' ? track.codec.toLowerCase() : undefined);
    const channels = channelCount(track?.channels ?? track?.channelLayout);
    // Atmos is a layer on TrueHD or DD+, which is how a real server's probe reports it.
    const atmos = track?.atmos === true || /atmos/i.test(String(track?.codec ?? track?.title ?? '')) || (i === 0 && atmosTagged && (codecName === 'truehd' || codecName === 'eac3'));
    const profile = atmos
      ? (codecName === 'truehd' ? 'Dolby TrueHD + Dolby Atmos' : 'Dolby Digital Plus + Dolby Atmos')
      : codecName === 'dts' && /dts:?x/i.test(String(track?.codec ?? '') + label) ? 'DTS:X'
      : codecName === 'dts' && /dts-?hd ?ma/i.test(String(track?.codec ?? '') + label) ? 'DTS-HD MA'
      : undefined;
    streams.push({
      Type: 'Audio',
      Index: streams.length,
      Codec: codecName,
      ...(profile ? { Profile: profile } : {}),
      Language: language,
      Channels: channels,
      ChannelLayout: typeof track?.channelLayout === 'string' ? track.channelLayout : typeof track?.channels === 'string' ? track.channels : undefined,
      Title: typeof track?.title === 'string' ? track.title : typeof track?.name === 'string' ? track.name : undefined,
      IsDefault: track?.default === true || track?.isDefault === true || i === 0,
      ...STREAM_FLAGS,
      DisplayTitle: [track?.language ?? track?.lang, profile ?? (track?.codec ?? track?.format), track?.channels].filter(Boolean).join(' ') || 'Audio',
    });
  });

  const subtitleTracks: any[] = Array.isArray(parsed.subtitleTracks) && parsed.subtitleTracks.length
    ? parsed.subtitleTracks
    : (Array.isArray(parsed.subtitles) ? parsed.subtitles : []).map((language: unknown) => ({ language }));
  for (const track of subtitleTracks) {
    const language = languageCode(track?.language ?? track?.lang);
    const format = typeof (track?.codec ?? track?.format) === 'string' ? String(track.codec ?? track.format).toLowerCase() : undefined;
    streams.push({
      Type: 'Subtitle',
      Index: streams.length,
      Codec: format,
      Language: language,
      Title: typeof track?.title === 'string' ? track.title : typeof track?.name === 'string' ? track.name : undefined,
      IsDefault: track?.default === true || track?.isDefault === true,
      ...STREAM_FLAGS,
      IsForced: track?.forced === true || track?.isForced === true,
      IsHearingImpaired: track?.sdh === true || track?.hearingImpaired === true,
      IsTextSubtitleStream: !format || !/pgs|vobsub|dvd/i.test(format),
      DisplayTitle: [track?.language ?? track?.lang, format, track?.forced ? 'Forced' : null].filter(Boolean).join(' ') || 'Subtitle',
    });
  }

  return streams;
}

export function mediaSourceFor(
  playable: PlayableStream,
  runtimeTicks: number | null
): any {
  fileOf.set(
    playable.url,
    {
      subtitles: playable.subtitles,
      hints: { videoHash: playable.videoHash, videoSize: playable.size, filename: playable.filename },
    },
    { ttl: subtitleTtlMs() }
  );
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
    RunTimeTicks: playable.durationMs ? Math.round(playable.durationMs * 10000) : runtimeTicks,
    ...(playable.bitrate ? { Bitrate: playable.bitrate } : {}),
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
    RequiredHttpHeaders: playable.requestHeaders ?? {},
    // The first version takes its item's id, so this is the one that stays the same.
    aiostreams: {
      id: playable.id,
      name: playable.title || playable.name,
      description: playable.description,
      ...(playable.bingeGroup ? { bingeGroup: playable.bingeGroup } : {}),
    },
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
    ReadAtNativeFramerate: false,
    IgnoreDts: false,
    IgnoreIndex: false,
    GenPtsInput: false,
    HasSegments: false,
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

// The second entry is a marker: a client that builds its picker from the item
// and lists it gives the user a way to ask for the versions.
export function placeholderSources(itemId: string): any[] {
  const { encodeJellyfinId } = require('./ids');
  return [
    placeholderMediaSource(itemId, 'Streams load when played'),
    placeholderMediaSource(encodeJellyfinId({ k: 'marker', i: normaliseHex(itemId) }), 'Load the stream list'),
  ];
}

function normaliseHex(id: string): string {
  return String(id || '').replace(/-/g, '').toLowerCase();
}
