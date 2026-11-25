// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { Descriptor, ProgramRef } from '../idsCodec';
import type { LiveCatalog } from './catalogs';
import { flagsOf, type Programme } from './guide';
import type { ListedChannel } from './lineup';

const TICKS_PER_MS = 10000;
const MAX_CAST = 20;

export interface ItemDeps {
  encodeId(d: Descriptor): string;
  encodeProgramId(ref: ProgramRef, channelId?: string): string | null;
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

export function liveTvView(deps: ItemDeps, serverId: string, { guide = false, groups = false }: { guide?: boolean; groups?: boolean } = {}): any {
  const view = { ...deps.collectionFolder(liveTvViewId(deps), serverId, 'Live TV', 'livetv', null), Type: 'UserView' };
  return guide || groups ? { ...view, aiostreams: { ...(guide && { guide }), ...(groups && { groups }) } } : view;
}

export function groupItem(deps: ItemDeps, serverId: string, catalog: Pick<LiveCatalog, 'type' | 'id'>, name: string): any {
  return {
    Name: name,
    Id: deps.encodeId({ k: 'genre', t: catalog.type, c: catalog.id, g: name }),
    ServerId: serverId,
    Type: 'Genre',
    IsFolder: false,
    ImageTags: {},
    BackdropImageTags: [],
    ImageBlurHashes: {},
  };
}

export const channelIdOf = (deps: Pick<ItemDeps, 'encodeId'>, channel: ListedChannel): string =>
  deps.encodeId({ k: 'channel', t: channel.meta.type, i: channel.meta.id });

/** The shape of a live item's primary image: a channel's is its logo, a programme's a still. */
export function livePrimaryKind(descriptor: any): 'logo' | 'thumb' | undefined {
  return descriptor?.k === 'channel' ? 'logo' : descriptor?.k === 'program' ? 'thumb' : undefined;
}

const imageOf = (channel: ListedChannel): string | undefined => channel.meta.logo ?? channel.meta.poster;

export interface ChannelParts {
  id: string;
  imageTag?: string;
}

export function channelParts(deps: ItemDeps, serverId: string, channel: ListedChannel): ChannelParts {
  const id = channelIdOf(deps, channel);
  const image = imageOf(channel);
  if (!image) return { id };
  deps.rememberImages(serverId, id, { primary: image });
  return { id, imageTag: deps.imageTag(image) };
}

export function channelItem(
  deps: ItemDeps,
  serverId: string,
  channel: ListedChannel,
  { airing, favourite }: { airing?: Programme; favourite: boolean }
): any {
  const parts = channelParts(deps, serverId, channel);
  const { id, imageTag } = parts;
  const item: any = {
    Name: channel.meta.name,
    ServerId: serverId,
    Id: id,
    Type: 'TvChannel',
    ChannelType: 'TV',
    MediaType: 'Video',
    IsFolder: false,
    LocationType: 'Remote',
    ImageTags: imageTag ? { Primary: imageTag } : {},
    BackdropImageTags: [],
    UserData: { ...deps.emptyUserData, IsFavorite: favourite, Key: id, ItemId: id },
    MediaSources: [{ ...deps.placeholderMediaSource(id, 'Live'), IsInfiniteStream: true, Container: undefined }],
  };
  if (channel.number) {
    item.ChannelNumber = channel.number;
    item.Number = channel.number;
  }
  if (airing) item.CurrentProgram = programItem(deps, serverId, channel, airing, { parts });
  return item;
}

export function programItem(
  deps: ItemDeps,
  serverId: string,
  channel: ListedChannel,
  programme: Programme,
  { opened = false, catchup = false, parts = channelParts(deps, serverId, channel) }: { opened?: boolean; catchup?: boolean; parts?: ChannelParts } = {}
): any {
  const id = deps.encodeProgramId({ t: channel.meta.type, i: channel.meta.id, at: Math.floor(programme.start / 1000) }, parts.id);
  const item: any = {
    Name: programme.title,
    ServerId: serverId,
    Id: id,
    Type: 'Program',
    MediaType: 'Video',
    IsFolder: false,
    LocationType: 'Remote',
    ChannelId: parts.id,
    ChannelName: channel.meta.name,
    StartDate: new Date(programme.start).toISOString(),
    EndDate: new Date(programme.end).toISOString(),
    RunTimeTicks: (programme.end - programme.start) * TICKS_PER_MS,
    ImageTags: {},
    BackdropImageTags: [],
  };
  if (programme.overview) item.Overview = programme.overview;
  if (channel.number) item.ChannelNumber = channel.number;
  if (parts.imageTag) item.ChannelPrimaryImageTag = parts.imageTag;
  Object.assign(item, flagsOf(programme));
  if (programme.genres) item.Genres = programme.genres;
  if (programme.season !== undefined) item.ParentIndexNumber = programme.season;
  if (programme.episode !== undefined) item.IndexNumber = programme.episode;
  if (opened) {
    const person = (type: string) => (name: string) => ({ Id: deps.encodeId({ k: 'person', n: name }), Name: name, Type: type });
    const people = [...(programme.cast ?? []).slice(0, MAX_CAST).map(person('Actor')), ...(programme.directors ?? []).map(person('Director'))];
    if (people.length) item.People = people;
  }
  if (programme.imdbId) item.ProviderIds = { Imdb: programme.imdbId };
  if (catchup) item.aiostreams = { catchup: true };
  if (opened && id && (programme.image || programme.background)) {
    deps.rememberImages(serverId, id, { primary: programme.image, backdrop: programme.background });
    if (programme.image) item.ImageTags = { Primary: deps.imageTag(programme.image) };
    if (programme.background) item.BackdropImageTags = [deps.imageTag(programme.background)];
  }
  return item;
}
