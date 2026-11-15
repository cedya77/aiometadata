import { dashedGuid } from '../idsCodec';

export type RepeatMode = 'RepeatNone' | 'RepeatOne' | 'RepeatAll';
export type ShuffleMode = 'Sorted' | 'Shuffle';
export type QueueReason =
  | 'NewPlaylist'
  | 'SetCurrentItem'
  | 'RemoveItems'
  | 'MoveItem'
  | 'Queue'
  | 'QueueNext'
  | 'NextItem'
  | 'PreviousItem'
  | 'RepeatMode'
  | 'ShuffleMode';

export interface Entry {
  itemId: string;
  playlistItemId: string;
}

export interface Queue {
  sorted: Entry[];
  shuffled: Entry[];
  playing: number;
  repeat: RepeatMode;
  shuffle: ShuffleMode;
  lastUpdate: number;
}

export interface Rand {
  random(): number;
  newId(): string;
}

export const MAX_QUEUE = 500;

export function emptyQueue(now: number): Queue {
  return { sorted: [], shuffled: [], playing: -1, repeat: 'RepeatNone', shuffle: 'Sorted', lastUpdate: now };
}

export function active(q: Queue): Entry[] {
  return q.shuffle === 'Shuffle' ? q.shuffled : q.sorted;
}

export function current(q: Queue): Entry | null {
  return active(q)[q.playing] ?? null;
}

// By id, not identity: a saved queue's two lists hold separate copies of each entry.
const indexOf = (list: Entry[], entry: Entry | null): number =>
  entry ? list.findIndex((e) => e.playlistItemId === entry.playlistItemId) : -1;

const entries = (itemIds: string[], room: number, rand: Rand): Entry[] =>
  itemIds.slice(0, Math.max(room, 0)).map((itemId) => ({ itemId, playlistItemId: rand.newId() }));

function shuffled(list: Entry[], rand: Rand): Entry[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function setQueue(q: Queue, itemIds: string[], playingIndex: number, rand: Rand, now: number): void {
  q.sorted = entries(itemIds, MAX_QUEUE, rand);
  q.shuffled = [];
  q.shuffle = 'Sorted';
  q.repeat = 'RepeatNone';
  q.playing = q.sorted.length ? Math.min(Math.max(Math.floor(playingIndex) || 0, 0), q.sorted.length - 1) : -1;
  q.lastUpdate = now;
}

export function enqueue(q: Queue, itemIds: string[], mode: 'Queue' | 'QueueNext', rand: Rand, now: number): void {
  const added = entries(itemIds, MAX_QUEUE - q.sorted.length, rand);
  if (!added.length) return;
  const list = active(q);
  const other = q.shuffle === 'Shuffle' ? q.sorted : null;
  if (mode === 'QueueNext' && q.playing >= 0) list.splice(q.playing + 1, 0, ...added);
  else list.push(...added);
  other?.push(...added);
  if (q.playing < 0) q.playing = 0;
  q.lastUpdate = now;
}

export function select(q: Queue, playlistItemId: string, now: number): boolean {
  const index = active(q).findIndex((e) => e.playlistItemId === playlistItemId);
  if (index < 0) return false;
  q.playing = index;
  q.lastUpdate = now;
  return true;
}

export function remove(q: Queue, playlistItemIds: string[], clearPlaylist: boolean, clearPlayingItem: boolean, now: number): { removedCurrent: boolean } {
  const playing = current(q);
  const gone = new Set(playlistItemIds);
  if (clearPlaylist) for (const e of q.sorted) if (e.playlistItemId !== playing?.playlistItemId || clearPlayingItem) gone.add(e.playlistItemId);
  const before = playing ? active(q).slice(0, q.playing).filter((e) => gone.has(e.playlistItemId)).length : 0;
  q.sorted = q.sorted.filter((e) => !gone.has(e.playlistItemId));
  q.shuffled = q.shuffled.filter((e) => !gone.has(e.playlistItemId));
  q.lastUpdate = now;
  const list = active(q);
  if (!playing) {
    q.playing = list.length ? Math.min(Math.max(q.playing, 0), list.length - 1) : -1;
    return { removedCurrent: false };
  }
  if (gone.has(playing.playlistItemId)) {
    const previous = q.playing - before - 1;
    q.playing = previous >= 0 ? previous : list.length ? 0 : -1;
    return { removedCurrent: true };
  }
  q.playing = indexOf(list, playing);
  return { removedCurrent: false };
}

export function move(q: Queue, playlistItemId: string, newIndex: number, now: number): boolean {
  const list = active(q);
  const from = list.findIndex((e) => e.playlistItemId === playlistItemId);
  if (from < 0) return false;
  const playing = current(q);
  const [entry] = list.splice(from, 1);
  list.splice(Math.min(Math.max(Math.floor(newIndex) || 0, 0), list.length), 0, entry);
  if (playing) q.playing = indexOf(list, playing);
  q.lastUpdate = now;
  return true;
}

function step(q: Queue, by: 1 | -1, now: number): boolean {
  const list = active(q);
  if (!list.length) return false;
  if (q.repeat === 'RepeatOne') {
    q.lastUpdate = now;
    return true;
  }
  let index = q.playing + by;
  if (index < 0 || index >= list.length) {
    if (q.repeat !== 'RepeatAll') return false;
    index = (index + list.length) % list.length;
  }
  q.playing = index;
  q.lastUpdate = now;
  return true;
}

export const next = (q: Queue, now: number): boolean => step(q, 1, now);
export const previous = (q: Queue, now: number): boolean => step(q, -1, now);

export function setRepeat(q: Queue, mode: RepeatMode, now: number): void {
  q.repeat = mode;
  q.lastUpdate = now;
}

export function setShuffle(q: Queue, mode: ShuffleMode, rand: Rand, now: number): void {
  const playing = current(q);
  const own = playing ? q.sorted[indexOf(q.sorted, playing)] ?? null : null;
  if (mode === 'Shuffle') {
    const rest = shuffled(q.sorted.filter((e) => e !== own), rand);
    q.shuffled = own ? [own, ...rest] : rest;
    q.shuffle = 'Shuffle';
    q.playing = own ? 0 : -1;
  } else {
    q.shuffled = [];
    q.shuffle = 'Sorted';
    q.playing = indexOf(q.sorted, playing);
  }
  q.lastUpdate = now;
}

export function snapshot(q: Queue, reason: QueueReason, positionTicks: number, isPlaying: boolean): any {
  return {
    Reason: reason,
    LastUpdate: new Date(q.lastUpdate).toISOString(),
    Playlist: active(q).map((e) => ({ ItemId: dashedGuid(e.itemId), PlaylistItemId: dashedGuid(e.playlistItemId) })),
    PlayingItemIndex: q.playing,
    StartPositionTicks: positionTicks,
    IsPlaying: isPlaying,
    ShuffleMode: q.shuffle,
    RepeatMode: q.repeat,
  };
}
