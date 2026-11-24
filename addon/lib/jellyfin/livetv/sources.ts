// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import { clockOptions, hash } from '../addonReader';

const PIN_TTL_MS = 60 * 1000;
const MAX_PINS = 5000;

const isPlaceholder = (source: any): boolean => source?.Type === 'Placeholder';

/**
 * Names the streams of one channel or programme. Live streams share labels
 * across channels and carry changing tokens, so one is named by its channel,
 * its own id and its place among those with that id. A repeated URL gets null.
 */
export function liveSourceIds(type: string, id: string): (playable: { id: string; url: string }) => string | null {
  const urls = new Set<string>();
  const counts = new Map<string, number>();
  return (playable) => {
    if (urls.has(playable.url)) return null;
    urls.add(playable.url);
    const nth = counts.get(playable.id) ?? 0;
    counts.set(playable.id, nth + 1);
    return createHash('md5').update(['live', type, id, playable.id, nth].join('\u0000')).digest('hex');
  };
}

export function asDefault(sources: any[], itemId: string, needsHeaders: (source: any) => boolean): any[] {
  const real = sources.some((source) => !isPlaceholder(source));
  const first = sources.findIndex((source) => !needsHeaders(source) && (!real || !isPlaceholder(source)));
  return first < 0 ? sources : sources.map((source, n) => (n === first ? { ...source, Id: itemId, ETag: itemId } : source));
}

/** The sources a client may mean by an id: the one listed under it, or else the one it names although listed as the default. */
export function sourcesNamed(sources: any[], wantedId: string): any[] {
  const listed = sources.filter((source) => source?.Id === wantedId);
  return listed.length ? listed : sources.filter((source) => source?.aiostreams?.id === wantedId);
}

export function pickLive(sources: any[], itemId: string, wantedId: string | null): any | undefined {
  const real = sources.filter((source) => source?.Path && !isPlaceholder(source));
  return wantedId && wantedId !== itemId ? sourcesNamed(real, wantedId)[0] : real.find((source) => source.Id === itemId) ?? real[0];
}

export function pinScope(userUUID: string, profileId: string | null | undefined, base: string): string {
  return `${userUUID}|${profileId ?? ''}|${hash(base)}`;
}

export interface LivePins {
  remember(scope: string, itemId: string, sources: any[]): void;
  recall(scope: string, itemId: string, sourceId: string | null): string | undefined;
}

// Live URLs carry sign-ins and tokens, so one is kept only between PlaybackInfo
// and the stream request after it, for the user and addon it was issued to.
export function createLivePins(now?: () => number): LivePins {
  const pins = new LRUCache<string, string>({ max: MAX_PINS, ttl: PIN_TTL_MS, ...clockOptions(now) });
  return {
    remember(scope, itemId, sources) {
      for (const source of sources) {
        if (!source?.Path || isPlaceholder(source)) continue;
        for (const id of [source.aiostreams?.id, source.Id]) if (id) pins.set(`${scope}|${itemId}|${id}`, source.Path);
      }
    },
    recall: (scope, itemId, sourceId) => pins.get(`${scope}|${itemId}|${sourceId ?? itemId}`),
  };
}
