// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { Capable } from './trackerSource';
import type { Viewing } from './trackerDrift';
import type { CopyItem, WatchOutcome } from '../trackers/watches';

/** The copy destination that is the history on this server rather than a tracker. */
export const HERE = 'here';

/** A watch to bring in, with the profiles here that don't have it yet. */
export interface HomeItem extends CopyItem {
  profiles: string[];
}

interface HomeSource {
  service: Capable;
  credential: string;
  key: string;
  keys: Set<string>;
  scoped: any;
}

// Each profile is checked on its own, so a watch one of them already has still comes in for the other.
export async function planHome(userUUID: string, from: HomeSource, since: number): Promise<HomeItem[]> {
  const { pendingWatches } = require('../trackerOutbox');
  const { aheadOf } = require('./trackerDrift');
  const unmarking = new Set<string>((await pendingWatches(from.service, from.credential).catch(() => [])).filter((p: any) => !p.played).map((p: any) => String(p.videoId)));
  const byWatch = new Map<string, HomeItem>();
  for (const profile of from.keys) {
    const source = { service: from.service, credential: from.credential, keys: new Set([profile]), scoped: from.scoped };
    for (const v of (await aheadOf(userUUID, source, from.key, since, unmarking, true)) as Viewing[]) {
      const key = `${v.metaId}|${v.season ?? ''}|${v.episode ?? ''}|${v.at}`;
      const held = byWatch.get(key);
      if (held) held.profiles.push(profile);
      else byWatch.set(key, { ids: v.ids, kind: v.kind, metaId: v.metaId, season: v.season, episode: v.episode, at: v.at > 0 ? v.at : null, profiles: [profile] });
    }
  }
  // In date order, so a batch keeps a bulk mark together and the pull can tell it from viewings.
  return [...byWatch.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

export async function writeHome(userUUID: string, from: Omit<HomeSource, 'key' | 'keys'>, items: HomeItem[]): Promise<WatchOutcome> {
  const { pullDrift } = require('./trackerDrift');
  const byProfiles = new Map<string, HomeItem[]>();
  for (const item of items) {
    const key = [...item.profiles].sort().join('\n');
    byProfiles.set(key, [...(byProfiles.get(key) ?? []), item]);
  }
  for (const [key, group] of byProfiles) {
    const source = { service: from.service, credential: from.credential, keys: new Set(key.split('\n')), scoped: from.scoped };
    await pullDrift(userUUID, source, group.map((item) => ({ profile: '', at: item.at ?? 0, ids: item.ids, kind: item.kind, metaId: item.metaId, season: item.season, episode: item.episode })));
  }
  require('./dashboard').forgetPulled(userUUID);
  return { done: items.length, sent: items.length, failed: 0 };
}
