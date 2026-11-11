import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { resolveLanguage } from './languageTags';

const logger = consola.withTag('Jellyfin');

export type SubtitleFormat = 'vtt' | 'srt' | 'ass' | 'json';

/** One subtitle file a client can fetch, from the stream itself or a subtitle addon. */
export interface SubtitleTrack {
  id: string;
  url: string;
  lang: string;
  /** A finer code some addons send beside `lang`, such as `zh-tw`. */
  langCode?: string;
  source: 'stream' | 'addon';
  /** The release the file was timed for, when the addon names one. */
  title?: string;
  forced?: boolean;
  hearingImpaired?: boolean;
  machineTranslated?: boolean;
}

const SUBTITLE_FILE_EXTENSION = /(\.(srt|vtt|ass|ssa|sub|smi|txt))+$/i;
const VIDEO_FILE_EXTENSION = /\.(mkv|mp4|avi|m4v|mov|wmv)$/i;
const LOOKS_LIKE_RELEASE = /\b(19|20)\d{2}\b|\bS\d{1,2}E\d{1,3}\b|\b\d{3,4}p\b/i;
const HEARING_IMPAIRED = [/\bsdh\b/i, /hearing[\s._-]?impaired/i, /\[(hi|cc)\]/i];
// A bare HI is also how releases tag Hindi.
const HEARING_IMPAIRED_TAG = /(^|[\s._(-])(HI|CC)($|[\s._)-])/;
const HINDI = /^(hi|hin|hindi)$/i;
// A forced tag, not a title that starts with the word: clients play forced tracks unasked.
const FORCED_TAG = /[[(]forced[\])]|[\s._-]forced$/i;

function text(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const trimmed = String(value).trim();
  return trimmed || undefined;
}

const withoutSubtitleExtension = (value: unknown): string | undefined => text(text(value)?.replace(SUBTITLE_FILE_EXTENSION, ''));

// Ids like `[Group]Show.S01E02.1080p_3` carry the release before the counter.
function releaseInId(id: string): string | undefined {
  const match = /^((?:\[[^\]]*\])*)(.+)_\d+$/.exec(id);
  if (!match || !(match[1] || /[.\s-]/.test(match[2]))) return undefined;
  return text(match[1] ? `${match[1]} ${match[2]}` : match[2]);
}

function releaseInUrl(url: string): string | undefined {
  try {
    const file = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    const name = withoutSubtitleExtension(file);
    return name && name !== file && LOOKS_LIKE_RELEASE.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

/** What an addon's subtitle says about itself beyond its language. */
export function subtitleDetails(s: any, id: string, url: string): Pick<SubtitleTrack, 'langCode' | 'title' | 'forced' | 'hearingImpaired' | 'machineTranslated'> {
  const langCode = text(s?.lang_code);
  const named = text(s?.label) ?? text(s?.title) ?? withoutSubtitleExtension(s?.subtitleFileName)
    ?? text(s?.movieReleaseName) ?? releaseInId(id) ?? releaseInUrl(url);
  const title = text(named?.replace(VIDEO_FILE_EXTENSION, ''));
  const machineTranslated = s?.ai_translated === true || s?.machine_translated === true;
  const lang = text(s?.lang) ?? '';
  const forced = typeof s?.forced === 'boolean' ? s.forced : /\bforced\b/i.test(lang) || FORCED_TAG.test(title ?? '');
  const cues = `${title ?? ''} ${lang}`;
  const hindi = HINDI.test(lang) || HINDI.test(langCode ?? '');
  const hearingImpaired = typeof s?.hearingImpaired === 'boolean'
    ? s.hearingImpaired
    : HEARING_IMPAIRED.some((cue) => cue.test(cues)) || (!hindi && HEARING_IMPAIRED_TAG.test(cues));
  return {
    ...(langCode ? { langCode } : {}),
    ...(title ? { title } : {}),
    ...(forced ? { forced } : {}),
    ...(hearingImpaired ? { hearingImpaired } : {}),
    ...(machineTranslated ? { machineTranslated } : {}),
  };
}

interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

const VTT_TYPE = 'text/vtt; charset=utf-8';
const SRT_TYPE = 'application/x-subrip; charset=utf-8';
const ASS_TYPE = 'text/x-ssa; charset=utf-8';

/** ISO 639-2/B, which is what a client matches its preferred language against. */
export function subtitleLanguage(lang: string, byName: (name: unknown) => string | undefined, langCode?: string): string {
  const raw = String(lang || '').trim();
  return resolveLanguage(raw, langCode)?.code ?? byName(raw) ?? raw.toLowerCase().replace(/[-_].*$/, '');
}

/** The language as a menu shows it, keeping a variant the addon named. */
export function subtitleLanguageName(lang: string, name: string | undefined, langCode?: string): string {
  const raw = String(lang || '').trim();
  return resolveLanguage(raw, langCode)?.name ?? name ?? raw;
}

type TitledTrack = Pick<SubtitleTrack, 'title' | 'forced' | 'hearingImpaired' | 'machineTranslated'> & { ordinal: number; language?: string };

/** The release without a closing `.en` or `.zh-TW` that says nothing the track's language label does not. */
function shownRelease(track: TitledTrack, label: string): string | undefined {
  const match = track.title ? /^(.+)\.([a-z]{2,3}(?:-[a-z]{2,4})?)$/i.exec(track.title) : null;
  const tag = match ? resolveLanguage(match[2]) : null;
  return match && tag && tag.code === track.language && (tag.name === label || !tag.name.includes('(')) ? match[1] : track.title;
}

/** The release a track was timed for when known, otherwise its language and place among that language's tracks. */
export function subtitleTitles(track: TitledTrack, language: string, repeat = 1): { title: string; displayTitle: string } {
  const shown = shownRelease(track, language);
  const release = shown?.toLowerCase() ?? '';
  const flags = [
    track.forced && !release.includes('forced') ? 'Forced' : null,
    track.hearingImpaired && !/\b(sdh|hi|cc)\b|hearing/.test(release) ? 'SDH' : null,
    track.machineTranslated ? 'AI translated' : null,
  ].filter(Boolean);
  if (!shown) {
    const title = track.ordinal > 1 ? `${language} ${track.ordinal}` : language;
    return { title, displayTitle: `${[title, ...flags].join(' - ')} (external)` };
  }
  const title = repeat > 1 ? `${shown} (${repeat})` : shown;
  const lead = language.toLowerCase();
  const leadsWithLanguage = release.startsWith(lead) && !/[\p{L}\p{M}]/u.test(release.charAt(lead.length));
  const displayTitle = [leadsWithLanguage ? null : language, title, ...flags].filter(Boolean).join(' - ');
  return { title, displayTitle };
}

/** subtitleTitles for each track of a menu, counting a release one language lists more than once. */
export function subtitleMenuTitles<T extends TitledTrack>(tracks: T[], labelOf: (track: T) => string): Array<{ title: string; displayTitle: string }> {
  const repeats = new Map<string, number>();
  return tracks.map((track) => {
    const label = labelOf(track);
    const shown = shownRelease(track, label);
    if (!shown) return subtitleTitles(track, label);
    const key = `${label}\u0000${shown.toLowerCase()}`;
    const repeat = (repeats.get(key) ?? 0) + 1;
    repeats.set(key, repeat);
    return subtitleTitles(track, label, repeat);
  });
}

/** A few of each language, taken a round at a time so a late language is not lost to the cap. */
export function pickSubtitles<T extends { language: string }>(tracks: T[], perLanguage: number, total: number, groupOf: (track: T) => string = (track) => track.language): Array<T & { ordinal: number }> {
  const byLanguage = new Map<string, T[]>();
  for (const track of tracks) {
    const group = groupOf(track);
    const list = byLanguage.get(group) ?? [];
    if (list.length < perLanguage) list.push(track);
    byLanguage.set(group, list);
  }
  const out: Array<T & { ordinal: number }> = [];
  for (let round = 0; round < perLanguage && out.length < total; round++) {
    for (const list of byLanguage.values()) {
      if (out.length >= total) break;
      if (list[round]) out.push({ ...list[round], ordinal: round + 1 });
    }
  }
  return out;
}

export function subtitleExtensionOf(url: string): string {
  const ext = (url.split('?')[0].split('#')[0].split('.').pop() ?? '').toLowerCase();
  return /^(srt|vtt|ass|ssa|sub|sup)$/.test(ext) ? ext : 'srt';
}

export function subtitleCodecFor(format: SubtitleFormat | string): string {
  switch (format) {
    case 'vtt':
    case 'webvtt':
      return 'webvtt';
    case 'ass':
    case 'ssa':
      return 'ass';
    default:
      return 'subrip';
  }
}

export function formatOf(raw: string): SubtitleFormat {
  const f = String(raw || '').toLowerCase();
  if (f === 'js' || f === 'json') return 'json';
  if (f === 'srt' || f === 'subrip') return 'srt';
  if (f === 'ass' || f === 'ssa') return 'ass';
  return 'vtt';
}

/**
 * The format the client's device profile asks external subtitles in. A styled
 * script stays styled only when the client takes ASS; Kodi asks for nothing and
 * plays SRT.
 */
export function subtitleFormatFor(profile: any, clientName: string | undefined, sourceExtension: string): SubtitleFormat {
  const formats = new Set<string>();
  for (const p of Array.isArray(profile?.SubtitleProfiles) ? profile.SubtitleProfiles : []) {
    if (String(p?.Method ?? '').toLowerCase() !== 'external') continue;
    const f = String(p?.Format ?? '').toLowerCase();
    if (f) formats.add(f === 'subrip' ? 'srt' : f === 'webvtt' ? 'vtt' : f);
  }
  const ext = sourceExtension.toLowerCase();
  if ((ext === 'ass' || ext === 'ssa') && (formats.has('ass') || formats.has('ssa'))) return 'ass';
  if (/kodi/i.test(clientName ?? '')) return 'srt';
  if (formats.has('vtt')) return 'vtt';
  if (formats.has('srt')) return 'srt';
  if (formats.has('ass') || formats.has('ssa')) return 'ass';
  return 'vtt';
}

function normaliseText(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

const TIME = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})|(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function timeToMs(text: string): number | null {
  const m = TIME.exec(text.trim());
  if (!m) return null;
  if (m[1] !== undefined) {
    return Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4].padEnd(3, '0'));
  }
  return Number(m[5]) * 60_000 + Number(m[6]) * 1000 + Number(m[7].padEnd(3, '0'));
}

/** SRT or VTT cues; headers, NOTE and STYLE blocks and cue ids are skipped. */
export function parseCues(input: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of normaliseText(input).split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.length > 0);
    if (!lines.length || /^(WEBVTT|NOTE|STYLE|REGION)/.test(lines[0])) continue;
    const arrow = lines.findIndex((l) => l.includes('-->'));
    if (arrow === -1) continue;
    const [start, end] = lines[arrow].split('-->');
    const startMs = timeToMs(start);
    const endMs = timeToMs(end.trim());
    if (startMs === null || endMs === null) continue;
    cues.push({ startMs, endMs, text: lines.slice(arrow + 1).join('\n') });
  }
  return cues;
}

/** The Dialogue lines of an ASS or SSA script, styling dropped. */
export function parseAssCues(input: string): Cue[] {
  const cues: Cue[] = [];
  let textIndex = 9;
  for (const line of normaliseText(input).split('\n')) {
    const format = /^\s*Format:\s*(.+)$/i.exec(line);
    if (format) {
      const at = format[1].split(',').map((f) => f.trim().toLowerCase()).indexOf('text');
      if (at >= 0) textIndex = at;
      continue;
    }
    const dialogue = /^\s*Dialogue:\s*(.+)$/i.exec(line);
    if (!dialogue) continue;
    const parts = dialogue[1].split(',');
    if (parts.length <= textIndex) continue;
    const startMs = timeToMs(parts[1] ?? '');
    const endMs = timeToMs(parts[2] ?? '');
    if (startMs === null || endMs === null) continue;
    const text = parts.slice(textIndex).join(',').replace(/\{[^}]*\}/g, '').replace(/\\[Nnh]/g, '\n').trim();
    if (text) cues.push({ startMs, endMs, text });
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

function stamp(ms: number, separator: '.' | ','): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms % 1000, 3)}`;
}

export function cuesToVtt(cues: Cue[]): string {
  const body = cues.map((c, i) => `${i + 1}\n${stamp(c.startMs, '.')} --> ${stamp(c.endMs, '.')}\n${c.text}`).join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

export function cuesToSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.startMs, ',')} --> ${stamp(c.endMs, ',')}\n${c.text}`).join('\n\n') + '\n';
}

/** Jellyfin's own JSON track format, in 100 ns ticks. */
export function cuesToJellyfinJson(cues: Cue[]): string {
  return JSON.stringify({
    TrackEvents: cues.map((c, i) => ({
      Id: String(i + 1),
      Text: c.text,
      StartPositionTicks: Math.round(c.startMs * 10_000),
      EndPositionTicks: Math.round(c.endMs * 10_000),
    })),
  });
}

export function convertSubtitle(body: string, fromExtension: string, to: SubtitleFormat): { body: string; contentType: string } {
  const from = fromExtension.toLowerCase();
  const styled = from === 'ass' || from === 'ssa';
  const textual = from === 'srt' || from === 'vtt' || from === 'sub';
  const cuesOf = () => (styled ? parseAssCues(body) : textual ? parseCues(body) : []);

  if (to === 'json') return { body: cuesToJellyfinJson(cuesOf()), contentType: 'application/json; charset=utf-8' };
  if (to === 'ass') {
    if (styled) return { body: normaliseText(body), contentType: ASS_TYPE };
    return { body: cuesToSrt(cuesOf()), contentType: SRT_TYPE };
  }
  if (to === 'vtt') {
    if (from === 'vtt') return { body: normaliseText(body), contentType: VTT_TYPE };
    const cues = cuesOf();
    if (cues.length) return { body: cuesToVtt(cues), contentType: VTT_TYPE };
    return { body: normaliseText(body), contentType: 'text/plain; charset=utf-8' };
  }
  if (from === 'srt') return { body: normaliseText(body), contentType: SRT_TYPE };
  const cues = cuesOf();
  if (cues.length) return { body: cuesToSrt(cues), contentType: SRT_TYPE };
  return { body: normaliseText(body), contentType: 'text/plain; charset=utf-8' };
}

/** The tracks a stream carries itself, in the order a client sees them. */
export function streamSubtitleTracks(stream: any): SubtitleTrack[] {
  const out: SubtitleTrack[] = [];
  const seen = new Set<string>();
  for (const s of Array.isArray(stream?.subtitles) ? stream.subtitles : []) {
    const url = typeof s?.url === 'string' ? s.url : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const id = String(s?.id ?? url);
    out.push({ id, url, lang: String(s?.lang ?? 'und'), source: 'stream', ...subtitleDetails(s, id, url) });
  }
  return out;
}

const manifests = new LRUCache<string, boolean>({
  max: 200,
  ttl: envInt('JELLYFIN_SUBTITLE_TTL', 60 * 60, 60) * 1000,
});

/** Whether the stream addon answers the subtitles resource at all. */
export async function addonServesSubtitles(base: string): Promise<boolean> {
  const held = manifests.get(base);
  if (held !== undefined) return held;
  let serves = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), envInt('JELLYFIN_STREAM_TIMEOUT_MS', 20000, 1000));
    const response = await fetch(`${base}/manifest.json`, { headers: { accept: 'application/json' }, signal: controller.signal });
    clearTimeout(timer);
    const manifest: any = response.ok ? await response.json() : null;
    serves = (Array.isArray(manifest?.resources) ? manifest.resources : []).some(
      (r: any) => r === 'subtitles' || r?.name === 'subtitles'
    );
  } catch (error: any) {
    logger.debug(`Stream addon manifest unavailable: ${error?.message || error}`);
  }
  manifests.set(base, serves);
  return serves;
}

const addonTracks = new LRUCache<string, SubtitleTrack[]>({
  max: envInt('JELLYFIN_STREAM_CACHE_MAX', 2000, 1),
  ttl: envInt('JELLYFIN_SUBTITLE_TTL', 60 * 60, 60) * 1000,
});

export interface FileHints {
  videoHash?: string | null;
  videoSize?: number | null;
  filename?: string | null;
}

function extrasFor(hints: FileHints): string {
  const parts: string[] = [];
  if (hints.videoHash) parts.push(`videoHash=${encodeURIComponent(hints.videoHash)}`);
  if (hints.videoSize) parts.push(`videoSize=${hints.videoSize}`);
  if (hints.filename) parts.push(`filename=${encodeURIComponent(hints.filename)}`);
  return parts.join('&');
}

/**
 * Subtitles the stream addon finds for this video, matched to the file where
 * it knows the hash, size or name. One call per file; the answer is kept.
 */
export async function fetchAddonSubtitles(base: string, type: string, videoId: string, hints: FileHints, userAgent: string): Promise<SubtitleTrack[]> {
  if (!(await addonServesSubtitles(base))) return [];
  const extras = extrasFor(hints);
  const key = `${base}|${type}|${videoId}|${extras}`;
  const held = addonTracks.get(key);
  if (held) return held;

  const url = `${base}/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(videoId)}${extras ? `/${extras}` : ''}.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), envInt('JELLYFIN_SUBTITLE_FETCH_TIMEOUT_MS', 15000, 1000));
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': userAgent }, signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      logger.debug(`Subtitles ${type}/${videoId} returned ${response.status}`);
      return [];
    }
    const body: any = await response.json();
    const out: SubtitleTrack[] = [];
    const seen = new Set<string>();
    for (const s of Array.isArray(body?.subtitles) ? body.subtitles : []) {
      const track = typeof s?.url === 'string' ? s.url : '';
      if (!track || seen.has(track)) continue;
      seen.add(track);
      const id = String(s?.id ?? track);
      out.push({ id, url: track, lang: String(s?.lang ?? 'und'), source: 'addon', ...subtitleDetails(s, id, track) });
    }
    // Read on every write, so a dashboard change applies without a restart.
    addonTracks.set(key, out, { ttl: envInt('JELLYFIN_SUBTITLE_TTL', 60 * 60, 60) * 1000 });
    return out;
  } catch (error: any) {
    logger.debug(`Subtitles ${type}/${videoId} failed: ${error?.message || error}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

const bodies = new LRUCache<string, { body: string; contentType: string }>({
  max: envInt('JELLYFIN_STREAM_CACHE_MAX', 2000, 1),
  ttl: envInt('JELLYFIN_SUBTITLE_TTL', 60 * 60, 60) * 1000,
  maxSize: envInt('JELLYFIN_SUBTITLE_BODY_CACHE_MB', 64, 1) * 1024 * 1024,
  sizeCalculation: (value) => Math.max(1, Buffer.byteLength(value.body, 'utf8')),
});

const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;

/** The file fetched and turned into the format asked; kept so a seek does not fetch it again. */
// A player asks for every subtitle at once; a provider refuses that many at the same time, so
// each host gets a few at a time and the rest wait their turn.
const hostSlots = new Map<string, { active: number; waiting: Array<() => void> }>();

async function inHostTurn<T>(url: string, work: () => Promise<T>): Promise<T> {
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    return work();
  }
  const limit = envInt('JELLYFIN_SUBTITLE_FETCH_CONCURRENCY', 4, 1);
  let slot = hostSlots.get(host);
  if (!slot) {
    slot = { active: 0, waiting: [] };
    hostSlots.set(host, slot);
  }
  if (slot.active >= limit) await new Promise<void>((resolve) => slot!.waiting.push(resolve));
  slot.active++;
  try {
    return await work();
  } finally {
    slot.active--;
    const next = slot.waiting.shift();
    if (next) next();
    else if (slot.active === 0) hostSlots.delete(host);
  }
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

/** The provider's file, asked again after a refusal it says is passing, as long as it asks to wait. */
async function fetchSubtitle(url: string): Promise<{ response: Response; done: () => void }> {
  const retries = envInt('JELLYFIN_SUBTITLE_FETCH_RETRIES', 2, 0);
  for (let attempt = 0; ; attempt++) {
    // Timed from its turn, not from the wait for one.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      controller.abort();
    };
    const response = await inHostTurn(url, () => {
      timer = setTimeout(() => controller.abort(), envInt('JELLYFIN_SUBTITLE_FETCH_TIMEOUT_MS', 15000, 1000));
      return fetch(url, { signal: controller.signal, redirect: 'follow' });
    });
    if (response.ok || !RETRY_STATUSES.has(response.status) || attempt >= retries) return { response, done };
    done();
    const after = Number(response.headers.get('retry-after'));
    const wait = Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt, 8000);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

export async function subtitleBody(url: string, to: SubtitleFormat): Promise<{ body: string; contentType: string } | null> {
  const key = `${to}|${url}`;
  const held = bodies.get(key);
  if (held) return held;

  let done = () => {};
  try {
    const fetched = await fetchSubtitle(url);
    done = fetched.done;
    const response = fetched.response;
    if (!response.ok) {
      logger.debug(`Subtitle fetch got ${response.status} for ${url}`);
      return null;
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_SUBTITLE_BYTES) return null;
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length > MAX_SUBTITLE_BYTES) return null;
    const converted = convertSubtitle(raw.toString('utf8'), subtitleExtensionOf(url), to);
    bodies.set(key, converted);
    return converted;
  } catch (error: any) {
    logger.debug(`Subtitle fetch failed for ${url}: ${error?.message || error}`);
    return null;
  } finally {
    done();
  }
}

const offered = new LRUCache<string, SubtitleTrack[]>({
  max: envInt('JELLYFIN_STREAM_CACHE_MAX', 2000, 1),
  ttl: envInt('JELLYFIN_SUBTITLE_TTL', 60 * 60, 60) * 1000,
});

/** The external tracks a source was sent with, by index, so the route serves what the client saw. */
export function rememberOffered(key: string, tracks: SubtitleTrack[]): void {
  offered.set(key, tracks);
}

export function recallOffered(key: string): SubtitleTrack[] | undefined {
  return offered.get(key);
}
