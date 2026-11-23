// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { liveTvFor, liveTvReady, type LiveTv } from './gate';
import { liveTvView } from './items';
import { GONE, listChannels, placementFor, type ListedChannel } from './lineup';
import { channelById, channelItems, channelKeyOf, favouriteKeys, NOT_FOUND, userOf, type Answer, type LiveTvDeps } from './routes';

const SEARCH_SCAN = 5000;

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

export async function liveAllowed(req: any, deps: LiveTvDeps): Promise<LiveTv | null> {
  return liveTvReady(deps, await deps.loadConfig(req));
}

export async function liveItem(req: any, deps: LiveTvDeps, descriptor: any): Promise<Answer | undefined> {
  if (!isLive(descriptor)) return undefined;
  const config = await deps.loadConfig(req);
  const live = await liveTvReady(deps, config);
  if (!live) return NOT_FOUND;
  if (descriptor.k === 'livetv') return { status: 200, body: liveTvView(deps, deps.serverIdFor(userOf(req))) };
  if (descriptor.k === 'channel') return channelById(deps, req, live, config, descriptor);
  return NOT_FOUND;
}

export async function livePlayback(
  req: any,
  deps: HandlerDeps,
  descriptor: any
): Promise<{ sources: any[]; runtimeTicks: number | null } | Answer | undefined> {
  if (descriptor?.k !== 'channel' && descriptor?.k !== 'program') return undefined;
  const live = await liveAllowed(req, deps);
  if (!live || descriptor.k !== 'channel') return NOT_FOUND;
  const placement = await placementFor(deps.addon, live.base, live.catalogs, { type: descriptor.t, id: descriptor.i });
  if (!placement || placement === GONE) return NOT_FOUND;
  const sources = await deps.resolveSourcesFor(req, placement.meta.type, placement.meta.id, null, {
    live: true,
    refresh: req.body?.Refresh === true,
    allowHeaders: req.body?.EnableRequiredHttpHeaders === true,
  });
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

function matches(channel: ListedChannel, words: string[]): boolean {
  const name = channel.meta.name.toLowerCase();
  return words.every((word) => name.includes(word));
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
  if (!channels) return { status: 200, body: deps.itemList([], 0, startIndex) };

  const wanted = String(term ?? '').trim().toLowerCase();
  const words = wanted.split(/\s+/).filter(Boolean);
  const { channels: scanned } = await listChannels(deps.addon, live.base, live.catalogs, { startIndex: 0, limit: SEARCH_SCAN });
  const exact = scanned.filter((c) => c.number !== undefined && c.number.toLowerCase() === wanted);
  const named = scanned.filter((c) => !exact.includes(c) && words.length > 0 && matches(c, words));
  const found = [...exact, ...named];
  const page = found.slice(startIndex, startIndex + limit);
  const items = await channelItems(deps, req, live, page, await favouriteKeys(deps, req, config), true);
  return { status: 200, body: deps.itemList(items, found.length, startIndex) };
}

export function liveTvViewFor(req: any, deps: LiveTvDeps, config: any): any | null {
  return liveTvFor(deps, config) ? liveTvView(deps, deps.serverIdFor(userOf(req))) : null;
}
