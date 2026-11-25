// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { narrowedTo } from './catalogs';
import { liveTvFor, liveTvReady, type LiveTv } from './gate';
import { filterProgrammes, programmeTarget, searchChannels, type GuideItem } from './guide';
import { groupItem, liveTvView } from './items';
import { GONE, guideChannels, placementFor } from './lineup';
import { unnamedChannels } from './limits';
import { askOf, field, integer, listOf, type Ask } from './query';
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
const viewMarks = (live: LiveTv) => ({ guide: live.catalogs.some((c) => c.guide), groups: live.reach.some((c) => c.groups.length > 0) });

export async function liveAllowed(req: any, deps: LiveTvDeps): Promise<LiveTv | null> {
  return liveTvReady(deps, await deps.loadConfig(req));
}

export async function liveItem(req: any, deps: LiveTvDeps, descriptor: any): Promise<Answer | undefined> {
  if (!isLive(descriptor)) return undefined;
  const config = await deps.loadConfig(req);
  const live = await liveTvReady(deps, config);
  if (!live) return NOT_FOUND;
  if (descriptor.k === 'livetv') return { status: 200, body: liveTvView(deps, deps.serverIdFor(userOf(req)), viewMarks(live)) };
  if (descriptor.k === 'channel') return channelById(deps, req, live, config, descriptor);
  return programmeById(deps, req, live, descriptor);
}

/** Only for those held to groups does it matter which one a channel is in. */
async function reaches(deps: LiveTvDeps, live: LiveTv, { t, i }: { t: string; i: string }): Promise<boolean> {
  if (!narrowedTo(live.reach)) return true;
  const placement = await placementFor(deps.addon, live.base, live.reach, { type: t, id: i });
  return placement !== null && placement !== GONE;
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
    const target = await programmeTarget(deps.addon, live.base, live.reach, descriptor, { playing: true });
    if (!target) return NOT_FOUND;
    const { meta } = target.channel;
    if (!target.live && target.runtimeMs) {
      const runtimeTicks = target.runtimeMs * TICKS_PER_MS;
      const sources = await deps.resolveSourcesFor(req, meta.type, target.streamId, runtimeTicks, { live: false, cache: false, refresh, allowHeaders });
      return { sources, runtimeTicks };
    }
    return { sources: await deps.resolveSourcesFor(req, meta.type, meta.id, null, { live: true, refresh, allowHeaders }), runtimeTicks: null };
  }

  if (!(await reaches(deps, live, descriptor))) return NOT_FOUND;
  const sources = await deps.resolveSourcesFor(req, descriptor.t, descriptor.i, null, { live: true, refresh, allowHeaders });
  return { sources, runtimeTicks: null };
}

export async function liveFavourite(req: any, deps: LiveTvDeps, descriptor: any, on: boolean): Promise<Answer | undefined> {
  if (!isLive(descriptor)) return undefined;
  const config = await deps.loadConfig(req);
  const live = await liveTvReady(deps, config);
  if (!live || descriptor.k !== 'channel') return NOT_FOUND;
  if (!(await reaches(deps, live, descriptor))) return NOT_FOUND;
  await deps.favourites.set(userOf(req), deps.profileKey(config), channelKeyOf({ type: descriptor.t, id: descriptor.i }), on);
  const id = deps.encodeId({ k: 'channel', t: descriptor.t, i: descriptor.i });
  return { status: 200, body: { ...deps.emptyUserData, IsFavorite: on, Key: id, ItemId: id } };
}

const CHANNEL_TYPES = new Set(['tvchannel', 'livetvchannel']);
const PROGRAMME_TYPES = new Set(['livetvprogram', 'tvprogram', 'program']);

export interface LiveFound {
  /** The page asked for or, when there is a rest to list before them, all up to its end. */
  items: any[];
  total: number;
  /** The asked types that are not Live TV's, for the caller to search. */
  rest: string[];
}

export async function liveSearch(
  req: any,
  deps: LiveTvDeps,
  { term, includeItemTypes, startIndex, limit }: { term: string; includeItemTypes: unknown; startIndex: number; limit: number }
): Promise<LiveFound | undefined> {
  const types = listOf(includeItemTypes);
  const asks = (kinds: Set<string>) => types.some((type) => kinds.has(type.toLowerCase()));
  const channels = asks(CHANNEL_TYPES);
  const programmes = asks(PROGRAMME_TYPES);
  if (!channels && !programmes) return undefined;
  const config = await deps.loadConfig(req);
  const live = await liveTvReady(deps, config);
  if (!live) return undefined;

  const now = deps.now();
  const found = channels ? await searchChannels(deps.addon, live.base, live.reach, term, SEARCH_SCAN) : [];
  let aired: GuideItem[] = [];
  if (programmes) {
    const own: Record<string, unknown> = { searchterm: term, startindex: undefined, limit: undefined };
    const asked = askOf(req);
    const ask: Ask = (name) => (name.toLowerCase() in own ? own[name.toLowerCase()] : asked(name));
    const listed = await guideChannels(deps.addon, live.base, live.catalogs, unnamedChannels());
    aired = filterProgrammes(await programmesAround(deps, live, listed, () => undefined, now), ask, now).items;
  }

  const rest = types.filter((type) => !CHANNEL_TYPES.has(type.toLowerCase()) && !PROGRAMME_TYPES.has(type.toLowerCase()));
  const from = rest.length ? 0 : startIndex;
  const end = startIndex + limit;
  const page = found.slice(from, end);
  const after = Math.max(0, from - found.length);
  const items = [
    ...(page.length ? await channelItems(deps, req, live, page, await favouriteKeys(deps, req, config), true) : []),
    ...programItems(deps, req, aired.slice(after, after + end - from - page.length), now),
  ];
  return { items, total: found.length + aired.length, rest };
}

export function liveTvViewFor(req: any, deps: LiveTvDeps, config: any): any | null {
  const live = liveTvFor(deps, config);
  return live ? liveTvView(deps, deps.serverIdFor(userOf(req)), viewMarks(live)) : null;
}

/** The channel groups, when the request asks for the genres of Live TV or of channels. */
export async function liveGroups(req: any, deps: LiveTvDeps): Promise<any | undefined> {
  const parentId = field(req, 'ParentId');
  const ofView = parentId ? (await deps.decodeLiveId(String(parentId)))?.k === 'livetv' : false;
  if (!ofView && (parentId || !listOf(field(req, 'IncludeItemTypes')).some((type) => CHANNEL_TYPES.has(type.toLowerCase())))) return undefined;
  const live = await liveAllowed(req, deps);
  if (!live) return undefined;

  const groups = new Map<string, LiveTv['catalogs'][number]>();
  for (const catalog of live.reach) for (const name of catalog.groups) if (!groups.has(name)) groups.set(name, catalog);
  const startIndex = Math.max(0, integer(field(req, 'StartIndex'), 0));
  const limit = integer(field(req, 'Limit'), 0);
  const serverId = deps.serverIdFor(userOf(req));
  const page = [...groups].slice(startIndex, limit > 0 ? startIndex + limit : undefined);
  return deps.itemList(page.map(([name, catalog]) => groupItem(deps, serverId, catalog, name)), groups.size, startIndex);
}
