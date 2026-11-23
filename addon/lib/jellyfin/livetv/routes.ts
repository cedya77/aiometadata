// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { normaliseJellyfinId } from '../idsCodec';
import { liveTvReady, type GateDeps, type LiveTv } from './gate';
import { airingAt, programmesFor } from './guide';
import { channelItem, type ItemDeps } from './items';
import { GONE, listChannels, placementFor, type ListedChannel } from './lineup';

const DAY_MS = 86400000;
const GUIDE_DAYS_AHEAD = 7;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export interface LiveTvDeps extends GateDeps, ItemDeps {
  decodeLiveId(raw: string): Promise<any>;
  now(): number;
  itemList(items: any[], total: number, startIndex: number): any;
  serverName: string;
  loadConfig(req: any): Promise<any>;
  profileFor(req: any): Promise<{ userId: string }>;
  serverIdFor(userUUID: string): string;
  favourites: {
    list(userUUID: string, profileKey: string): Promise<string[]>;
    set(userUUID: string, profileKey: string, key: string, on: boolean): Promise<void>;
  };
  profileKey(config: any): string;
}

export interface Answer {
  status: number;
  body?: any;
}

export const NOT_FOUND: Answer = { status: 404, body: { Message: 'Item not found' } };

export function field(req: any, name: string): any {
  const wanted = name.toLowerCase();
  for (const source of [req?.query, req?.body]) {
    if (!source || typeof source !== 'object') continue;
    const key = Object.keys(source).find((k) => k.toLowerCase() === wanted);
    if (key !== undefined) return source[key];
  }
  return undefined;
}

export function flag(value: unknown): boolean | undefined {
  if (value === true || value === false) return value;
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'true' ? true : text === 'false' ? false : undefined;
}

const integer = (value: unknown, fallback: number): number => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : fallback;
};

export const userOf = (req: any): string => req.jellyfin?.userUUID ?? req.params?.userUUID;
export const channelKeyOf = (meta: { type: string; id: string }): string => `${meta.type}|${meta.id}`;

export function splitKey(key: string): { type: string; id: string } | null {
  const at = key.indexOf('|');
  return at > 0 ? { type: key.slice(0, at), id: key.slice(at + 1) } : null;
}

export async function favouriteKeys(deps: LiveTvDeps, req: any, config: any): Promise<Set<string>> {
  return new Set(await deps.favourites.list(userOf(req), deps.profileKey(config)));
}

export async function resolveFavourites(deps: LiveTvDeps, live: LiveTv, keys: Iterable<string>): Promise<ListedChannel[]> {
  const parts = [...keys].map(splitKey).filter((p): p is { type: string; id: string } => p !== null);
  const placements = await Promise.all(parts.map((p) => placementFor(deps.addon, live.base, live.catalogs, p)));
  const listed: ListedChannel[] = [];
  placements.forEach((placement, n) => {
    if (placement === GONE) return;
    if (!placement) listed.push({ meta: { ...parts[n], name: parts[n].id } });
    else listed.push({ meta: placement.meta, number: placement.number });
  });
  return listed;
}

export async function channelItems(
  deps: LiveTvDeps,
  req: any,
  live: LiveTv,
  channels: ListedChannel[],
  favourites: Set<string>,
  withProgram: boolean
): Promise<any[]> {
  const serverId = deps.serverIdFor(userOf(req));
  const now = deps.now();
  const airing = withProgram && channels.length
    ? await programmesFor(deps.addon, live.base, live.catalogs, channels.map((c) => c.meta), now, now + 1)
    : new Map();
  return channels.map((channel) =>
    channelItem(deps, serverId, channel, {
      airing: airingAt(airing.get(channelKeyOf(channel.meta)), now),
      favourite: favourites.has(channelKeyOf(channel.meta)),
    })
  );
}

async function listSkipping(deps: LiveTvDeps, live: LiveTv, skip: Set<string>, start: number, count: number): Promise<{ channels: ListedChannel[]; total: number; skipped: number }> {
  const full = await listChannels(deps.addon, live.base, live.catalogs, { startIndex: 0, limit: start + count + skip.size });
  const kept = full.channels.filter((c) => !skip.has(channelKeyOf(c.meta)));
  const skipped = full.channels.length - kept.length;
  return { channels: kept.slice(start, start + count), total: full.total - skipped, skipped };
}

export async function channelPage(deps: LiveTvDeps, req: any, live: LiveTv, config: any): Promise<any> {
  const startIndex = Math.max(0, integer(field(req, 'StartIndex'), 0));
  const limit = Math.min(MAX_LIMIT, Math.max(1, integer(field(req, 'Limit'), DEFAULT_LIMIT)));
  if (String(field(req, 'Type') ?? '').trim().toLowerCase() === 'radio') return deps.itemList([], 0, startIndex);

  const isFavorite = flag(field(req, 'IsFavorite'));
  const sorting = flag(field(req, 'EnableFavoriteSorting')) === true;
  const withProgram = flag(field(req, 'AddCurrentProgram')) !== false;
  const keys = await favouriteKeys(deps, req, config);

  let channels: ListedChannel[];
  let total: number;
  if (isFavorite === true) {
    const favourites = await resolveFavourites(deps, live, keys);
    channels = favourites.slice(startIndex, startIndex + limit);
    total = favourites.length;
  } else if (isFavorite === false) {
    ({ channels, total } = await listSkipping(deps, live, keys, startIndex, limit));
  } else if (sorting && keys.size) {
    const favourites = await resolveFavourites(deps, live, keys);
    const head = favourites.slice(startIndex, startIndex + limit);
    const rest = await listSkipping(deps, live, keys, Math.max(0, startIndex - favourites.length), limit - head.length);
    channels = [...head, ...rest.channels];
    total = rest.total + rest.skipped;
  } else {
    ({ channels, total } = await listChannels(deps.addon, live.base, live.catalogs, { startIndex, limit }));
  }
  return deps.itemList(await channelItems(deps, req, live, channels, keys, withProgram), total, startIndex);
}

export async function channelById(deps: LiveTvDeps, req: any, live: LiveTv, config: any, descriptor: any): Promise<Answer> {
  if (descriptor?.k !== 'channel') return NOT_FOUND;
  const placement = await placementFor(deps.addon, live.base, live.catalogs, { type: descriptor.t, id: descriptor.i });
  if (!placement || placement === GONE) return NOT_FOUND;
  const keys = await favouriteKeys(deps, req, config);
  const [item] = await channelItems(deps, req, live, [{ meta: placement.meta, number: placement.number }], keys, true);
  return { status: 200, body: item };
}

export function guideInfo(now: number): { StartDate: string; EndDate: string } {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return { StartDate: new Date(today).toISOString(), EndDate: new Date(today + GUIDE_DAYS_AHEAD * DAY_MS).toISOString() };
}

type LiveHandler = (req: any, res: any, live: LiveTv, config: any) => Promise<void> | void;

function gated(deps: LiveTvDeps, handler: LiveHandler) {
  return async (req: any, res: any, next: any) => {
    try {
      const config = await deps.loadConfig(req);
      const live = await liveTvReady(deps, config);
      if (!live) {
        next();
        return;
      }
      await handler(req, res, live, config);
    } catch (error) {
      next(error);
    }
  };
}

export function registerLiveTv(router: any, deps: LiveTvDeps): void {
  router.get('/LiveTv/Info', gated(deps, async (req, res) => {
    const profile = await deps.profileFor(req);
    res.json({
      Services: [{ Name: deps.serverName, Status: 'Ok', IsVisible: true, HasUpdateAvailable: false, Tuners: [] }],
      IsEnabled: true,
      EnabledUsers: [normaliseJellyfinId(profile.userId)],
    });
  }));

  router.get('/LiveTv/GuideInfo', gated(deps, (_req, res) => {
    res.json(guideInfo(deps.now()));
  }));

  router.get('/LiveTv/Channels', gated(deps, async (req, res, live, config) => {
    res.json(await channelPage(deps, req, live, config));
  }));

  router.get('/LiveTv/Channels/:channelId', gated(deps, async (req, res, live, config) => {
    const answer = await channelById(deps, req, live, config, await deps.decodeLiveId(req.params.channelId));
    res.status(answer.status).json(answer.body);
  }));

  router.post('/LiveTv/Programs', gated(deps, (_req, res) => {
    res.json(deps.itemList([], 0, 0));
  }));
}
