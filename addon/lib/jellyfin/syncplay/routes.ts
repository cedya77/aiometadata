import { randomUUID } from 'crypto';
import consola from 'consola';
import { dashedGuid, normaliseJellyfinId } from '../idsCodec';
import * as E from './engine';
import type { GroupStore } from './store';
import { graceMs, syncPlayActive, syncPlayEnabled, syncPlayScope } from './settings';

const logger = consola.withTag('SyncPlay');

export interface SyncPlayDeps {
  loadConfig(req: any): Promise<any>;
  profileFor(req: any, config: any): { name: string };
  profileKey(config: any): string;
  clientInfo(req: any): { deviceId: string };
  nowPlaying(req: any, config: any): Promise<{ itemId: string; positionTicks: number; paused: boolean } | null>;
  decode(id: string): Promise<{ k: string } | null>;
  /** A profile held to an age rating, which a shared queue cannot respect. */
  restricted?(config: any): boolean;
  store: GroupStore;
  push(userUUID: string, profile: string, deviceId: string, type: string, data: any): void;
  liveDevices(userUUID: string, profile: string): Promise<Array<{ deviceId: string }>>;
}

const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';
const MAX_NAME = 100;

const ctxAt = (now: number): E.Ctx => ({ now, graceMs: graceMs(), random: Math.random, newId: () => randomUUID().replace(/-/g, '') });
const iso = (ms: number) => new Date(ms).toISOString();
const guidOut = (hex: string) => (hex ? dashedGuid(hex) : EMPTY_GUID);
const none = (): E.Result => ({ group: null, out: [] });

function param(source: any, name: string): any {
  if (!source || typeof source !== 'object') return undefined;
  const key = Object.keys(source).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : source[key];
}

const guid = (value: unknown): string => normaliseJellyfinId(String(value ?? ''));
const guids = (value: unknown): string[] =>
  (Array.isArray(value) ? value : String(value ?? '').split(',')).map(guid).filter(Boolean);
const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const ticks = (value: unknown): number => Math.max(num(value), 0);
const bool = (value: unknown): boolean => value === true || String(value).toLowerCase() === 'true';
const pick = <T extends string>(list: readonly T[], value: unknown, fallback: T): T =>
  list.includes(value as T) ? (value as T) : fallback;
const whenOf = (value: unknown, now: number): number => {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : now;
};

const PLAYABLE = new Set(['movie', 'episode']);

function parse(action: string, body: any, now: number): E.Request | null {
  const field = (name: string) => param(body, name);
  const report = () => ({
    when: whenOf(field('When'), now),
    ticks: ticks(field('PositionTicks')),
    isPlaying: bool(field('IsPlaying')),
    playlistItemId: guid(field('PlaylistItemId')),
  });
  switch (action) {
    case 'setnewqueue':
      return { type: 'SetNewQueue', items: guids(field('PlayingQueue')), index: num(field('PlayingItemPosition')), startTicks: ticks(field('StartPositionTicks')) };
    case 'queue':
      return { type: 'Queue', items: guids(field('ItemIds')), mode: field('Mode') === 'QueueNext' ? 'QueueNext' : 'Queue' };
    case 'setplaylistitem':
      return { type: 'SetPlaylistItem', id: guid(field('PlaylistItemId')) };
    case 'removefromplaylist':
      return { type: 'RemoveFromPlaylist', ids: guids(field('PlaylistItemIds')), clearPlaylist: bool(field('ClearPlaylist')), clearPlayingItem: bool(field('ClearPlayingItem')) };
    case 'moveplaylistitem':
      return { type: 'MovePlaylistItem', id: guid(field('PlaylistItemId')), newIndex: num(field('NewIndex')) };
    case 'pause':
      return { type: 'Pause' };
    case 'unpause':
      return { type: 'Unpause' };
    case 'stop':
      return { type: 'Stop' };
    case 'seek':
      return { type: 'Seek', ticks: ticks(field('PositionTicks')) };
    case 'buffering':
      return { type: 'Buffer', ...report() };
    case 'ready':
      return { type: 'Ready', ...report() };
    case 'setignorewait':
      return { type: 'IgnoreWait', value: bool(field('IgnoreWait')) };
    case 'nextitem':
      return { type: 'NextItem', playlistItemId: guid(field('PlaylistItemId')) };
    case 'previousitem':
      return { type: 'PreviousItem', playlistItemId: guid(field('PlaylistItemId')) };
    case 'setrepeatmode':
      return { type: 'SetRepeatMode', mode: pick(['RepeatOne', 'RepeatAll', 'RepeatNone'] as const, field('Mode'), 'RepeatNone') };
    case 'setshufflemode':
      return { type: 'SetShuffleMode', mode: pick(['Sorted', 'Shuffle'] as const, field('Mode'), 'Sorted') };
    case 'ping':
      return { type: 'Ping', ms: num(field('Ping')) };
    default:
      return null;
  }
}

function deliver(deps: SyncPlayDeps, groupId: string, out: E.Out[]): void {
  for (const o of out) {
    const [type, data] =
      o.kind === 'command'
        ? ['SyncPlayCommand', { GroupId: guidOut(groupId), PlaylistItemId: guidOut(o.playlistItemId), When: iso(o.whenMs), PositionTicks: o.positionTicks, Command: o.command, EmittedAt: iso(o.emittedMs) }]
        : ['SyncPlayGroupUpdate', { GroupId: guidOut(groupId), Type: o.type, Data: o.data }];
    for (const r of o.to) deps.push(r.userUUID, r.profile, r.deviceId, type, data);
  }
}

function notice(deps: SyncPlayDeps, member: E.Recipient, type: E.UpdateType): void {
  deps.push(member.userUUID, member.profile, member.deviceId, 'SyncPlayGroupUpdate', { GroupId: EMPTY_GUID, Type: type, Data: '' });
}

async function resolve(req: any, deps: SyncPlayDeps): Promise<{ config: any; member: E.Member | null }> {
  const config = await deps.loadConfig(req);
  const deviceId = String(deps.clientInfo(req)?.deviceId ?? 'unknown');
  if (!deviceId || deviceId === 'unknown') return { config, member: null };
  const userUUID = String(req.params?.userUUID ?? '');
  const profile = deps.profileKey(config);
  const member: E.Member = {
    key: `${userUUID}|${profile}|${deviceId}`,
    userUUID,
    profile,
    deviceId,
    name: deps.profileFor(req, config)?.name || 'User',
    ping: 500,
    buffering: false,
    ignoreWait: false,
  };
  return { config, member };
}

export async function memberFor(req: any, deps: SyncPlayDeps): Promise<E.Member | null> {
  return (await resolve(req, deps)).member;
}

const visible = (g: E.Group, userUUID: string) => syncPlayScope() === 'instance' || g.home === userUUID;

async function change(deps: SyncPlayDeps, id: string, fn: (g: E.Group) => E.Result): Promise<E.Result | null> {
  const result = await deps.store.update(id, (g) => (g ? fn(g) : none()));
  if (result) deliver(deps, id, result.out);
  return result;
}

/** Busy when the group's lock could not be taken, so the member is still in it. */
async function leaveGroup(deps: SyncPlayDeps, member: E.Member): Promise<'left' | 'none' | 'busy'> {
  const id = await deps.store.groupOf(member.key);
  if (!id) return 'none';
  let left = false;
  const result = await change(deps, id, (g) => {
    left = g.members.some((m) => m.key === member.key);
    return left ? E.leave(g, member.key, ctxAt(Date.now())) : { group: g, out: [] };
  });
  if (!result) return 'busy';
  if (!left) await deps.store.release(member.key, id);
  return left ? 'left' : 'none';
}

export async function leaveOnLogout(req: any, deps: SyncPlayDeps): Promise<void> {
  const member = await memberFor(req, deps);
  if (member) await leaveGroup(deps, member);
}

async function playableIndexes(deps: SyncPlayDeps, ids: string[]): Promise<number[]> {
  const kinds = await Promise.all(ids.map((id) => deps.decode(id).catch(() => null)));
  return ids.map((_, i) => i).filter((i) => PLAYABLE.has(String(kinds[i]?.k)));
}

async function playable(deps: SyncPlayDeps, ids: string[]): Promise<string[]> {
  return (await playableIndexes(deps, ids)).map((i) => ids[i]);
}

/** Where the asked-for item, or the next playable one after it, sits once unplayable ones are dropped. */
function keptPosition(kept: number[], asked: number): number {
  const at = kept.findIndex((i) => i >= asked);
  return at >= 0 ? at : Math.max(kept.length - 1, 0);
}

export function registerSyncPlayPublic(router: any): void {
  router.get('/GetUtcTime', (_req: any, res: any) => {
    const received = iso(Date.now());
    res.json({ RequestReceptionTime: received, ResponseTransmissionTime: iso(Date.now()) });
  });
}

export function registerSyncPlay(router: any, deps: SyncPlayDeps): void {
  const busy = (res: any) => res.status(503).json({ Message: 'SyncPlay is busy' });
  const refused = (res: any) => res.status(403).json({ Message: 'SyncPlay is not available for a user with an age rating limit' });
  const handler = (fn: (req: any, res: any) => Promise<void>) => async (req: any, res: any, next: any) => {
    if (!syncPlayEnabled()) {
      res.status(403).json({ Message: 'SyncPlay is disabled' });
      return;
    }
    try {
      await fn(req, res);
    } catch (error) {
      next(error);
    }
  };

  router.get('/SyncPlay/List', handler(async (req, res) => {
    const now = Date.now();
    const groups = await deps.store.list();
    res.json(groups.filter((g) => visible(g, req.params.userUUID)).map((g) => E.info(g, now)));
  }));

  router.get('/SyncPlay/:groupId', handler(async (req, res) => {
    const g = await deps.store.get(guid(req.params.groupId));
    if (!g || !visible(g, req.params.userUUID)) {
      res.status(404).json({ Message: 'Group not found' });
      return;
    }
    res.json(E.info(g, Date.now()));
  }));

  router.post('/SyncPlay/New', handler(async (req, res) => {
    const { config, member } = await resolve(req, deps);
    if (deps.restricted?.(config)) return refused(res);
    if (!member) {
      res.status(400).json({ Message: 'A device id is required' });
      return;
    }
    if ((await leaveGroup(deps, member)) === 'busy') return busy(res);
    let playing = await deps.nowPlaying(req, config).catch(() => null);
    if (playing) {
      const itemId = guid(playing.itemId);
      playing = (await playable(deps, [itemId])).length ? { ...playing, itemId } : null;
    }
    const raw = param(req.body, 'GroupName');
    const name = (typeof raw === 'string' && raw.trim().slice(0, MAX_NAME)) || `${member.name}'s group`;
    const id = randomUUID().replace(/-/g, '');
    const now = Date.now();
    const result = await deps.store.update(id, () => E.create(id, name, member.userUUID, member, ctxAt(now), playing ?? undefined));
    if (!result?.group) return busy(res);
    deliver(deps, id, result.out);
    logger.debug(`Group ${id} created`);
    res.json(E.info(result.group, now));
  }));

  router.post('/SyncPlay/Join', handler(async (req, res) => {
    const { config, member } = await resolve(req, deps);
    if (deps.restricted?.(config)) return refused(res);
    if (!member) {
      res.status(204).end();
      return;
    }
    const id = guid(param(req.body, 'GroupId'));
    const g = id ? await deps.store.get(id) : null;
    if (!g || !visible(g, req.params.userUUID)) {
      notice(deps, member, 'GroupDoesNotExist');
      res.status(204).end();
      return;
    }
    const current = await deps.store.groupOf(member.key);
    if (current && current !== id && (await leaveGroup(deps, member)) === 'busy') return busy(res);
    const result = await change(deps, id, (group) => E.join(group, member, ctxAt(Date.now())));
    if (!result) return busy(res);
    if (!result.group) notice(deps, member, 'GroupDoesNotExist');
    res.status(204).end();
  }));

  router.post('/SyncPlay/Leave', handler(async (req, res) => {
    const member = await memberFor(req, deps);
    const outcome = member ? await leaveGroup(deps, member) : 'left';
    if (outcome === 'busy') return busy(res);
    if (member && outcome === 'none') notice(deps, member, 'NotInGroup');
    res.status(204).end();
  }));

  router.post('/SyncPlay/:action', handler(async (req, res) => {
    const action = String(req.params.action).toLowerCase();
    const request = parse(action, req.body, Date.now());
    if (!request) {
      res.status(404).json({ Message: 'Unknown SyncPlay request' });
      return;
    }
    const member = await memberFor(req, deps);
    if (!member) {
      res.status(204).end();
      return;
    }
    const id = await deps.store.groupOf(member.key);
    if (!id) {
      if (request.type !== 'Ping') notice(deps, member, 'NotInGroup');
      res.status(204).end();
      return;
    }
    if (request.type === 'SetNewQueue' || request.type === 'Queue') {
      const kept = await playableIndexes(deps, request.items);
      if (request.type === 'SetNewQueue') request.index = keptPosition(kept, Math.floor(request.index) || 0);
      request.items = kept.map((i) => request.items[i]);
      if (!request.items.length) {
        notice(deps, member, 'LibraryAccessDenied');
        res.status(204).end();
        return;
      }
    }
    let found = false;
    const result = await change(deps, id, (g) => {
      found = g.members.some((m) => m.key === member.key);
      return E.handle(g, member.key, request, ctxAt(Date.now()));
    });
    if (!result) return busy(res);
    if (!found) {
      await deps.store.release(member.key, id);
      if (request.type !== 'Ping') notice(deps, member, 'NotInGroup');
    }
    res.status(204).end();
  }));
}

export async function sweepOnce(deps: SyncPlayDeps, now: number): Promise<void> {
  if (!syncPlayActive()) return;
  for (const id of await deps.store.due(now)) {
    const g = await deps.store.get(id);
    if (!g) {
      await deps.store.forget(id);
      continue;
    }
    const checking = g.presenceCheckAt <= now ? g.members : g.members.filter((m) => m.awayUntil !== undefined && m.awayUntil <= now);
    const offline = new Set<string>();
    const scopes = new Map<string, E.Member[]>();
    for (const m of checking) scopes.set(`${m.userUUID}\u0000${m.profile}`, [...(scopes.get(`${m.userUUID}\u0000${m.profile}`) ?? []), m]);
    for (const list of scopes.values()) {
      const devices = await deps.liveDevices(list[0].userUUID, list[0].profile).catch(() => null);
      if (!devices) continue;
      const live = new Set(devices.map((d) => d.deviceId));
      for (const m of list) if (!live.has(m.deviceId)) offline.add(m.key);
    }
    await change(deps, id, (fresh) => E.tick(fresh, ctxAt(now), offline));
  }
}

let sweeping: NodeJS.Timeout | null = null;

export function startSweep(deps: SyncPlayDeps): void {
  if (sweeping) return;
  let running = false;
  sweeping = setInterval(() => {
    if (running) return;
    running = true;
    sweepOnce(deps, Date.now())
      .catch((error: any) => logger.debug(`Sweep failed: ${error?.message || error}`))
      .finally(() => {
        running = false;
      });
  }, 1000);
  sweeping.unref?.();
}

async function markDevice(deps: SyncPlayDeps, userUUID: string, profile: string, deviceId: string, gone: boolean): Promise<void> {
  if (!syncPlayActive()) return;
  const key = `${userUUID}|${profile}|${deviceId}`;
  const id = await deps.store.groupOf(key);
  if (!id) return;
  const now = Date.now();
  await change(deps, id, (g) => ({ group: gone ? E.away(g, key, ctxAt(now)) : E.back(g, key), out: [] }));
}

export const deviceGone = (deps: SyncPlayDeps, userUUID: string, profile: string, deviceId: string) => markDevice(deps, userUUID, profile, deviceId, true);
export const deviceBack = (deps: SyncPlayDeps, userUUID: string, profile: string, deviceId: string) => markDevice(deps, userUUID, profile, deviceId, false);
