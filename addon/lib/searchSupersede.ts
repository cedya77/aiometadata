// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import crypto from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { LRUCache } from 'lru-cache';
import { getSetting } from './settingsService';
import { clientAddress } from './authRoutes';

const MAX_CLIENTS = 10_000;
const LATEST_TTL_MS = 10 * 60 * 1000;
const MAX_QUERY_CHARS = 256;
const MAX_RUNS = 5;

export interface SearchClaim {
  key: string;
  query: string;
  socket: WeakRef<{ destroyed?: boolean }> | undefined;
}

interface Waiter {
  claim: SearchClaim | null;
}

class SearchSupersededError extends Error {
  readonly searchSuperseded = true;
  constructor() {
    super('Search superseded by a newer query from the same client');
    this.name = 'SearchSupersededError';
  }
}

const latest = new LRUCache<string, { query: string; arrival: number }>({ max: MAX_CLIENTS, ttl: LATEST_TTL_MS });
const waiting = new Map<string, Set<Waiter>>();
const store = new AsyncLocalStorage<{ claim: SearchClaim; flight?: string }>();
let arrivals = 0;

function enabled(): boolean {
  return !/^(false|0|no|off)$/i.test(getSetting('SEARCH_SUPERSEDE').trim());
}

/** Stamps the order a request reached the server, before any await can reorder it. */
function noteSearchArrival(req: any): void {
  if (req && req.searchArrival === undefined) req.searchArrival = ++arrivals;
}

function clientKey(req: any, catalogId: string, type: string): string {
  const parts = [
    req.params?.userUUID ?? '',
    typeof req.query?.viewer === 'string' ? req.query.viewer : '',
    catalogId,
    type,
    clientAddress(req),
    req.headers?.['user-agent'] ?? '',
  ];
  return crypto.createHash('sha1').update(parts.join('\u0000')).digest('base64');
}

function normalize(query: string): string {
  return query.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS);
}

/** Records this search as the client's latest unless a later-arriving one already is; null when the feature is off. */
function claimSearch(req: any, catalogId: string, type: string, query: string): SearchClaim | null {
  if (!enabled()) return null;
  noteSearchArrival(req);
  const claim: SearchClaim = {
    key: clientKey(req, catalogId, type),
    query: normalize(query),
    socket: req.socket ? new WeakRef(req.socket) : undefined,
  };
  const held = latest.peek(claim.key);
  if (!held || held.arrival < req.searchArrival) latest.set(claim.key, { query: claim.query, arrival: req.searchArrival });
  return claim;
}

/** The client hung up, or has since typed on past this query. A late shorter prefix never counts. */
function claimSuperseded(claim: SearchClaim): boolean {
  const socket = claim.socket?.deref();
  if (claim.socket && (!socket || socket.destroyed === true)) return true;
  const current = latest.peek(claim.key)?.query;
  return current !== undefined && current.length > claim.query.length && current.startsWith(claim.query);
}

function flightWanted(flight: string): boolean {
  const waiters = waiting.get(flight);
  return !!waiters && [...waiters].some(({ claim }) => claim === null || !claimSuperseded(claim));
}

/** Called before expensive steps; stops the search once no request waiting on it still needs it. */
function throwIfSearchSuperseded(): void {
  const context = store.getStore();
  if (!context) return;
  const wanted = context.flight !== undefined ? flightWanted(context.flight) : !claimSuperseded(context.claim);
  if (!wanted) throw new SearchSupersededError();
}

function isSearchSuperseded(error: any): boolean {
  return error?.searchSuperseded === true;
}

/**
 * Registers the caller as waiting on the shared cache flight `flight` (the key the cache layer
 * shares work under), so the search behind it stops only once no request waiting on it still wants it.
 */
async function joinSearchFlight<T>(flight: string, run: () => Promise<T>): Promise<T> {
  const context = store.getStore();
  const waiter: Waiter = { claim: context?.claim ?? null };
  let waiters = waiting.get(flight);
  if (!waiters) waiting.set(flight, (waiters = new Set()));
  waiters.add(waiter);
  try {
    return await (context ? store.run({ claim: context.claim, flight }, run) : run());
  } finally {
    waiters.delete(waiter);
    if (waiters.size === 0 && waiting.get(flight) === waiters) waiting.delete(flight);
  }
}

/** Runs a search under its claim; one that joined an abandoned search runs it again a bounded number of times. */
async function runClaimedSearch<T>(claim: SearchClaim | null, run: () => Promise<T>): Promise<{ skipped: boolean; value?: T }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { skipped: false, value: await (claim ? store.run({ claim }, run) : run()) };
    } catch (error) {
      if (!isSearchSuperseded(error)) throw error;
      if (claim && claimSuperseded(claim)) return { skipped: true };
      if (attempt >= MAX_RUNS) throw error;
    }
  }
}

export { claimSearch, claimSuperseded, noteSearchArrival, throwIfSearchSuperseded, isSearchSuperseded, joinSearchFlight, runClaimedSearch, SearchSupersededError };
module.exports = { claimSearch, claimSuperseded, noteSearchArrival, throwIfSearchSuperseded, isSearchSuperseded, joinSearchFlight, runClaimedSearch, SearchSupersededError };
