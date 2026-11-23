// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { liveTvFor, liveTvReady, type LiveTv } from './gate';
import { filterProgrammes, programmeTarget, searchChannels } from './guide';
import { liveTvView } from './items';
import { GONE, listChannels, placementFor } from './lineup';
import type { Ask } from './query';
import {
  channelById,
  channelItems,
  channelKeyOf,
  favouriteKeys,
  NOT_FOUND,
  programItems,
  programmeById,
  programmesAround,
  userOf,
  type Answer,
  type LiveTvDeps,
} from './routes';

const SEARCH_SCAN = 5000;
const PROGRAMME_CHANNELS = 100;
const TICKS_PER_MS = 10000;

export interface HandlerDeps extends LiveTvDeps {
  resolveSourcesFor(
    req: any,
    stremioType: string,
    stremioId: string,
    runtimeTicks: number | null,
    options: { live: boolean; cache?: boolean; refresh?: boolean; allowHeaders?: boolean }
  ): Promise<any[]>;
}

const LIVE_KINDS = new Set(['livetv', 'channel', 'program']);
const isLive = (descriptor: any): boolean => LIVE_KINDS.has(descriptor?.k);
const hasGuide = (live: LiveTv): boolean => live.catalogs.some((c) => c.guide);

export async function liveAllowed(req: any, deps: LiveTvDeps): Promise<LiveTv | null> {
  return liveTvReady(deps, await deps.loadConfig(req));
}

export async function liveItem(req: any, deps: LiveTvDeps, descriptor: any): Promise<Answer | undefined> {
  if (!isLive(descriptor)) return undefined;
  const config = await deps.loadConfig(req);
  const live = await liveTvReady(deps, config);
  if (!live) return NOT_FOUND;
  if (descriptor.k === 'livetv') return { status: 200, body: liveTvView(deps, deps.serverIdFor(userOf(req)), { guide: hasGuide(live) }) };
  if (descriptor.k === 'channel') return channelById(deps, req, live, config, descriptor);
  return programmeById(deps, req, live, descriptor);
}

export async function livePlayback(
  req: any,
  deps: HandlerDeps,
  descriptor: any
): Promise<{ sources: any[]; runtimeTicks: number | null } | Answer | undefined> {
  if (descriptor?.k !== 'channel' && descriptor?.k !== 'program') return undefined;
  const live = await liveAllowed(req, deps);
  if (!live) return NOT_FOUND;
  const refresh = req.body?.Refresh === true;
  const allowHeaders = req.body?.EnableRequiredHttpHeaders === true;

  if (descriptor.k === 'program') {
    const target = await programmeTarget(deps.addon, live.base, live.catalogs, descriptor);
    if (!target) return NOT_FOUND;
    const { meta } = target.channel;
    if (!target.live && target.runtimeMs) {
      const runtimeTicks = target.runtimeMs * TICKS_PER_MS;
      const sources = await deps.resolveSourcesFor(req, meta.type, target.streamId, runtimeTicks, { live: false, cache: false, refresh, allowHeaders });
      return { sources, runtimeTicks };
    }
    return { sources: await deps.resolveSourcesFor(req, meta.type, meta.id, null, { live: true, refresh, allowHeaders }), runtimeTicks: null };
  }

  const placement = await placementFor(deps.addon, live.base, live.catalogs, { type: descriptor.t, id: descriptor.i });
  if (!placement || placement === GONE) return NOT_FOUND;
  const sources = await deps.resolveSourcesFor(req, placement.meta.type, placement.meta.id, null, { live: true, refresh, allowHeaders });
  return { sources, runtimeTicks: null };
}

export async function liveFavourite(req: any, deps: LiveTvDeps, descriptor: any, on: boolean): Promise<Answer | undefined> {
  if (!isLive(descriptor)) return undefined;
  const config = await deps.loadConfig(req);
  if (!(await liveTvReady(deps, config)) || descriptor.k !== 'channel') return NOT_FOUND;
  await deps.favourites.set(userOf(req), deps.profileKey(config), channelKeyOf({ type: descriptor.t, id: descriptor.i }), on);
  const id = deps.encodeId({ k: 'channel', t: descriptor.t, i: descriptor.i });
  return { status: 200, body: { ...deps.emptyUserData, IsFavorite: on, Key: id, ItemId: id } };
}

function typesOf(value: unknown): Set<string> {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  return new Set(list.map((v) => String(v).trim().toLowerCase()).filter(Boolean));
}

export async function liveSearch(
  req: any,
  deps: LiveTvDeps,
  { term, includeItemTypes, startIndex, limit }: { term: string; includeItemTypes: unknown; startIndex: number; limit: number }
): Promise<Answer | undefined> {
  const types = typesOf(includeItemTypes);
  const channels = types.has('tvchannel');
  const programmes = types.has('livetvprogram') || types.has('program');
  if (!channels && !programmes) return undefined;
  const config = await deps.loadConfig(req);
  const live = await liveTvReady(deps, config);
  if (!live) return undefined;

  if (channels) {
    const found = await searchChannels(deps.addon, live.base, live.catalogs, term, SEARCH_SCAN);
    const page = found.slice(startIndex, startIndex + limit);
    const items = await channelItems(deps, req, live, page, await favouriteKeys(deps, req, config), true);
    return { status: 200, body: deps.itemList(items, found.length, startIndex) };
  }

  const now = deps.now();
  const query: Record<string, unknown> = { searchterm: term, startindex: startIndex, limit };
  const ask: Ask = (name) => query[name.toLowerCase()];
  const listed = (await listChannels(deps.addon, live.base, live.catalogs, { startIndex: 0, limit: PROGRAMME_CHANNELS })).channels;
  const { items, total } = filterProgrammes(await programmesAround(deps, live, listed, () => undefined, now), ask, now);
  return { status: 200, body: deps.itemList(programItems(deps, req, items, now), total, startIndex) };
}

export function liveTvViewFor(req: any, deps: LiveTvDeps, config: any): any | null {
  const live = liveTvFor(deps, config);
  return live ? liveTvView(deps, deps.serverIdFor(userOf(req)), { guide: hasGuide(live) }) : null;
}
