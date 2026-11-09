import { dashedGuid } from '../idsCodec';
import * as Q from './queue';

export type State = 'Idle' | 'Waiting' | 'Paused' | 'Playing';
export type CommandType = 'Unpause' | 'Pause' | 'Stop' | 'Seek';
export type UpdateType =
  | 'GroupJoined'
  | 'GroupLeft'
  | 'UserJoined'
  | 'UserLeft'
  | 'PlayQueue'
  | 'StateUpdate'
  | 'NotInGroup'
  | 'GroupDoesNotExist'
  | 'LibraryAccessDenied';

export interface Recipient {
  userUUID: string;
  profile: string;
  deviceId: string;
}

export interface Member extends Recipient {
  key: string;
  name: string;
  ping: number;
  buffering: boolean;
  ignoreWait: boolean;
  awayUntil?: number;
}

export interface Group {
  id: string;
  name: string;
  home: string;
  state: State;
  wanted: 'Playing' | 'Paused';
  positionTicks: number;
  lastActivity: number;
  members: Member[];
  queue: Q.Queue;
  waitDeadline?: number;
  presenceCheckAt: number;
  release?: { playlistItemId: string; identity: string };
}

interface Report {
  when: number;
  ticks: number;
  isPlaying: boolean;
  playlistItemId: string;
}

export type Request =
  | { type: 'SetNewQueue'; items: string[]; index: number; startTicks: number }
  | { type: 'Queue'; items: string[]; mode: 'Queue' | 'QueueNext' }
  | { type: 'SetPlaylistItem'; id: string }
  | { type: 'RemoveFromPlaylist'; ids: string[]; clearPlaylist: boolean; clearPlayingItem: boolean }
  | { type: 'MovePlaylistItem'; id: string; newIndex: number }
  | { type: 'Pause' }
  | { type: 'Unpause' }
  | { type: 'Stop' }
  | { type: 'Seek'; ticks: number }
  | ({ type: 'Buffer' } & Report)
  | ({ type: 'Ready' } & Report)
  | { type: 'NextItem'; playlistItemId: string }
  | { type: 'PreviousItem'; playlistItemId: string }
  | { type: 'SetRepeatMode'; mode: Q.RepeatMode }
  | { type: 'SetShuffleMode'; mode: Q.ShuffleMode }
  | { type: 'IgnoreWait'; value: boolean }
  | { type: 'Ping'; ms: number };

export type Out =
  | { to: Recipient[]; kind: 'command'; command: CommandType; whenMs: number; positionTicks: number; playlistItemId: string; emittedMs: number }
  | { to: Recipient[]; kind: 'update'; type: UpdateType; data: any };

export interface Ctx extends Q.Rand {
  now: number;
  graceMs: number;
}

export interface Result {
  group: Group | null;
  out: Out[];
}

const TICKS_PER_MS = 10000;
const WAIT_MS = 30000;
const PRESENCE_MS = 30000;
const MAX_OFFSET_MS = 500;
const TIME_SYNC_MS = 2000;
const DEFAULT_PING = 500;
const MAX_PING = 10000;

const recipient = (m: Member): Recipient => ({ userUUID: m.userUUID, profile: m.profile, deviceId: m.deviceId });
const clone = (g: Group): Group => JSON.parse(JSON.stringify(g));

class Turn {
  out: Out[] = [];
  constructor(public g: Group, public ctx: Ctx) {}

  get now(): number {
    return this.ctx.now;
  }

  all(): Member[] {
    return this.g.members;
  }

  others(key: string): Member[] {
    return this.g.members.filter((m) => m.key !== key);
  }

  readyMembers(): Member[] {
    return this.g.members.filter((m) => !m.buffering);
  }

  update(to: Member[], type: UpdateType, data: any): void {
    if (to.length) this.out.push({ to: to.map(recipient), kind: 'update', type, data });
  }

  command(to: Member[], command: CommandType): void {
    if (!to.length) return;
    const g = this.g;
    this.out.push({
      to: to.map(recipient),
      kind: 'command',
      command,
      whenMs: command === 'Unpause' ? g.lastActivity : this.now,
      positionTicks: Math.max(g.positionTicks, 0),
      playlistItemId: Q.current(g.queue)?.playlistItemId ?? '',
      emittedMs: this.now,
    });
  }

  queue(to: Member[], reason: Q.QueueReason): void {
    this.update(to, 'PlayQueue', Q.snapshot(this.g.queue, reason, this.g.positionTicks, this.g.state === 'Playing'));
  }

  stateUpdate(to: Member[], reason: string): void {
    this.update(to, 'StateUpdate', { State: this.g.state, Reason: reason });
  }

  setState(state: State): void {
    if (state !== 'Waiting') this.g.waitDeadline = undefined;
    this.g.state = state;
  }

  delay(): number {
    return Math.max(2 * Math.max(0, ...this.g.members.map((m) => m.ping)), DEFAULT_PING);
  }

  restartWait(wanted: 'Playing' | 'Paused'): void {
    this.setState('Waiting');
    this.g.wanted = wanted;
    this.g.lastActivity = this.now;
    for (const m of this.g.members) m.buffering = true;
    this.g.waitDeadline = this.now + WAIT_MS;
  }

  enterWaiting(wanted: 'Playing' | 'Paused'): void {
    this.setState('Waiting');
    this.g.wanted = wanted;
    this.g.waitDeadline ??= this.now + WAIT_MS;
  }

  freezePosition(): void {
    this.g.positionTicks = livePosition(this.g, this.now);
    this.g.lastActivity = this.now;
  }

  resume(reason: string): void {
    const g = this.g;
    if (g.wanted === 'Playing') {
      g.lastActivity = this.now + this.delay();
      this.setState('Playing');
      this.command(this.all(), 'Unpause');
      this.stateUpdate(this.all(), reason);
    } else {
      this.setState('Paused');
      this.command(this.all(), 'Pause');
      this.stateUpdate(this.all(), reason);
    }
  }

  checkReady(reason: string): void {
    if (this.g.state !== 'Waiting') return;
    if (this.g.members.every((m) => !m.buffering || m.ignoreWait)) this.resume(reason);
  }

  stop(reason: string): void {
    this.g.positionTicks = 0;
    this.g.lastActivity = this.now;
    for (const m of this.g.members) m.buffering = false;
    this.setState('Idle');
    this.command(this.all(), 'Stop');
    this.stateUpdate(this.all(), reason);
  }

  startItem(reason: Q.QueueReason, stateReason: string): void {
    this.g.positionTicks = 0;
    this.restartWait('Playing');
    this.queue(this.all(), reason);
    this.stateUpdate(this.all(), stateReason);
  }

  /** What a member that lost track of the group is told to do now. */
  stateCommand(m: Member, reason: string): void {
    switch (this.g.state) {
      case 'Idle':
        return this.command([m], 'Stop');
      case 'Paused':
        return this.command([m], 'Pause');
      case 'Playing':
        return this.command([m], 'Unpause');
      default:
        return this.stateUpdate([m], reason);
    }
  }

  done(): Result {
    return { group: this.g, out: this.out };
  }
}

export function livePosition(g: Group, now: number): number {
  if (g.state !== 'Playing') return Math.max(g.positionTicks, 0);
  return Math.max(g.positionTicks + Math.max(now - g.lastActivity, 0) * TICKS_PER_MS, 0);
}

export function info(g: Group, nowMs: number): any {
  return {
    GroupId: dashedGuid(g.id),
    GroupName: g.name,
    State: g.state,
    Participants: g.members.map((m) => m.name),
    LastUpdatedAt: new Date(nowMs).toISOString(),
  };
}

export function nextDeadline(g: Group): number {
  let due = g.presenceCheckAt;
  if (g.state === 'Waiting' && g.waitDeadline !== undefined) due = Math.min(due, g.waitDeadline);
  for (const m of g.members) if (m.awayUntil !== undefined) due = Math.min(due, m.awayUntil);
  return due;
}

const fresh = (m: Member): Member => ({ ...m, ping: DEFAULT_PING, buffering: false, ignoreWait: false, awayUntil: undefined });

export function create(
  id: string,
  name: string,
  home: string,
  member: Member,
  ctx: Ctx,
  playing?: { itemId: string; positionTicks: number; paused: boolean }
): Result {
  const m = fresh(member);
  const g: Group = {
    id,
    name,
    home,
    state: 'Idle',
    wanted: 'Paused',
    positionTicks: 0,
    lastActivity: ctx.now,
    members: [m],
    queue: Q.emptyQueue(ctx.now),
    presenceCheckAt: ctx.now + PRESENCE_MS,
  };
  const t = new Turn(g, ctx);
  t.update([m], 'GroupJoined', info(g, ctx.now));
  if (!playing) {
    t.command([m], 'Stop');
    return t.done();
  }
  Q.setQueue(g.queue, [playing.itemId], 0, ctx, ctx.now);
  g.positionTicks = Math.max(playing.positionTicks, 0);
  t.restartWait(playing.paused ? 'Paused' : 'Playing');
  t.queue([m], 'NewPlaylist');
  return t.done();
}

export function join(group: Group, member: Member, ctx: Ctx): Result {
  const t = new Turn(clone(group), ctx);
  const g = t.g;
  const existing = g.members.find((m) => m.key === member.key);
  if (existing) {
    Object.assign(existing, { ...member, ignoreWait: existing.ignoreWait, buffering: existing.buffering, ping: existing.ping, awayUntil: undefined });
    t.update([existing], 'GroupJoined', info(g, ctx.now));
    t.queue([existing], 'NewPlaylist');
    if (g.state !== 'Waiting') t.stateCommand(existing, 'Ready');
    return t.done();
  }
  const m = fresh(member);
  if (g.state === 'Idle') {
    g.members.push(m);
    t.update([m], 'GroupJoined', info(g, ctx.now));
    t.command([m], 'Stop');
    t.update(t.others(m.key), 'UserJoined', m.name);
    return t.done();
  }
  if (g.state === 'Playing') t.freezePosition();
  const wanted = g.state === 'Playing' ? 'Playing' : g.state === 'Paused' ? 'Paused' : g.wanted;
  t.setState('Waiting');
  g.wanted = wanted;
  g.waitDeadline = ctx.now + WAIT_MS;
  m.buffering = true;
  g.members.push(m);
  t.update([m], 'GroupJoined', info(g, ctx.now));
  t.queue([m], 'NewPlaylist');
  t.update(t.others(m.key), 'UserJoined', m.name);
  t.command(t.readyMembers(), 'Pause');
  return t.done();
}

function leaveIn(t: Turn, key: string): void {
  const m = t.g.members.find((x) => x.key === key);
  if (!m) return;
  t.update([m], 'GroupLeft', dashedGuid(t.g.id));
  t.update(t.others(key), 'UserLeft', m.name);
  t.g.members = t.g.members.filter((x) => x.key !== key);
  if (t.g.members.length) t.checkReady('Ready');
}

export function leave(group: Group, key: string, ctx: Ctx): Result {
  const t = new Turn(clone(group), ctx);
  leaveIn(t, key);
  return { group: t.g.members.length ? t.g : null, out: t.out };
}

export function away(group: Group, key: string, ctx: Ctx): Group {
  const g = clone(group);
  const m = g.members.find((x) => x.key === key);
  if (m) m.awayUntil = ctx.now + ctx.graceMs;
  return g;
}

export function back(group: Group, key: string): Group {
  const g = clone(group);
  const m = g.members.find((x) => x.key === key);
  if (m) delete m.awayUntil;
  return g;
}

export function tick(group: Group, ctx: Ctx, offline: Set<string>): Result {
  const t = new Turn(clone(group), ctx);
  const g = t.g;
  const now = ctx.now;
  if (g.state === 'Waiting' && g.waitDeadline !== undefined && g.waitDeadline <= now) {
    for (const m of g.members) m.buffering = false;
    t.resume('Ready');
  }
  for (const m of [...g.members]) {
    if (m.awayUntil === undefined || m.awayUntil > now) continue;
    if (offline.has(m.key)) leaveIn(t, m.key);
    else delete m.awayUntil;
  }
  if (g.presenceCheckAt <= now) {
    for (const m of g.members) if (offline.has(m.key) && m.awayUntil === undefined) m.awayUntil = now + ctx.graceMs;
    g.presenceCheckAt = now + PRESENCE_MS;
  }
  return { group: g.members.length ? g : null, out: t.out };
}

function ready(t: Turn, m: Member, r: Report): void {
  const g = t.g;
  const now = t.now;
  if (r.playlistItemId !== Q.current(g.queue)?.playlistItemId) {
    t.queue([m], 'SetCurrentItem');
    return;
  }
  const at = Math.abs(r.when - now) > TIME_SYNC_MS ? now : r.when;
  const elapsed = r.isPlaying ? Math.max(now - at, 0) : 0;
  const clientTicks = Math.max(r.ticks, 0) + elapsed * TICKS_PER_MS;
  if (Math.abs(clientTicks - g.positionTicks) > MAX_OFFSET_MS * TICKS_PER_MS) {
    t.command([m], 'Seek');
    return;
  }
  m.buffering = false;
  if (g.members.every((x) => !x.buffering || x.ignoreWait)) t.resume('Ready');
  else if (r.isPlaying) t.command([m], 'Pause');
}

export function handle(group: Group, key: string, request: Request, ctx: Ctx): Result {
  const t = new Turn(clone(group), ctx);
  const g = t.g;
  const m = g.members.find((x) => x.key === key);
  if (!m) return { group, out: [] };
  const now = ctx.now;
  const cur = Q.current(g.queue);

  switch (request.type) {
    case 'Ping':
      m.ping = Math.min(Math.max(Math.floor(Number(request.ms) || 0), 0), MAX_PING);
      return t.done();
    case 'IgnoreWait':
      m.ignoreWait = request.value;
      t.checkReady('IgnoreWait');
      return t.done();
    case 'Queue':
      Q.enqueue(g.queue, request.items, request.mode, ctx, now);
      t.queue(t.all(), request.mode);
      return t.done();
    case 'MovePlaylistItem':
      if (Q.move(g.queue, request.id, request.newIndex, now)) t.queue(t.all(), 'MoveItem');
      return t.done();
    case 'SetRepeatMode':
      Q.setRepeat(g.queue, request.mode, now);
      t.queue(t.all(), 'RepeatMode');
      return t.done();
    case 'SetShuffleMode':
      Q.setShuffle(g.queue, request.mode, ctx, now);
      t.queue(t.all(), 'ShuffleMode');
      return t.done();
    case 'SetNewQueue':
      if (!request.items.length) {
        t.stop('Play');
        return t.done();
      }
      Q.setQueue(g.queue, request.items, request.index, ctx, now);
      g.positionTicks = Math.max(request.startTicks, 0);
      t.restartWait('Playing');
      t.queue(t.all(), 'NewPlaylist');
      t.stateUpdate(t.all(), 'Play');
      return t.done();
    case 'SetPlaylistItem':
      if (!Q.select(g.queue, request.id, now)) {
        t.queue([m], 'SetCurrentItem');
        return t.done();
      }
      t.startItem('SetCurrentItem', 'SetPlaylistItem');
      return t.done();
    case 'NextItem':
    case 'PreviousItem': {
      if (!cur || request.playlistItemId !== cur.playlistItemId) return t.done();
      const moved = request.type === 'NextItem' ? Q.next(g.queue, now) : Q.previous(g.queue, now);
      if (moved) t.startItem(request.type, request.type);
      else if (request.type === 'NextItem') t.stop('Stop');
      return t.done();
    }
    case 'RemoveFromPlaylist': {
      const { removedCurrent } = Q.remove(g.queue, request.ids, request.clearPlaylist, request.clearPlayingItem, now);
      if (!Q.active(g.queue).length) {
        t.queue(t.all(), 'RemoveItems');
        t.stop('Stop');
      } else if (removedCurrent && g.state !== 'Idle') {
        g.positionTicks = 0;
        t.restartWait('Playing');
        t.queue(t.all(), 'RemoveItems');
        t.stateUpdate(t.all(), 'RemoveFromPlaylist');
      } else {
        t.queue(t.all(), 'RemoveItems');
      }
      return t.done();
    }
    case 'Stop':
      t.stop('Stop');
      return t.done();
  }

  switch (g.state) {
    case 'Idle':
      // NewPlaylist, as a client with no player running ignores SetCurrentItem.
      if (request.type === 'Unpause' && cur) t.startItem('NewPlaylist', 'Unpause');
      else t.command([m], 'Stop');
      return t.done();

    case 'Playing':
      if (request.type === 'Pause') {
        t.freezePosition();
        t.setState('Paused');
        t.command(t.all(), 'Pause');
        t.stateUpdate(t.all(), 'Pause');
      } else if (request.type === 'Seek') {
        g.positionTicks = Math.max(request.ticks, 0);
        t.restartWait('Playing');
        t.command(t.all(), 'Seek');
        t.stateUpdate(t.all(), 'Seek');
      } else if (request.type === 'Buffer') {
        t.freezePosition();
        m.buffering = true;
        t.enterWaiting('Playing');
        t.command(t.readyMembers(), 'Pause');
        t.stateUpdate(t.all(), 'Buffer');
      } else {
        t.command([m], 'Unpause');
      }
      return t.done();

    case 'Paused':
      if (request.type === 'Unpause') {
        g.lastActivity = now + t.delay();
        t.setState('Playing');
        t.command(t.all(), 'Unpause');
        t.stateUpdate(t.all(), 'Unpause');
      } else if (request.type === 'Seek') {
        g.positionTicks = Math.max(request.ticks, 0);
        t.restartWait('Paused');
        t.command(t.all(), 'Seek');
        t.stateUpdate(t.all(), 'Seek');
      } else if (request.type === 'Buffer') {
        m.buffering = true;
        t.enterWaiting('Paused');
        t.command([m], 'Pause');
        t.stateUpdate(t.all(), 'Buffer');
      } else {
        t.command([m], 'Pause');
      }
      return t.done();

    case 'Waiting':
      if (request.type === 'Pause') {
        g.wanted = 'Paused';
        t.command(t.all(), 'Pause');
        t.stateUpdate(t.all(), 'Pause');
      } else if (request.type === 'Unpause') {
        if (g.wanted === 'Playing') {
          for (const x of g.members) x.buffering = false;
          t.resume('Unpause');
        } else {
          g.wanted = 'Playing';
          t.stateUpdate(t.all(), 'Unpause');
        }
      } else if (request.type === 'Seek') {
        g.positionTicks = Math.max(request.ticks, 0);
        t.restartWait(g.wanted);
        t.command(t.all(), 'Seek');
        t.stateUpdate(t.all(), 'Seek');
      } else if (request.type === 'Buffer') {
        m.buffering = true;
        t.command([m], 'Pause');
      } else if (request.type === 'Ready') {
        ready(t, m, request);
      }
      return t.done();
  }
  return t.done();
}
