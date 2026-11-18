// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import * as crypto from 'node:crypto';
import { instanceHostname } from '../../utils/outboundGuard';

export function imageProxySigningSecret(): string {
  return process.env.IMAGE_PROXY_SIGNING_SECRET || process.env.ADMIN_KEY || '';
}

const SIGNING_PURPOSE = 'image-proxy-url';

let derivedFrom: string | null = null;
let derivedKey: crypto.KeyObject | null = null;

// A KeyObject is handed to createHmac as is; a Buffer key is re-validated on every call.
function signingKey(secret: string): crypto.KeyObject {
  if (secret !== derivedFrom) {
    derivedFrom = secret;
    derivedKey = crypto.createSecretKey(crypto.createHash('sha256').update(`${secret}|${SIGNING_PURPOSE}`).digest());
  }
  return derivedKey!;
}

export function signProxyArtUrl(targetUrl: string): string {
  const secret = imageProxySigningSecret();
  if (!secret || !targetUrl) return '';
  return crypto.createHmac('sha256', signingKey(secret)).update(targetUrl).digest('base64url').slice(0, 22);
}

function matches(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function legacySignProxyArtUrl(targetUrl: string): string {
  const secret = imageProxySigningSecret();
  if (!secret || !targetUrl) return '';
  return crypto.createHmac('sha256', secret).update(targetUrl).digest('base64url').slice(0, 22);
}

export function proxyArtUrlVouched(targetUrl: string, sig: unknown): boolean {
  if (!sig) return false;
  const provided = String(sig);
  return matches(provided, signProxyArtUrl(targetUrl))
    || matches(provided, legacySignProxyArtUrl(targetUrl));
}

/** Hosts the art comes from, which a fallback may name without the server's signature. */
const ART_HOSTS = [
  'image.tmdb.org', 'themoviedb.org', 'thetvdb.com', 'fanart.tv', 'metahub.space', 'myanimelist.net', 'kitsu.io',
  'kitsu.app', 'anilist.co', 'anidb.net', 'media-amazon.com', 'trakt.tv', 'simkl.in', 'tvmaze.com', 'ltrbxd.com',
  'mdblist.com', 'publicmetadb.com', 'ratingposterdb.com', 'top-posters.com',
];

function onArtHost(host: string): boolean {
  const name = host.toLowerCase();
  return name === instanceHostname() || ART_HOSTS.some((art) => name === art || name.endsWith(`.${art}`));
}

// Signed apart from the art URLs themselves, so a fallback's signature never vouches for fetching that URL.
const signFallback = (fallback: string): string => signProxyArtUrl(`fallback:${fallback}`);

/** The fallback query: signed when the art comes from a host outside the known ones, so the route will follow it. */
export function fallbackQuery(fallback: string | null | undefined): string {
  const value = fallback || '';
  let host = '';
  try {
    host = value ? new URL(value).hostname : '';
  } catch {
    host = '';
  }
  const sig = value && !onArtHost(host) ? signFallback(value) : '';
  return `fallback=${encodeURIComponent(value)}${sig ? `&fsig=${sig}` : ''}`;
}

/** Where an art route may send a client whose image it cannot serve: art the server named, never anywhere a link says. */
export function followableFallback(fallback: unknown, fsig: unknown): string | null {
  if (typeof fallback !== 'string' || !fallback) return null;
  let parsed: URL;
  try {
    parsed = new URL(fallback);
  } catch {
    return null;
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) return null;
  if (onArtHost(parsed.hostname)) return fallback;
  return typeof fsig === 'string' && matches(fsig, signFallback(fallback)) ? fallback : null;
}

export interface ProxyArtUrlOptions {
  base: string;
  imageClass: 'poster' | 'logo' | 'background' | 'landscape';
  type: string;
  id: string;
  fallback?: string;
  url?: string;
  ratingKey?: string;
  lang?: string;
}

export function buildProxyArtUrl(options: ProxyArtUrlOptions): string {
  const { base, imageClass, type, id, fallback, url, ratingKey, lang } = options;
  const params = [fallbackQuery(fallback)];

  if (ratingKey) {
    params.push(`lang=${lang || 'en-US'}`, `key=${ratingKey}`);
  } else if (url) {
    params.push(`url=${encodeURIComponent(url)}`, `sig=${signProxyArtUrl(url)}`);
  }

  return `${base}/${imageClass}/${type}/${id}?${params.join('&')}`;
}
