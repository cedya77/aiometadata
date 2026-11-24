// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { normaliseJellyfinId } from '../idsCodec';
import { liveTvReady, type GateDeps, type LiveTv } from './gate';
import { airingAt, caughtUp, filterProgrammes, guideRange, programmesFor, programmeTarget, type GuideItem } from './guide';
import { channelItem, programItem, type ItemDeps } from './items';
import { GONE, guideChannels, isListed, listChannels, listGroup, placementFor, placementsFor, type ListedChannel } from './lineup';
import { askOf, field, flag, integer, listOf, timeOf, type Ask } from './query';

export { field, flag };

const UNLIMITED = 5000;
const PROGRAMME_CHANNELS = 100;
const PROGRAMME_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_LIMIT = 500;
const MAX_GROUP = 10000;
const MAX_ASKED_CHANNELS = 1000;

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
  /** The title of the library's show under this id, or null. */
  seriesTitle(req: any, id: string): Promise<string | null>;
}

export interface Answer {
  status: number;
  body?: any;
}

export const NOT_FOUND: Answer = { status: 404, body: { Message: 'Item not found' } };

export const userOf = (req: any): string => req.jellyfin?.userUUID ?? req.params?.userUUID;
export const channelKeyOf = (meta: { type: string; id: string }): string => `${meta.type}|${meta.id}`;

export function splitKey(key: string): { type: string; id: string } | null {
  const at = key.indexOf('|');
  return at > 0 ? { type: key.slice(0, at), id: key.slice(at + 1) } : null;
}

export async function favouriteKeys(deps: LiveTvDeps, req: any, config: any): Promise<Set<string>> {
  return new Set(await deps.favourites.list(userOf(req), deps.profileKey(config)));
}

async function resolveFavourites(deps: LiveTvDeps, live: LiveTv, keys: Iterable<string>): Promise<ListedChannel[]> {
  const parts = [...keys].map(splitKey).filter((p): p is { type: string; id: string } => p !== null);
  const placements = await placementsFor(deps.addon, live.base, live.catalogs, parts);
  const channels: ListedChannel[] = [];
  placements.forEach((placement, n) => {
    if (placement === GONE) return;
    if (!placement) channels.push({ meta: { ...parts[n], name: parts[n].id } });
    else channels.push({ meta: placement.meta, number: placement.number });
  });
  return channels;
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

const isGroup = (live: LiveTv, name: string): boolean => live.catalogs.some((c) => c.groups.includes(name));

/** The group asked for: by the id of its genre item, or by its name. */
async function groupOf(deps: LiveTvDeps, live: LiveTv, ask: Ask, named = true): Promise<string | undefined> {
  const asked = named ? ask('Genres') : undefined;
  if (typeof asked === 'string' && isGroup(live, asked)) return asked;
  const name = listOf(asked, '|')[0];
  if (name) return name;
  const id = listOf(ask('GenreIds'), /[|,]/)[0];
  const descriptor = id ? await deps.decodeLiveId(id) : null;
  return descriptor?.k === 'genre' ? descriptor.g : undefined;
}

export async function channelPage(deps: LiveTvDeps, req: any, live: LiveTv, config: any): Promise<any> {
  const startIndex = Math.max(0, integer(field(req, 'StartIndex'), 0));
  const asked = integer(field(req, 'Limit'), 0);
  const limit = asked > 0 ? Math.min(MAX_LIMIT, asked) : UNLIMITED;
  if (String(field(req, 'Type') ?? '').trim().toLowerCase() === 'radio') return deps.itemList([], 0, startIndex);

  const isFavorite = flag(field(req, 'IsFavorite'));
  const sorting = flag(field(req, 'EnableFavoriteSorting')) === true;
  const withProgram = flag(field(req, 'AddCurrentProgram')) !== false;
  const keys = await favouriteKeys(deps, req, config);

  const group = await groupOf(deps, live, askOf(req));
  const isFavourite = (c: ListedChannel) => keys.has(channelKeyOf(c.meta));

  let channels: ListedChannel[];
  let total: number;
  if (group !== undefined && isFavorite !== undefined) {
    const whole = await listGroup(deps.addon, live.base, live.catalogs, group, { startIndex: 0, limit: MAX_GROUP });
    const kept = whole.channels.filter((c) => isFavourite(c) === isFavorite);
    channels = kept.slice(startIndex, startIndex + limit);
    total = kept.length;
  } else if (group !== undefined) {
    ({ channels, total } = await listGroup(deps.addon, live.base, live.catalogs, group, { startIndex, limit }));
    if (sorting) channels = [...channels.filter(isFavourite), ...channels.filter((c) => !isFavourite(c))];
  } else if (isFavorite === true) {
    const favourites = await resolveFavourites(deps, live, keys);
    channels = favourites.slice(startIndex, startIndex + limit);
    total = favourites.length;
  } else if (isFavorite === false) {
    ({ channels, total } = await listSkipping(deps, live, keys, startIndex, limit));
  } else if (sorting && keys.size) {
    const favourites = await resolveFavourites(deps, live, keys);
    const head = favourites.slice(startIndex, startIndex + limit);
    const rest = await listSkipping(deps, live, keys, Math.max(0, startIndex - favourites.length), limit - head.length);
    const unlisted = favourites.filter((c) => !isListed(deps.addon, live.base, live.catalogs, c.meta)).length;
    channels = [...head, ...rest.channels];
    total = rest.total + rest.skipped + unlisted;
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

export function guideInfo(manifest: any, now: number): { StartDate: string; EndDate: string } {
  const range = guideRange(manifest, now);
  return { StartDate: new Date(range.start).toISOString(), EndDate: new Date(range.end).toISOString() };
}

async function programmeChannels(deps: LiveTvDeps, live: LiveTv, ask: Ask): Promise<ListedChannel[]> {
  const asked = listOf(ask('ChannelIds')).slice(0, MAX_ASKED_CHANNELS);
  if (!asked.length) {
    const group = await groupOf(deps, live, ask, false);
    if (group === undefined || !isGroup(live, group)) return guideChannels(deps.addon, live.base, live.catalogs, PROGRAMME_CHANNELS);
    return (await listGroup(deps.addon, live.base, live.catalogs, group, { startIndex: 0, limit: PROGRAMME_CHANNELS })).channels;
  }
  const descriptors = await Promise.all(asked.map((id) => deps.decodeLiveId(id)));
  const refs = descriptors.filter((d) => d?.k === 'channel').map((d) => ({ type: d.t, id: d.i }));
  const placements = await placementsFor(deps.addon, live.base, live.catalogs, refs);
  const channels: ListedChannel[] = [];
  for (const placement of placements) {
    if (placement && placement !== GONE) channels.push({ meta: placement.meta, number: placement.number });
  }
  return channels;
}

export async function programmesAround(deps: LiveTvDeps, live: LiveTv, channels: ListedChannel[], ask: Ask, now: number): Promise<GuideItem[]> {
  const range = guideRange(live.manifest, now);
  const min = timeOf(ask('MinStartDate')) ?? timeOf(ask('MinEndDate'));
  const max = timeOf(ask('MaxStartDate')) ?? timeOf(ask('MaxEndDate'));
  const aired = flag(ask('HasAired')) === true;
  const past = aired || (max !== null && max <= now);
  const from = Math.max(range.start, min ?? (past ? range.start : now));
  const to = Math.min(range.end, max ?? (aired ? now : Math.max(now, from) + PROGRAMME_WINDOW_MS));
  if (!channels.length || from > to) return [];
  const found = await programmesFor(deps.addon, live.base, live.catalogs, channels.map((c) => c.meta), from, to + 1);
  const items: GuideItem[] = [];
  for (const channel of channels) {
    for (const programme of found.get(channelKeyOf(channel.meta)) ?? []) items.push({ channel, programme });
  }
  return items;
}

export function programItems(deps: LiveTvDeps, req: any, items: GuideItem[], now: number, opened = false): any[] {
  const serverId = deps.serverIdFor(userOf(req));
  return items.map(({ channel, programme }) =>
    programItem(deps, serverId, channel, programme, { opened, catchup: caughtUp(channel.meta, programme.start, now) })
  );
}

const sameTitle = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

async function programmePage(deps: LiveTvDeps, req: any, live: LiveTv, ask: Ask): Promise<any> {
  const now = deps.now();
  const startIndex = Math.max(0, integer(ask('StartIndex'), 0));
  const seriesId = ask('LibrarySeriesId');
  const title = seriesId ? await deps.seriesTitle(req, String(seriesId)) : undefined;
  if (title === null || ask('SeriesTimerId')) return deps.itemList([], 0, startIndex);
  const channels = await programmeChannels(deps, live, ask);
  let around = await programmesAround(deps, live, channels, ask, now);
  if (title !== undefined) around = around.filter(({ programme }) => sameTitle(programme.title, title));
  const { items, total } = filterProgrammes(around, ask, now);
  return deps.itemList(programItems(deps, req, items, now), total, startIndex);
}

export async function programmeById(deps: LiveTvDeps, req: any, live: LiveTv, descriptor: any): Promise<Answer> {
  if (descriptor?.k !== 'program') return NOT_FOUND;
  const target = await programmeTarget(deps.addon, live.base, live.catalogs, descriptor);
  if (!target?.programme) return NOT_FOUND;
  const [item] = programItems(deps, req, [{ channel: target.channel, programme: target.programme }], deps.now(), true);
  return { status: 200, body: item };
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

  router.get('/LiveTv/GuideInfo', gated(deps, (_req, res, live) => {
    res.json(guideInfo(live.manifest, deps.now()));
  }));

  router.get('/LiveTv/Channels', gated(deps, async (req, res, live, config) => {
    res.json(await channelPage(deps, req, live, config));
  }));

  router.get('/LiveTv/Channels/:channelId', gated(deps, async (req, res, live, config) => {
    const answer = await channelById(deps, req, live, config, await deps.decodeLiveId(req.params.channelId));
    res.status(answer.status).json(answer.body);
  }));

  router.get('/LiveTv/Programs/Recommended', gated(deps, async (req, res, live) => {
    const ask = askOf(req);
    const byStart: Ask = (name) => (/^sort(by|order)$/i.test(name) ? undefined : ask(name));
    res.json(await programmePage(deps, req, live, byStart));
  }));

  router.get('/LiveTv/Programs', gated(deps, async (req, res, live) => {
    res.json(await programmePage(deps, req, live, askOf(req)));
  }));

  router.post('/LiveTv/Programs', gated(deps, async (req, res, live) => {
    res.json(await programmePage(deps, req, live, askOf(req)));
  }));

  router.get('/LiveTv/Programs/:programId', gated(deps, async (req, res, live) => {
    const answer = await programmeById(deps, req, live, await deps.decodeLiveId(req.params.programId));
    res.status(answer.status).json(answer.body);
  }));
}
