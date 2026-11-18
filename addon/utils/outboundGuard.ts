// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { lookup as dnsLookup } from 'node:dns';
import { lookup as dnsLookupAll } from 'node:dns/promises';
import * as net from 'node:net';
import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { isPrivateAddress } from '../lib/posterCache/upstream';
import { getSetting } from '../lib/settingsService';
import { KEEP_ALIVE, ResponseTooLarge, proxyDispatcher } from './httpClient';

const { Agent, buildConnector, fetch: undiciFetch } = require('undici');

const logger = consola.withTag('Outbound');

export class RefusedDestination extends Error {
  code = 'EREFUSEDDESTINATION';
  constructor(host: string) {
    super(`${host} is on a private network, which this server does not fetch from`);
  }
}

/** The largest reply taken from an addon, a catalog, a manifest or a link read for an import. */
export function addonFetchMaxBytes(): number {
  const megabytes = Number(getSetting('ADDON_FETCH_MAX_MB'));
  return Math.round((Number.isFinite(megabytes) && megabytes > 0 ? megabytes : 10) * 1024 * 1024);
}

function instanceUrl(): URL | null {
  const raw = String(process.env.HOST_NAME || '').trim();
  if (!raw) return null;
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
}

/** This instance's own hostname, from HOST_NAME. */
export function instanceHostname(): string {
  return (instanceUrl()?.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
}

const defaultPort = (protocol: string): string => (protocol === 'http:' ? '80' : '443');

/** The instance itself, on its own port: a request to it reaches nothing a caller could not ask for directly. */
function isInstanceOrigin(host: string, port: string, protocol: string): boolean {
  const own = instanceUrl();
  if (!own || host.toLowerCase() !== instanceHostname()) return false;
  return (port || defaultPort(protocol)) === (own.port || defaultPort(own.protocol));
}

/** Private hosts an admin lets the server fetch from ('*' for all). */
export function privateHostAllowed(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  const listed = String(getSetting('OUTBOUND_ALLOWED_PRIVATE_HOSTS') || '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  return listed.includes('*') || listed.includes(name);
}

const warned = new LRUCache<string, true>({ max: 500, ttl: 60 * 60 * 1000 });

function refuse(host: string): RefusedDestination {
  if (!warned.has(host)) {
    warned.set(host, true);
    logger.warn(`Refused to fetch from ${host}: it is on a private network. If it is yours, add it to OUTBOUND_ALLOWED_PRIVATE_HOSTS.`);
  }
  return new RefusedDestination(host);
}

/** The refusal for a host at these addresses, or null when the server may reach it. */
function refusalFor(host: string, addresses: string[]): RefusedDestination | null {
  if (!addresses.some((address) => isPrivateAddress(address)) || privateHostAllowed(host)) return null;
  return refuse(host);
}

/** Resolves a name and refuses it when any of its addresses is private; the connection then uses an address checked here. */
function guardedLookup(hostname: string, options: any, callback: any): void {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'function' ? {} : (options || {});
  dnsLookup(hostname, { ...opts, all: true }, (error: any, addresses: Array<{ address: string; family: number }>) => {
    if (error) return cb(error);
    const refused = refusalFor(hostname, addresses.map((entry) => entry.address));
    if (refused) return cb(refused);
    if (opts.all) return cb(null, addresses);
    return cb(null, addresses[0].address, addresses[0].family);
  });
}

const connectChecked = buildConnector({ lookup: guardedLookup });
const connectDirect = buildConnector({});

/** An address written into the URL is never looked up, so it is checked here; a name is checked as it resolves. */
function guardedConnect(options: any, callback: any): void {
  const host = String(options.hostname || '').replace(/^\[|\]$/g, '');
  if (isInstanceOrigin(host, String(options.port || ''), String(options.protocol || ''))) {
    connectDirect(options, callback);
    return;
  }
  if (net.isIP(host)) {
    const refused = refusalFor(host, [host]);
    if (refused) callback(refused, null);
    else connectDirect(options, callback);
    return;
  }
  connectChecked(options, callback);
}

/** Through a proxy the name is resolved again on the proxy's side, so it is checked here first, as the image cache does. */
async function checkBeforeProxy(origin: URL): Promise<void> {
  const host = origin.hostname.replace(/^\[|\]$/g, '');
  if (isInstanceOrigin(host, origin.port, origin.protocol) || privateHostAllowed(host)) return;
  const addresses = net.isIP(host) ? [host] : (await dnsLookupAll(host, { all: true })).map((entry) => entry.address);
  const refused = refusalFor(host, addresses);
  if (refused) throw refused;
}

const proxyCheck = (dispatch: any) => (opts: any, handler: any) => {
  let origin: URL;
  try {
    origin = new URL(String(opts.origin));
  } catch {
    return dispatch(opts, handler);
  }
  checkBeforeProxy(origin).then(
    () => dispatch(opts, handler),
    (error) => handler.onResponseError(null, error),
  );
  return true;
};

/**
 * Connections for URLs a user or a configuration supplies: every request, each redirect's included, goes to a public
 * address or one the admin allows. Through HTTPS_PROXY or HTTP_PROXY when one is set, else pinned to the checked address.
 */
export const addonDispatcher = proxyDispatcher
  ? proxyDispatcher.compose(proxyCheck)
  : new Agent({ allowH2: false, ...KEEP_ALIVE, connect: guardedConnect });

/** Options for httpClient that keep a request to a supplied URL public, capped and inside one deadline. */
export function addonRequest(maxBytes: number, deadlineMs: number): { dispatcher: any; maxBytes: number; signal: AbortSignal } {
  return { dispatcher: addonDispatcher, maxBytes, signal: AbortSignal.timeout(deadlineMs) };
}

/** fetch() for a supplied URL, through the same connections. */
export function addonFetch(url: string, init: Record<string, any> = {}): Promise<any> {
  return undiciFetch(url, { ...init, dispatcher: addonDispatcher });
}

/** A fetch() response read as text, stopping once it passes `maxBytes`. */
export async function readCappedResponse(response: any, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLarge(maxBytes);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLarge(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Whether the error, or one it wraps as fetch() and undici do, carries the code. */
function carries(error: any, code: string): boolean {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
    if (current.code === code) return true;
  }
  return false;
}

export function isRefusedDestination(error: any): boolean {
  return carries(error, 'EREFUSEDDESTINATION');
}

export function isResponseTooLarge(error: any): boolean {
  return carries(error, 'ERESPONSETOOLARGE');
}
