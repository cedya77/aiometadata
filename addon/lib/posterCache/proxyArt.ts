// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import * as crypto from 'node:crypto';

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
  const params = [`fallback=${encodeURIComponent(fallback || '')}`];

  if (ratingKey) {
    params.push(`lang=${lang || 'en-US'}`, `key=${ratingKey}`);
  } else if (url) {
    params.push(`url=${encodeURIComponent(url)}`, `sig=${signProxyArtUrl(url)}`);
  }

  return `${base}/${imageClass}/${type}/${id}?${params.join('&')}`;
}
