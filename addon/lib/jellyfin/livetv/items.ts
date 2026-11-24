// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { Descriptor, ProgramRef } from '../idsCodec';
import { flagsOf, type Programme } from './guide';
import type { ListedChannel } from './lineup';

const TICKS_PER_MS = 10000;

export interface ItemDeps {
  encodeId(d: Descriptor): string;
  encodeProgramId(ref: ProgramRef): string | null;
  rememberImages(scope: string, itemId: string, images: { primary?: string; backdrop?: string }): void;
  imageTag(url: string): string;
  placeholderMediaSource(id: string, name: string): any;
  collectionFolder(id: string, serverId: string, name: string, collectionType: string | null, childCount: number | null): any;
  emptyUserData: Record<string, unknown>;
}

let viewId: string | undefined;

export function liveTvViewId(deps: Pick<ItemDeps, 'encodeId'>): string {
  viewId ??= deps.encodeId({ k: 'livetv' });
  return viewId;
}

export function liveTvView(deps: ItemDeps, serverId: string, { guide = false }: { guide?: boolean } = {}): any {
  const view = { ...deps.collectionFolder(liveTvViewId(deps), serverId, 'Live TV', 'livetv', null), Type: 'UserView' };
  return guide ? { ...view, aiostreams: { guide: true } } : view;
}

export const channelIdOf = (deps: Pick<ItemDeps, 'encodeId'>, channel: ListedChannel): string =>
  deps.encodeId({ k: 'channel', t: channel.meta.type, i: channel.meta.id });

const imageOf = (channel: ListedChannel): string | undefined => channel.meta.logo ?? channel.meta.poster;

export function channelItem(
  deps: ItemDeps,
  serverId: string,
  channel: ListedChannel,
  { airing, favourite }: { airing?: Programme; favourite: boolean }
): any {
  const id = channelIdOf(deps, channel);
  const image = imageOf(channel);
  const imageTags: Record<string, string> = {};
  if (image) {
    deps.rememberImages(serverId, id, { primary: image });
    imageTags.Primary = deps.imageTag(image);
  }
  const item: any = {
    Name: channel.meta.name,
    ServerId: serverId,
    Id: id,
    Type: 'TvChannel',
    ChannelType: 'TV',
    MediaType: 'Video',
    IsFolder: false,
    LocationType: 'Remote',
    ImageTags: imageTags,
    BackdropImageTags: [],
    UserData: { ...deps.emptyUserData, IsFavorite: favourite, Key: id, ItemId: id },
    MediaSources: [{ ...deps.placeholderMediaSource(id, 'Live'), IsInfiniteStream: true, Container: undefined }],
  };
  if (channel.number) {
    item.ChannelNumber = channel.number;
    item.Number = channel.number;
  }
  if (airing) item.CurrentProgram = programItem(deps, serverId, channel, airing);
  return item;
}

export function programItem(
  deps: ItemDeps,
  serverId: string,
  channel: ListedChannel,
  programme: Programme,
  { images = false, catchup = false }: { images?: boolean; catchup?: boolean } = {}
): any {
  const channelId = channelIdOf(deps, channel);
  const image = imageOf(channel);
  const id = deps.encodeProgramId({ t: channel.meta.type, i: channel.meta.id, at: Math.floor(programme.start / 1000) });
  const item: any = {
    Name: programme.title,
    ServerId: serverId,
    Id: id,
    Type: 'Program',
    MediaType: 'Video',
    IsFolder: false,
    LocationType: 'Remote',
    ChannelId: channelId,
    ChannelName: channel.meta.name,
    StartDate: new Date(programme.start).toISOString(),
    EndDate: new Date(programme.end).toISOString(),
    RunTimeTicks: (programme.end - programme.start) * TICKS_PER_MS,
    ImageTags: {},
    BackdropImageTags: [],
  };
  if (programme.overview) item.Overview = programme.overview;
  if (channel.number) item.ChannelNumber = channel.number;
  if (image) {
    deps.rememberImages(serverId, channelId, { primary: image });
    item.ChannelPrimaryImageTag = deps.imageTag(image);
  }
  Object.assign(item, flagsOf(programme));
  if (programme.genres) item.Genres = programme.genres;
  if (programme.season !== undefined) item.ParentIndexNumber = programme.season;
  if (programme.episode !== undefined) item.IndexNumber = programme.episode;
  const people = [
    ...(programme.cast ?? []).map((name) => ({ Name: name, Type: 'Actor' })),
    ...(programme.directors ?? []).map((name) => ({ Name: name, Type: 'Director' })),
  ];
  if (people.length) item.People = people;
  if (programme.imdbId) item.ProviderIds = { Imdb: programme.imdbId };
  if (catchup) item.aiostreams = { catchup: true };
  if (images && id && (programme.image || programme.background)) {
    deps.rememberImages(serverId, id, { primary: programme.image, backdrop: programme.background });
    if (programme.image) item.ImageTags = { Primary: deps.imageTag(programme.image) };
    if (programme.background) item.BackdropImageTags = [deps.imageTag(programme.background)];
  }
  return item;
}
