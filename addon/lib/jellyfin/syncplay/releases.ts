import { normaliseJellyfinId } from '../idsCodec';
import { recallRelease, recallReleases, rememberRelease } from '../streams';
import * as Q from './queue';
import { syncPlayEnabled } from './settings';
import type { Group, Member } from './engine';
import type { GroupStore } from './store';

export interface ReleaseDeps {
  store: GroupStore;
}

type Who = Pick<Member, 'key' | 'userUUID' | 'profile'>;

/** Where the source renamed to the item's own id records its release, per member. */
export const defaultSourceKey = (itemId: string, userUUID: string, profile: string): string =>
  `${normaliseJellyfinId(itemId)}:${userUUID}:${profile}`;

const currentEntry = (g: Group | null, itemId: string) => {
  const cur = g ? Q.current(g.queue) : null;
  return cur && cur.itemId === itemId ? cur : null;
};

async function groupFor(deps: ReleaseDeps, who: Who): Promise<Group | null> {
  const id = await deps.store.groupOf(who.key);
  return id ? deps.store.get(id) : null;
}

export async function noteGroupPlaying(deps: ReleaseDeps, who: Who, itemId: string, mediaSourceId: string): Promise<void> {
  const item = normaliseJellyfinId(itemId);
  const source = normaliseJellyfinId(mediaSourceId);
  if (!item || !source || !syncPlayEnabled()) return;
  const g = await groupFor(deps, who);
  const cur = currentEntry(g, item);
  if (!g || !cur || g.release?.playlistItemId === cur.playlistItemId) return;
  const identity = await recallRelease(source === item ? defaultSourceKey(item, who.userUUID, who.profile) : source);
  if (identity) await setRelease(deps, g.id, item, identity);
}

/** Only while the current entry has none: the first member to open or play it decides. Returns what is stored. */
async function setRelease(deps: ReleaseDeps, groupId: string, itemId: string, identity: string): Promise<string | null> {
  let stored: string | null = null;
  await deps.store.update(groupId, (fresh) => {
    const entry = currentEntry(fresh, itemId);
    if (!fresh || !entry) return { group: fresh, out: [] };
    if (fresh.release?.playlistItemId !== entry.playlistItemId) fresh.release = { playlistItemId: entry.playlistItemId, identity };
    stored = fresh.release!.identity;
    return { group: fresh, out: [] };
  });
  return stored;
}

const toFront = (sources: any[], index: number): any[] =>
  index <= 0 ? sources : [sources[index], ...sources.slice(0, index), ...sources.slice(index + 1)];

const identitiesOf = (sources: any[]) => recallReleases(sources.map((s) => normaliseJellyfinId(String(s?.Id ?? ''))));

/** The source PlaybackInfo gave the item's own id, so a later request naming the item gets the same file. */
export async function recordedDefaultFirst(itemId: string, userUUID: string, profile: string, sources: any[]): Promise<any[]> {
  if (sources.length < 2 || !syncPlayEnabled()) return sources;
  const recorded = await recallRelease(defaultSourceKey(itemId, userUUID, profile));
  if (!recorded) return sources;
  return toFront(sources, (await identitiesOf(sources)).indexOf(recorded));
}

/** The source given the item's own id, which is what a play report naming the item means. */
export async function noteDefaultSource(itemId: string, userUUID: string, profile: string, sourceId: string): Promise<void> {
  if (!syncPlayEnabled()) return;
  const identity = await recallRelease(normaliseJellyfinId(sourceId));
  if (identity) rememberRelease(defaultSourceKey(itemId, userUUID, profile), identity);
}

/** `eligible`: whether a source can become the default one the client plays. */
export async function preferGroupRelease(
  deps: ReleaseDeps,
  who: Who | null,
  config: any,
  itemId: string,
  sources: any[],
  eligible: (source: any) => boolean = () => true
): Promise<any[]> {
  if (!who || config?.jellyfinMatchReleases === false || !sources.length || !syncPlayEnabled()) return sources;
  const item = normaliseJellyfinId(itemId);
  const g = await groupFor(deps, who);
  const cur = currentEntry(g, item);
  if (!g || !cur) return sources;
  const identities = (await identitiesOf(sources)).map((identity, i) => (eligible(sources[i]) ? identity : null));
  let wanted = g.release?.playlistItemId === cur.playlistItemId ? g.release.identity : null;
  if (!wanted) {
    const first = identities.find(Boolean);
    // Another member may have stored a different one since the group was read.
    if (first) wanted = await setRelease(deps, g.id, item, first);
  }
  return wanted ? toFront(sources, identities.indexOf(wanted)) : sources;
}
