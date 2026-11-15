// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { ServerResponse } from 'node:http';
import {
  DO_NOT_STORE,
  browserMaxAgeFor,
  clampBrowserMaxAge,
  followsUpstreamCacheControl,
  getBrowserMaxAgeSeconds,
  getProxyMaxAgeSeconds,
  inferClientFreshnessMs,
  parseUpstreamCacheMeta,
  type ResolvedPolicy,
  type UpstreamCacheMeta,
} from './config.js';

export type ResponseSurface = 'proxy' | 'direct';

export interface ProxyResponseInput {
  entry?: { expiresAt?: number; etag?: string; upstream?: UpstreamCacheMeta } | null;
  status?: string | null;
  upstreamHeaders?: Record<string, unknown> | null;
  surface?: ResponseSurface;
  notStorable?: boolean;
  /** A per-provider policy resolved by the caller. `null`/absent means nobody spoke. */
  policy?: ResolvedPolicy | null;
}

export interface ProxyResponseHeaders {
  'Cache-Control': string;
  'CDN-Cache-Control'?: string;
  ETag?: string;
  'Last-Modified'?: string;
  Age?: string;
}

function withoutWeakPrefix(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('W/') ? trimmed.slice(2).trim() : trimmed;
}

export function etagMatches(ifNoneMatch: unknown, etag: string | undefined): boolean {
  if (typeof ifNoneMatch !== 'string' || !etag) return false;
  if (ifNoneMatch.trim() === '*') return true;
  const target = withoutWeakPrefix(etag);
  const candidates = ifNoneMatch.match(/(?:W\/)?"[^"]*"/g) || [];
  return candidates.some((candidate) => withoutWeakPrefix(candidate) === target);
}

interface ClientTerms {
  verdict?: string;
  maxAge: number;
  mustRevalidate: boolean;
}

function clientTerms(
  upstream: UpstreamCacheMeta | undefined,
  maxAge: number,
  revalidatable = false
): ClientTerms {
  const client = inferClientFreshnessMs(upstream, revalidatable);
  if (client === DO_NOT_STORE) return { verdict: 'no-store', maxAge, mustRevalidate: false };
  if (upstream?.noCache) return { verdict: 'public, no-cache', maxAge, mustRevalidate: false };
  return {
    maxAge: client === null ? maxAge : Math.min(maxAge, clampBrowserMaxAge(client / 1000)),
    mustRevalidate: !!upstream?.mustRevalidate,
  };
}

function renderTerms(terms: ClientTerms, stale: boolean): string {
  if (terms.verdict) return terms.verdict;
  if (terms.mustRevalidate) return `public, max-age=${terms.maxAge}, must-revalidate`;
  return stale ? lifetime(terms.maxAge) : `public, max-age=${terms.maxAge}`;
}

function ourCacheControl(entry?: ProxyResponseInput['entry']): string {
  let maxAge = getProxyMaxAgeSeconds();
  if (entry && Number.isFinite(entry.expiresAt)) {
    maxAge = Math.min(maxAge, browserMaxAgeFor(entry.expiresAt as number));
  }
  return renderTerms(clientTerms(entry?.upstream, maxAge, !!entry?.etag), true);
}

function upstreamHeaderValue(
  headers: ProxyResponseInput['upstreamHeaders'],
  name: string
): string | null {
  const raw = headers?.[name];
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value === '' ? null : value;
}

function upstreamValidators(upstream: UpstreamCacheMeta): Partial<ProxyResponseHeaders> {
  const out: Partial<ProxyResponseHeaders> = {};
  if (upstream.etag) out.ETag = upstream.etag;
  if (upstream.lastModified) out['Last-Modified'] = upstream.lastModified;
  return out;
}

function upstreamAge(upstream: UpstreamCacheMeta): string | undefined {
  return upstream.age === undefined ? undefined : String(upstream.age);
}

function lifetime(maxAge: number): string {
  return `public, max-age=${maxAge}, stale-while-revalidate=${maxAge}`;
}

function passThroughCacheControl(upstream: UpstreamCacheMeta): string {
  return renderTerms(clientTerms(upstream, getProxyMaxAgeSeconds()), true);
}

function policyCacheControl(policy: ResolvedPolicy, upstream: UpstreamCacheMeta): string {
  switch (policy.policy) {
    case 'bypass': return 'no-store';
    case 'custom': return lifetime(clampBrowserMaxAge(policy.ttlMs! / 1000));
    case 'default': return lifetime(getProxyMaxAgeSeconds());
    case 'infer': return passThroughCacheControl(upstream);
  }
}

export function proxyResponseHeaders(input: ProxyResponseInput = {}): ProxyResponseHeaders {
  const { entry, status, upstreamHeaders, surface = 'proxy', notStorable, policy } = input;

  if (status === 'BYPASS') {
    const headers: ProxyResponseHeaders = { 'Cache-Control': 'no-store' };
    if (entry?.etag) headers.ETag = `"${entry.etag}"`;
    return headers;
  }

  if (entry) {
    const headers: ProxyResponseHeaders = {
      'Cache-Control': surface === 'direct'
        ? renderTerms(clientTerms(entry.upstream, browserMaxAgeFor(entry.expiresAt as number), !!entry.etag), false)
        : ourCacheControl(entry),
    };
    if (entry.etag) headers.ETag = `"${entry.etag}"`;
    return headers;
  }

  if (surface === 'direct') {
    return { 'Cache-Control': notStorable ? 'no-store' : `public, max-age=${getBrowserMaxAgeSeconds()}` };
  }

  const upstream = parseUpstreamCacheMeta((upstreamHeaders ?? {}) as Record<string, any>);

  if (policy) {
    return {
      'Cache-Control': policyCacheControl(policy, upstream),
      ...upstreamValidators(upstream),
    };
  }

  const followed = followsUpstreamCacheControl() ? upstreamHeaderValue(upstreamHeaders, 'cache-control') : null;
  const headers: ProxyResponseHeaders = {
    'Cache-Control': followed ?? passThroughCacheControl(upstream),
    ...upstreamValidators(upstream),
  };
  if (followed) {
    const age = upstreamAge(upstream);
    if (age) headers.Age = age;
    const targeted = upstreamHeaderValue(upstreamHeaders, 'cdn-cache-control');
    if (targeted) headers['CDN-Cache-Control'] = targeted;
  }
  return headers;
}

export type ProxyResponseTarget = Pick<ServerResponse, 'setHeader'>;

export const IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export function applyProxyResponseHeaders(res: ProxyResponseTarget, input: ProxyResponseInput = {}): string | undefined {
  res.setHeader('Content-Security-Policy', IMAGE_CSP);
  const headers = proxyResponseHeaders(input);
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) res.setHeader(name, value);
  }
  return headers.ETag;
}
