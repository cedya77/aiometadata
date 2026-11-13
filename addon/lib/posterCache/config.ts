// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import * as path from 'node:path';
import consola from 'consola';
import { parseDurationMs } from './duration';

const logger = consola.withTag('PosterCache');


export type ImageClass = 'poster' | 'background' | 'landscape' | 'logo' | 'thumbnail' | 'cast' | 'collection' | 'processed';

/** Every class the store can hold — used for stats, purging and eviction. */
export const IMAGE_CLASSES: ImageClass[] = [
  'poster',
  'background',
  'landscape',
  'logo',
  'thumbnail',
  'cast',
  'collection',
  'processed',
];

export const URL_ADDRESSABLE_CLASSES: ImageClass[] = IMAGE_CLASSES.filter(
  (imageClass) => imageClass !== 'processed'
);

/** Meta field name -> cache class. `poster` is always on; the rest are opt-in. */
export const META_FIELD_CLASSES: Record<string, ImageClass> = {
  poster: 'poster',
  background: 'background',
  landscapePoster: 'landscape',
  logo: 'logo',
};

/** Env var gating each class. `poster` has no toggle — it is the default. */
const CLASS_ENV: Record<Exclude<ImageClass, 'poster'>, string> = {
  background: 'POSTER_CACHE_BACKGROUNDS',
  landscape: 'POSTER_CACHE_LANDSCAPE_POSTERS',
  logo: 'POSTER_CACHE_LOGOS',
  thumbnail: 'POSTER_CACHE_THUMBNAILS',
  cast: 'POSTER_CACHE_CAST',
  collection: 'POSTER_CACHE_COLLECTIONS',
  processed: 'POSTER_CACHE_PROCESSED_IMAGES',
};

export function isTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value || '');
}

export function isExplicitlyDisabled(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test((value || '').trim());
}

/** Registry first, so a dashboard value is honoured; the fallback covers names it does not know. */
function env(name: string): string | undefined {
  const fromRegistry = require('../settingsService').getSetting(name);
  return fromRegistry !== '' && fromRegistry !== undefined ? fromRegistry : process.env[name];
}

export function isBuiltinPosterCacheEnabled(): boolean {
  return isTruthy(env('ENABLE_BUILTIN_POSTER_CACHE'));
}

export function isClassEnabled(imageClass: ImageClass): boolean {
  if (!isBuiltinPosterCacheEnabled()) return false;
  if (imageClass === 'poster') return true;
  if (imageClass === 'processed' || imageClass === 'collection') return !isExplicitlyDisabled(process.env[CLASS_ENV[imageClass]]);
  return isTruthy(process.env[CLASS_ENV[imageClass]]);
}

export function getEnabledClasses(): ImageClass[] {
  return IMAGE_CLASSES.filter(isClassEnabled);
}

export function isFieldCacheable(field: string): boolean {
  const imageClass = META_FIELD_CLASSES[field];
  if (!imageClass) return false;
  if (!isBuiltinPosterCacheEnabled()) {
    return imageClass === 'poster' && !!getPosterProxyPrefix();
  }
  return isClassEnabled(imageClass);
}

export function getCacheableFields(): string[] {
  return Object.keys(META_FIELD_CLASSES).filter(isFieldCacheable);
}

export function buildCachedUrl(base: string, imageClass: ImageClass, url: string): string {
  if (!isBuiltinPosterCacheEnabled()) return `${base}/${url}`;
  return `${base}/${imageClass}/${url}`;
}

export function isValidImageClass(value: unknown): value is ImageClass {
  return typeof value === 'string' && (IMAGE_CLASSES as string[]).includes(value);
}

function normalizeBase(value: string | undefined): string {
  const trimmed = (value || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export const POSTER_CACHE_ROUTE = '/poster-cache';

export function getPosterProxyPrefix(): string {
  const explicit = (env('POSTER_PROXY_PREFIX_URL') || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  if (!isBuiltinPosterCacheEnabled()) return '';
  const host = normalizeBase(env('HOST_NAME'));
  return host ? `${host}${POSTER_CACHE_ROUTE}` : '';
}

/** Where a collection layout's images are served from when routed through the cache; empty when there is no cache. */
export function getCollectionImagePrefix(): string {
  const prefix = getPosterProxyPrefix();
  if (!prefix) return '';
  return isBuiltinPosterCacheEnabled() ? `${prefix}/collection` : prefix;
}

export function getPosterWarmupBase(): string {
  const explicit = (env('POSTER_WARMUP_URL') || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  if (isBuiltinPosterCacheEnabled()) {
    const port = parseInt(env('PORT') || '3232', 10);
    return `http://127.0.0.1:${port}${POSTER_CACHE_ROUTE}`;
  }
  return getPosterProxyPrefix();
}

/**
 * Base for the rendered-art URLs the warmer fetches. It stays on loopback so a
 * warm run never leaves the box: routing it through HOST_NAME sent every poster
 * out through the CDN and back for no gain, since the fetch only exists to fill
 * the local store.
 */
export function getProxyArtWarmBase(): string {
  const explicit = (env('IMAGE_WARM_PROXY_BASE') || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const port = parseInt(env('PORT') || '3232', 10);
  return `http://127.0.0.1:${port}${POSTER_CACHE_ROUTE}/proxy`;
}

export function getSelfOrigin(): string {
  const host = normalizeBase(env('HOST_NAME'));
  if (!host) return '';
  try {
    return new URL(host).origin;
  } catch {
    return '';
  }
}

export function getCacheDir(): string {
  const configured = (env('POSTER_CACHE_DIR') || '').trim();
  if (configured) return configured;
  return path.join(process.cwd(), 'addon', 'data', 'poster-cache');
}

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
};

export function parseSize(value: string | undefined): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(value || '');
  if (!match) return null;
  const amount = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit ? SIZE_UNITS[unit] : 1;
  if (!multiplier || !Number.isFinite(amount)) return null;
  return Math.floor(amount * multiplier);
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${bytes}B`;
}

/** Disk budget for stored images. */
export const DEFAULT_MAX_SIZE = '10g';

export function getMaxSizeRaw(): string {
  return (env('POSTER_CACHE_MAX_SIZE') || '').trim() || DEFAULT_MAX_SIZE;
}

export function getMaxBytes(): number {
  return parseSize(getMaxSizeRaw()) ?? parseSize(DEFAULT_MAX_SIZE)!;
}

export const DEFAULT_MEMORY_SIZE = '128m';

export function getMemorySizeRaw(): string {
  const raw = (env('POSTER_CACHE_MEMORY_SIZE') ?? '').trim();
  return raw !== '' ? raw : DEFAULT_MEMORY_SIZE;
}

export function getMemoryBudget(): number {
  const parsed = parseSize(getMemorySizeRaw());
  return parsed === null ? parseSize(DEFAULT_MEMORY_SIZE)! : parsed;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The directives one `Cache-Control`-shaped header field carries. */
export interface CacheDirectives {
  maxAge?: number;
  sMaxAge?: number;
  immutable?: boolean;
  noStore?: boolean;
  noCache?: boolean;
  mustRevalidate?: boolean;
}

export interface UpstreamCacheMeta extends CacheDirectives {
  age?: number;
  date?: number;
  expires?: number;
  etag?: string;
  lastModified?: string;
  lastModifiedAt?: number;
  cdn?: CacheDirectives;
}

const MAX_AGE_RE = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/;
const SHARED_MAX_AGE_RE = /(?:^|,)\s*s-maxage\s*=\s*"?(\d+)"?/;
const NO_STORE_RE = /(?:^|,)\s*no-store\s*(?:,|$)/;
const NO_CACHE_RE = /(?:^|,)\s*no-cache\s*(?:,|$)/;
const IMMUTABLE_RE = /(?:^|,)\s*immutable\s*(?:,|$)/;
const MUST_REVALIDATE_RE = /(?:^|,)\s*must-revalidate\s*(?:,|$)/;

/** An HTTP date we cannot read is no date at all — never a NaN handed to the policy. */
function parseHttpDate(value: unknown): number | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Reads one `Cache-Control`-shaped field. `undefined` when the field is absent or empty. */
function parseCacheDirectives(raw: unknown): CacheDirectives | undefined {
  const value = String(raw || '').toLowerCase();
  if (!value.trim()) return undefined;

  const directives: CacheDirectives = {};
  if (NO_STORE_RE.test(value)) directives.noStore = true;
  if (NO_CACHE_RE.test(value)) directives.noCache = true;
  if (MUST_REVALIDATE_RE.test(value)) directives.mustRevalidate = true;
  if (IMMUTABLE_RE.test(value)) directives.immutable = true;
  const shared = SHARED_MAX_AGE_RE.exec(value)?.[1];
  if (shared !== undefined) directives.sMaxAge = Number(shared);
  const seconds = MAX_AGE_RE.exec(value)?.[1];
  if (seconds !== undefined) directives.maxAge = Number(seconds);
  return directives;
}

/** Reads the freshness promise and validators off a response. Absent fields stay absent. */
export function parseUpstreamCacheMeta(headers: Record<string, any> = {}): UpstreamCacheMeta {
  const meta: UpstreamCacheMeta = { ...parseCacheDirectives(headers['cache-control']) };

  const cdn = parseCacheDirectives(headers['cdn-cache-control']);
  if (cdn) meta.cdn = cdn;

  const age = Number.parseInt(String(headers['age'] ?? ''), 10);
  if (Number.isFinite(age) && age >= 0) meta.age = age;

  const date = parseHttpDate(headers['date']);
  if (date !== undefined) meta.date = date;

  const expires = parseHttpDate(headers['expires']);
  if (expires !== undefined) meta.expires = expires;

  const etag = String(headers['etag'] || '').trim();
  if (etag) meta.etag = etag;

  const lastModified = String(headers['last-modified'] || '').trim();
  if (lastModified) {
    meta.lastModified = lastModified;
    const lastModifiedAt = parseHttpDate(lastModified);
    if (lastModifiedAt !== undefined) meta.lastModifiedAt = lastModifiedAt;
  }

  return meta;
}

export const DEFAULT_TTL_DAYS = 30;
export const MAX_TTL_DAYS = 365;

function ttlDaysFrom(raw: string | undefined, fallback: number): number {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getEntryTtlDays(): number {
  return ttlDaysFrom(env('POSTER_CACHE_TTL_DAYS'), DEFAULT_TTL_DAYS);
}

export function getEntryTtlMs(): number {
  const days = getEntryTtlDays();
  return days > 0 ? days * DAY_MS : Infinity;
}

export function isInferTtlEnabled(): boolean {
  return isTruthy(env('POSTER_CACHE_INFER_TTL'));
}

export const DO_NOT_STORE = Symbol('do-not-store');

export type InferredFreshness = number | null | typeof DO_NOT_STORE;

const ONE_YEAR_MS = MAX_TTL_DAYS * DAY_MS;

const HEURISTIC_MIN_ELAPSED_SECONDS = 10 * 24 * 60 * 60;

function zero(upstream: UpstreamCacheMeta, revalidatable: boolean): number | null {
  return (revalidatable || upstream.etag || upstream.lastModified) ? 0 : null;
}

// RFC 9111
function heuristicSeconds(upstream: UpstreamCacheMeta): number | null {
  if (upstream.lastModifiedAt === undefined || upstream.date === undefined) return null;
  const elapsed = (upstream.date - upstream.lastModifiedAt) / 1000;
  if (elapsed < HEURISTIC_MIN_ELAPSED_SECONDS) return null;
  return elapsed * 0.10;
}

function expiresSeconds(upstream: UpstreamCacheMeta): number | null {
  return upstream.expires !== undefined && upstream.date !== undefined
    ? (upstream.expires - upstream.date) / 1000
    : null;
}

function remainingMs(
  lifetimeSeconds: number,
  upstream: UpstreamCacheMeta,
  revalidatable: boolean
): InferredFreshness {
  const remaining = lifetimeSeconds - (upstream.age ?? 0);
  if (remaining <= 0) return zero(upstream, revalidatable);
  return Math.min(ONE_YEAR_MS, remaining * 1000);
}

function freshnessFrom(
  directives: CacheDirectives,
  upstream: UpstreamCacheMeta,
  lifetime: () => number | null,
  revalidatable: boolean
): InferredFreshness {
  if (directives.noStore) return DO_NOT_STORE;
  if (directives.noCache) return zero(upstream, revalidatable);
  if (directives.immutable) return ONE_YEAR_MS;
  const lifetimeSeconds = lifetime();
  if (lifetimeSeconds === null) return null; // Nothing was promised at all.
  return remainingMs(lifetimeSeconds, upstream, revalidatable);
}

export function inferFreshnessMs(upstream?: UpstreamCacheMeta): InferredFreshness {
  if (!upstream) return null;

  if (upstream.cdn) {
    const targeted = freshnessFrom(upstream.cdn, upstream, () =>
      upstream.cdn!.sMaxAge ?? upstream.cdn!.maxAge ?? null, false);
    if (targeted !== null) return targeted;
  }

  return freshnessFrom(upstream, upstream, () =>
    upstream.sMaxAge ?? upstream.maxAge ?? expiresSeconds(upstream) ?? heuristicSeconds(upstream), false);
}

export function inferClientFreshnessMs(
  upstream?: UpstreamCacheMeta,
  revalidatable = false
): InferredFreshness {
  if (!upstream) return null;
  return freshnessFrom(upstream, upstream, () =>
    upstream.maxAge ?? expiresSeconds(upstream) ?? heuristicSeconds(upstream), revalidatable);
}

// --- per-provider policy --------------------------------------------------

export { parseDurationMs };

export type TtlPolicy = 'default' | 'infer' | 'custom' | 'bypass';

export interface ProviderPolicy {
  domain: string;
  policy: TtlPolicy;
  ttl?: string;
}

export interface ResolvedPolicy {
  policy: TtlPolicy;
  ttlMs?: number;
}

export interface ProviderPreset {
  policy: TtlPolicy;
  ttl?: string;
}

export const KNOWN_ART_PROVIDERS: ReadonlyArray<{
  domain: string;
  group: 'source' | 'rating';
  preset?: ProviderPreset;
}> = [
  { domain: 'image.tmdb.org', group: 'source', preset: { policy: 'infer' } },
  { domain: 'artworks.thetvdb.com', group: 'source', preset: { policy: 'default' } },
  { domain: 'cdn.myanimelist.net', group: 'source', preset: { policy: 'default' } },
  { domain: 'media.kitsu.app', group: 'source', preset: { policy: 'default' } },
  { domain: 'assets.fanart.tv', group: 'source', preset: { policy: 'default' } },
  { domain: 'images.metahub.space', group: 'source', preset: { policy: 'default' } },
  { domain: 'api.ratingposterdb.com', group: 'rating', preset: { policy: 'infer' } },
  { domain: 'api.top-posters.com', group: 'rating', preset: { policy: 'infer' } },
  { domain: 'btttr.cc', group: 'rating', preset: { policy: 'infer' } },
  { domain: 'extendedratings.com', group: 'rating', preset: { policy: 'infer' } },
  { domain: 'postersplus.elfhosted.com', group: 'rating', preset: { policy: 'infer' } },
];

const TTL_POLICIES: TtlPolicy[] = ['default', 'infer', 'custom', 'bypass'];

export function parseProviderPolicies(raw: unknown): ProviderPolicy[] | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const rules: ProviderPolicy[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const { domain, policy, ttl } = candidate as Record<string, unknown>;
    if (typeof domain !== 'string' || domain.trim() === '') return null;
    if (typeof policy !== 'string' || !TTL_POLICIES.includes(policy as TtlPolicy)) return null;
    if (policy === 'custom' && parseDurationMs(ttl) === null) return null;
    rules.push({
      domain: domain.trim().toLowerCase().replace(/^\.+/, ''),
      policy: policy as TtlPolicy,
      ttl: typeof ttl === 'string' ? ttl : undefined,
    });
  }
  return rules;
}

// Memoised per value: this is read on every cache read, and the parse is not.
let policyRaw: string | null = null;
let policyRules: ProviderPolicy[] = [];

function activeRules(): ProviderPolicy[] {
  const raw = env('POSTER_CACHE_PROVIDER_POLICIES') ?? '';
  if (raw === policyRaw) return policyRules;

  policyRaw = raw;
  const parsed = parseProviderPolicies(raw);
  if (parsed === null) {
    logger.warn(
      'POSTER_CACHE_PROVIDER_POLICIES is not valid — ignoring it, so every provider falls back to its bucket default'
    );
    policyRules = [];
  } else {
    policyRules = parsed;
  }
  return policyRules;
}

export const KEY_PREFIXES: readonly string[] = ['rating-poster:', 'blur:', 'b2b:'];

export function hostFromKey(key: string): string | null {
  let candidate = key;
  for (const prefix of KEY_PREFIXES) {
    if (candidate.startsWith(prefix)) {
      candidate = candidate.slice(prefix.length);
      break;
    }
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Exact host or dot-suffix, so `elfhosted.com` covers `postersplus.elfhosted.com`. */
function ruleFor(host: string, rules: ProviderPolicy[]): ProviderPolicy | null {
  let best: ProviderPolicy | null = null;
  for (const rule of rules) {
    if (host !== rule.domain && !host.endsWith(`.${rule.domain}`)) continue;
    // Most specific wins, so the answer does not depend on how the list is ordered.
    if (!best || rule.domain.length > best.domain.length) best = rule;
  }
  return best;
}

export function arePresetsEnabled(): boolean {
  return !isExplicitlyDisabled(env('POSTER_CACHE_PROVIDER_PRESETS'));
}

const PRESET_RULES: ProviderPolicy[] = KNOWN_ART_PROVIDERS
  .filter((provider) => provider.preset)
  .map((provider) => ({
    domain: provider.domain,
    policy: provider.preset!.policy,
    ttl: provider.preset!.ttl,
  }));

function resolvedFrom(rule: ProviderPolicy): ResolvedPolicy {
  return rule.policy === 'custom'
    ? { policy: 'custom', ttlMs: parseDurationMs(rule.ttl)! }
    : { policy: rule.policy };
}

/**
 * Lives here rather than in `proxyResponse.ts` because `resolveProxyPolicy`
 * consults it and `proxyResponse.ts` imports this module — the other direction
 * would be a cycle.
 */
export function followsUpstreamCacheControl(): boolean {
  return isTruthy(env('POSTER_PROXY_FOLLOW_UPSTREAM'));
}

export function resolvePolicyFor(key: string): ResolvedPolicy {
  const rules = activeRules();
  const presets = arePresetsEnabled();
  const host = rules.length > 0 || presets ? hostFromKey(key) : null;

  if (host && rules.length > 0) {
    const rule = ruleFor(host, rules);
    if (rule) return resolvedFrom(rule);
  }

  if (host && presets) {
    const preset = ruleFor(host, PRESET_RULES);
    if (preset) return resolvedFrom(preset);
  }

  return { policy: isInferTtlEnabled() ? 'infer' : 'default' };
}

/**
 * What the art proxy should tell a client, for art that passes through without
 * being stored. Ordered by explicitness rather than by layer, and independent of
 * whether the built-in store is on.
 *
 * `null` means nobody spoke — the caller keeps its existing behaviour, which is
 * what makes this inert on installs with no rules.
 */
export function resolveProxyPolicy(key: string): ResolvedPolicy | null {
  const rules = activeRules();
  const presets = arePresetsEnabled();
  // Lazy, as in `resolvePolicyFor`: this runs on every proxied art request, and
  // with no rules and presets off there is nothing to match a host against.
  const host = rules.length > 0 || presets ? hostFromKey(key) : null;

  if (host && rules.length > 0) {
    const rule = ruleFor(host, rules);
    if (rule) return resolvedFrom(rule);
  }

  // An install-wide choice to relay verbatim outranks a preset we chose for them.
  if (followsUpstreamCacheControl()) return null;

  if (host && presets) {
    const preset = ruleFor(host, PRESET_RULES);
    if (preset) return resolvedFrom(preset);
  }

  return null;
}

/**
 * A `bypass` rule is a statement about the provider, not about our storage — with
 * the store off it still means "serve this without anyone keeping a copy". The two
 * call sites that record BYPASS metrics test the store themselves
 * (`addon/index.js:5077`, `:5133`), so nothing else has to move.
 */
export function isBypassed(key: string): boolean {
  return resolvePolicyFor(key).policy === 'bypass';
}

export function resolveEntryTtlMs(key: string, upstream?: UpstreamCacheMeta): number {
  const flatMs = getEntryTtlMs();
  const { policy, ttlMs } = resolvePolicyFor(key);

  if (policy === 'custom') return ttlMs!;
  if (policy !== 'infer') return flatMs;

  const inferred = inferFreshnessMs(upstream);
  if (inferred === DO_NOT_STORE) return 0;
  return inferred === null ? flatMs : inferred;
}

export function inferredTtlMsFor(upstream?: UpstreamCacheMeta): number | null {
  const inferred = inferFreshnessMs(upstream);
  return inferred === DO_NOT_STORE ? 0 : inferred;
}

export function resolveEntryTtlMsFrom(key: string, inferredMs: number | null): number {
  const flatMs = getEntryTtlMs();
  const { policy, ttlMs } = resolvePolicyFor(key);

  if (policy === 'custom') return ttlMs!;
  if (policy !== 'infer') return flatMs;
  return inferredMs === null ? flatMs : inferredMs;
}

export function isNotStorable(key: string, upstream?: UpstreamCacheMeta): boolean {
  return resolvePolicyFor(key).policy === 'infer' && inferFreshnessMs(upstream) === DO_NOT_STORE;
}

export function getEntryExpiry(key: string, storedAt: number, upstream?: UpstreamCacheMeta): number {
  const ttl = resolveEntryTtlMs(key, upstream);
  return Number.isFinite(ttl) ? storedAt + ttl : Infinity;
}

export function getEntryExpiryFrom(key: string, storedAt: number, inferredMs: number | null): number {
  const ttl = resolveEntryTtlMsFrom(key, inferredMs);
  return Number.isFinite(ttl) ? storedAt + ttl : Infinity;
}

const MAX_BROWSER_MAX_AGE = 365 * 24 * 60 * 60;

export function getBrowserMaxAgeSeconds(): number {
  const ttl = getEntryTtlMs();
  if (!Number.isFinite(ttl)) return MAX_BROWSER_MAX_AGE;
  return Math.min(MAX_BROWSER_MAX_AGE, Math.max(60, Math.floor(ttl / 1000)));
}

export function clampBrowserMaxAge(seconds: number): number {
  if (!Number.isFinite(seconds)) return MAX_BROWSER_MAX_AGE;
  return Math.min(MAX_BROWSER_MAX_AGE, Math.max(60, Math.floor(seconds)));
}

export function browserMaxAgeFor(expiresAt: number): number {
  if (!Number.isFinite(expiresAt)) return MAX_BROWSER_MAX_AGE;
  return clampBrowserMaxAge((expiresAt - Date.now()) / 1000);
}

export const DEFAULT_PROXY_MAX_AGE_DAYS = 1;

export function getProxyMaxAgeDays(): number {
  const raw = (env('POSTER_PROXY_MAX_AGE_DAYS') ?? '').trim();
  if (raw === '') return DEFAULT_PROXY_MAX_AGE_DAYS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_PROXY_MAX_AGE_DAYS;
}

export function getProxyMaxAgeSeconds(): number {
  const days = getProxyMaxAgeDays();
  return days > 0
    ? Math.min(MAX_BROWSER_MAX_AGE, Math.max(60, Math.floor(days * 24 * 60 * 60)))
    : MAX_BROWSER_MAX_AGE;
}

export function getInactiveDays(): number {
  const parsed = parseInt(env('POSTER_CACHE_INACTIVE_DAYS') || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

export function getMaxObjectBytes(): number {
  const parsed = parseSize(env('POSTER_CACHE_MAX_OBJECT_BYTES'));
  return parsed && parsed > 0 ? parsed : 20 * 1024 * 1024;
}

export function getUpstreamTimeoutMs(): number {
  const parsed = parseInt(env('POSTER_PROXY_TIMEOUT_MS') || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10000;
}

export const LEGACY_NGINX_CACHE_DIRS = [
  '/var/cache/nginx/posters',
  '/var/cache/nginx',
];

const IMPORT_DISABLED = /^(0|false|no|off|none|disabled)$/i;

export function getNginxImportDir(): string {
  const raw = (env('POSTER_CACHE_IMPORT_NGINX_DIR') || '').trim();
  return IMPORT_DISABLED.test(raw) ? '' : raw;
}

export function isNginxImportDisabled(): boolean {
  return IMPORT_DISABLED.test((env('POSTER_CACHE_IMPORT_NGINX_DIR') || '').trim());
}

export function getFetchConcurrency(): number {
  const parsed = parseInt(env('POSTER_CACHE_FETCH_CONCURRENCY') || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 128;
}

function intEnv(name: string, fallback: number, min: number): number {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export function getWarmQueueMax(): number {
  return intEnv('IMAGE_WARM_QUEUE_MAX', 50000, 1);
}

export function getWarmConcurrencyMin(): number {
  return intEnv('IMAGE_WARM_CONCURRENCY_MIN', 4, 1);
}

export function getWarmConcurrencyMax(): number {
  return Math.max(getWarmConcurrencyMin(), intEnv('IMAGE_WARM_CONCURRENCY_MAX', 48, 1));
}

export function getWarmTargetLagMs(): number {
  return intEnv('IMAGE_WARM_TARGET_LAG_MS', 20, 1);
}

export function isWarmQueueEnabled(): boolean {
  return !isExplicitlyDisabled(env('IMAGE_WARM_QUEUE'));
}

export function getStreamThresholdBytes(): number {
  const parsed = parseSize(env('POSTER_CACHE_STREAM_THRESHOLD'));
  return parsed && parsed > 0 ? parsed : 256 * 1024;
}

/** How long a validated host's pinned addresses and pooled agents are reused. */
export function getConnectionCacheTtlMs(): number {
  const parsed = parseInt(env('POSTER_CACHE_AGENT_TTL_MS') || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
}

/** Upper bound on distinct hosts pooled at once — the key is attacker-influenced. */
export function getConnectionCacheMax(): number {
  const parsed = parseInt(env('POSTER_CACHE_AGENT_MAX') || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 512;
}

export function getTlsSessionCacheMax(): number {
  const parsed = parseInt(env('POSTER_CACHE_TLS_SESSIONS') || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10;
}

export function shouldLogRequests(): boolean {
  return isTruthy(env('POSTER_CACHE_LOG_REQUESTS'));
}

export function isPrivateArtAllowed(): boolean {
  return !isExplicitlyDisabled(env('POSTER_PROXY_ALLOW_PRIVATE'));
}

export function getAllowedPrivateHosts(): Set<string> {
  const raw = env('POSTER_CACHE_ALLOWED_HOSTS') || '';
  return new Set(raw.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean));
}
