import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import * as http from 'node:http';
import * as https from 'node:https';
import axios from 'axios';
import {
  getAllowedPrivateHosts,
  getConnectionCacheMax,
  getConnectionCacheTtlMs,
  getFetchConcurrency,
  getTlsSessionCacheMax,
  getMaxObjectBytes,
  getUpstreamTimeoutMs,
  isPrivateArtAllowed,
  parseUpstreamCacheMeta,
  type UpstreamCacheMeta,
} from './config.js';

const buildInfo = require('../buildInfo.js');


function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true; // Unparseable is not provably public.
  }
  const [a, b] = parts;
  if (a === 0) return true;                        // 0.0.0.0/8
  if (a === 10) return true;                       // private
  if (a === 127) return true;                      // loopback
  if (a === 169 && b === 254) return true;         // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true;         // private
  if (a === 192 && b === 0) return true;           // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true;                       // multicast + reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return true;
  // IPv4-mapped (::ffff:10.0.0.1) must be judged on the embedded address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (/^f[cd]/.test(normalized)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(normalized)) return true; // fe80::/10 link-local
  if (/^ff/.test(normalized)) return true; // multicast
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true;
}

export class UpstreamRejected extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface ValidatedUpstream {
  url: URL;
  addresses: string[];
}

export interface ResolveOptions {
  allowPrivateHost?: boolean;
}

/** Validators from a stored entry, sent back to the origin to ask "still this?". */
export interface ConditionalValidators {
  etag?: string;
  lastModified?: string;
}

export interface FetchOptions extends ResolveOptions {
  validators?: ConditionalValidators;
}

export { parseUpstreamCacheMeta } from './config.js';

export function mergeRevalidated(
  previous: UpstreamCacheMeta | undefined,
  fresh: UpstreamCacheMeta | undefined
): UpstreamCacheMeta {
  const merged: UpstreamCacheMeta = { ...(previous || {}) };
  if (fresh) {
    if (fresh.maxAge !== undefined) merged.maxAge = fresh.maxAge;
    if (fresh.sMaxAge !== undefined) merged.sMaxAge = fresh.sMaxAge;
    if (fresh.expires !== undefined) merged.expires = fresh.expires;
    if (fresh.date !== undefined) merged.date = fresh.date;
    if (fresh.immutable !== undefined) merged.immutable = fresh.immutable;
    if (fresh.noStore !== undefined) merged.noStore = fresh.noStore;
    if (fresh.noCache !== undefined) merged.noCache = fresh.noCache;
    if (fresh.mustRevalidate !== undefined) merged.mustRevalidate = fresh.mustRevalidate;
    if (fresh.etag) merged.etag = fresh.etag;
    if (fresh.lastModified) {
      merged.lastModified = fresh.lastModified;
      merged.lastModifiedAt = fresh.lastModifiedAt;
    }
  }
  merged.age = fresh?.age ?? 0;
  return merged;
}

/** Parses and validates the scheme; shared by the resolver and the connection cache. */
function parseUpstreamUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UpstreamRejected('Malformed upstream URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UpstreamRejected(`Unsupported protocol: ${parsed.protocol}`);
  }

  return parsed;
}

/** Resolves the host; rejects private-space answers unless the host is allowlisted or vouched for. */
export const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
};

function imageTypeFromPath(url: string): string {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const dot = path.lastIndexOf('.');
    if (dot < 0) return '';
    return IMAGE_TYPES[path.slice(dot + 1)] ?? '';
  } catch {
    return '';
  }
}

async function resolvePublicUrl(rawUrl: string, opts: ResolveOptions = {}): Promise<ValidatedUpstream> {
  const parsed = parseUpstreamUrl(rawUrl);

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const allowPrivate = (opts.allowPrivateHost === true && isPrivateArtAllowed())
    || getAllowedPrivateHosts().has(host.toLowerCase());

  if (net.isIP(host)) {
    if (!allowPrivate && isPrivateAddress(host)) {
      throw new UpstreamRejected(`Refusing to proxy private address: ${host}`, 403);
    }
    return { url: parsed, addresses: [host] };
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new UpstreamRejected(`Could not resolve upstream host: ${host}`, 502);
  }

  if (addresses.length === 0) {
    throw new UpstreamRejected(`Could not resolve upstream host: ${host}`, 502);
  }
  if (!allowPrivate && addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new UpstreamRejected(`Refusing to proxy host resolving to private address: ${host}`, 403);
  }

  return { url: parsed, addresses: addresses.map((entry) => entry.address) };
}

export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  return (await resolvePublicUrl(rawUrl)).url;
}

/** Pins DNS to already-validated addresses; the request still targets the hostname. */
function pinnedAgents(addresses: string[], keepAlive: boolean): { httpAgent: http.Agent; httpsAgent: https.Agent } {
  const lookup = (_hostname: string, options: any, callback: any) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : (options || {});
    if (opts.all) {
      cb(null, addresses.map((address) => ({ address, family: net.isIP(address) })));
      return;
    }
    const address = addresses[0];
    cb(null, address, net.isIP(address));
  };
  // Bound sockets per host so a burst cannot open an unbounded number of them.
  const maxSockets = Math.max(1, getFetchConcurrency());
  const maxCachedSessions = getTlsSessionCacheMax();
  return {
    httpAgent: new http.Agent({ lookup, keepAlive, maxSockets, maxFreeSockets: 32 } as any),
    httpsAgent: new https.Agent({ lookup, keepAlive, maxSockets, maxFreeSockets: 32, maxCachedSessions } as any),
  };
}

export interface Connection {
  url: URL;
  httpAgent: http.Agent;
  httpsAgent: https.Agent;
}

const DESTROY_GRACE_MS = 1_000;

interface HostEntry {
  addresses: string[];
  httpAgent: http.Agent;
  httpsAgent: https.Agent;
  expiresAt: number;
}

const hostCache = new Map<string, HostEntry>();
const resolving = new Map<string, Promise<HostEntry>>();

function clearTlsSessions(agent: any): void {
  const cache = agent?._sessionCache;
  if (!cache) return;
  cache.map = {};
  if (Array.isArray(cache.list)) cache.list.length = 0;
}

function destroyEntry(entry: HostEntry): void {
  entry.httpAgent.destroy();
  entry.httpsAgent.destroy();
  clearTlsSessions(entry.httpsAgent);
}

function sameAddresses(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((address, index) => address === right[index]);
}

function scheduleDestroy(entry: HostEntry): void {
  setTimeout(() => destroyEntry(entry), getUpstreamTimeoutMs() + DESTROY_GRACE_MS).unref();
}

function dropHost(host: string): void {
  const entry = hostCache.get(host);
  if (!entry) return;
  hostCache.delete(host);
  scheduleDestroy(entry);
}

function storeHost(host: string, entry: HostEntry): void {
  dropHost(host); // Replace any existing entry.
  hostCache.set(host, entry);
  const max = getConnectionCacheMax();
  while (hostCache.size > max) {
    const oldest = hostCache.keys().next();
    if (oldest.done) break;
    dropHost(oldest.value); // Evict least-recently-added.
  }
}

async function getHostEntry(host: string, rawUrl: string, opts: ResolveOptions): Promise<HostEntry> {
  const cached = hostCache.get(host);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const pending = resolving.get(host);
  if (pending) return pending;

  const task = (async (): Promise<HostEntry> => {
    const { addresses } = await resolvePublicUrl(rawUrl, opts);
    const previous = hostCache.get(host);
    if (previous && sameAddresses(previous.addresses, addresses)) {
      previous.expiresAt = Date.now() + getConnectionCacheTtlMs();
      return previous;
    }
    const agents = pinnedAgents(addresses, true);
    const entry: HostEntry = { addresses, ...agents, expiresAt: Date.now() + getConnectionCacheTtlMs() };
    storeHost(host, entry);
    return entry;
  })();
  resolving.set(host, task);
  try {
    return await task;
  } finally {
    resolving.delete(host);
  }
}

export async function resolveConnection(rawUrl: string, opts: ResolveOptions = {}): Promise<Connection> {
  const parsed = parseUpstreamUrl(rawUrl);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const perRequestPrivate = opts.allowPrivateHost === true && isPrivateArtAllowed();

  if (perRequestPrivate) {
    const { url, addresses } = await resolvePublicUrl(rawUrl, opts);
    return { url, ...pinnedAgents(addresses, false) };
  }

  const entry = await getHostEntry(host, rawUrl, opts);
  return { url: parsed, httpAgent: entry.httpAgent, httpsAgent: entry.httpsAgent };
}

export function getConnectionCacheStats(): { size: number; max: number } {
  return { size: hostCache.size, max: getConnectionCacheMax() };
}

export function _resetConnectionCache(): void {
  for (const entry of hostCache.values()) destroyEntry(entry);
  hostCache.clear();
  resolving.clear();
}

export interface FetchedImage {
  body: Buffer;
  contentType: string;
  upstream?: UpstreamCacheMeta;
}

/** The origin confirmed the bytes we already hold — there is no body to read. */
export interface NotModifiedImage {
  notModified: true;
  upstream?: UpstreamCacheMeta;
}

export type FetchOutcome = FetchedImage | NotModifiedImage;

export function isNotModified(outcome: FetchOutcome): outcome is NotModifiedImage {
  return (outcome as NotModifiedImage).notModified === true;
}


export class OversizeImage extends Error {
  stream: NodeJS.ReadableStream;
  contentType: string;
  declaredLength: number;
  /** Carried so a `no-store` origin is still relayed honestly on the bypass path. */
  upstream?: UpstreamCacheMeta;

  constructor(
    stream: NodeJS.ReadableStream,
    contentType: string,
    declaredLength: number,
    upstream?: UpstreamCacheMeta
  ) {
    super(`Image exceeds the cacheable size limit (${declaredLength} bytes)`);
    this.stream = stream;
    this.contentType = contentType;
    this.declaredLength = declaredLength;
    this.upstream = upstream;
  }
}

const MAX_REDIRECTS = 5;

let active = 0;
const waiting: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < getFetchConcurrency()) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) {
    // Hand the slot straight over rather than decrementing and racing.
    next();
    return;
  }
  active -= 1;
}

export function getInFlightCount(): number {
  return active;
}

export function getQueuedCount(): number {
  return waiting.length;
}

export interface UpstreamStream {
  response: any;
  contentType: string;
  upstream: UpstreamCacheMeta;
  /** True when the origin answered 304: `response.data` is empty and already destroyed. */
  notModified: boolean;
}

export async function openImageStream(rawUrl: string, opts: FetchOptions = {}): Promise<UpstreamStream> {
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { url, httpAgent, httpsAgent } = await resolveConnection(current, hop === 0 ? opts : {});

    const headers: Record<string, string> = { 'User-Agent': `AIOMetadata/${buildInfo.version}` };
    if (opts.validators?.etag) headers['If-None-Match'] = opts.validators.etag;
    if (opts.validators?.lastModified) headers['If-Modified-Since'] = opts.validators.lastModified;

    const response = await axios.get(url.toString(), {
      responseType: 'stream',
      timeout: getUpstreamTimeoutMs(),
      maxRedirects: 0,
      httpAgent,
      httpsAgent,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      decompress: true,
      validateStatus: (status: number) => (status >= 200 && status < 300) || (status >= 300 && status < 400),
      headers,
    });

    // Before the redirect branch: a 304 sits in the 3xx range but carries no
    // Location, and would otherwise be rejected as a broken redirect.
    if (response.status === 304) {
      response.data?.destroy?.();
      return {
        response,
        contentType: '',
        upstream: parseUpstreamCacheMeta(response.headers),
        notModified: true,
      };
    }

    if (response.status >= 300 && response.status < 400) {
      response.data?.destroy?.();
      const location = response.headers['location'];
      if (!location) {
        throw new UpstreamRejected(`Redirect without Location from ${url.host}`, 502);
      }
      current = new URL(location, url.toString()).toString();
      continue;
    }

    const header = String(response.headers['content-type'] || '').split(';')[0].trim();
    // Some CDNs fronting the art providers send no content type at all and the
    // bytes are still an image, so the extension decides when the header is
    // silent rather than the response being thrown away.
    const contentType = header || imageTypeFromPath(current);

    if (!contentType.startsWith('image/')) {
      response.data?.destroy?.();
      throw new UpstreamRejected(`Upstream returned non-image content: ${header || 'unknown'}`, 502);
    }

    return { response, contentType, upstream: parseUpstreamCacheMeta(response.headers), notModified: false };
  }

  throw new UpstreamRejected('Too many redirects', 502);
}


export async function fetchImage(rawUrl: string, opts: FetchOptions = {}): Promise<FetchOutcome> {
  const maxBytes = getMaxObjectBytes();
  await acquire();

  let response: any;
  let contentType: string;
  let upstream: UpstreamCacheMeta;
  let notModified: boolean;
  try {
    ({ response, contentType, upstream, notModified } = await openImageStream(rawUrl, opts));
  } catch (error) {
    release();
    throw error;
  }

  if (notModified) {
    release();
    return { notModified: true, upstream };
  }

  const declared = Number.parseInt(response.headers['content-length'] || '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    const oversize = new OversizeImage(response.data, contentType, declared, upstream);
    const finish = () => release();
    response.data.once('close', finish);
    response.data.once('error', finish);
    throw oversize;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response.data) {
      size += chunk.length;
      if (size > maxBytes) {
        response.data.destroy();
        throw new UpstreamRejected(`Image exceeds the ${maxBytes} byte limit`, 502);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    response.data?.destroy?.();
    throw error;
  } finally {
    release();
  }

  return { body: Buffer.concat(chunks), contentType, upstream };
}
