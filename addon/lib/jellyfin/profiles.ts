import { createHash } from 'crypto';
import { allowsUnrated, hasAgeRatingCap, passesAgeRating, resolveInstallFilters } from '../../utils/ageRating';
import { normaliseJellyfinId } from './idsCodec';

/** The main user is the configuration itself, under the id it always had. */
export interface Profile {
  /** Null for the main user. */
  id: string | null;
  name: string;
  userId: string;
  /** An image address, or null when none is set. */
  avatar: string | null;
  /** Profile tags this user is made of; none means every catalog. */
  tags: string[];
  /** Whether this user is the same person as the account: its history and trackers. */
  sharesHistory: boolean;
}

export function defaultUserName(config: any, userUUID: string): string {
  return config?.jellyfinUserName || config?.addonName || userUUID.slice(0, 8);
}

const IMAGE_URL = /^https?:\/\//i;

function avatarOf(value: unknown): string | null {
  return typeof value === 'string' && IMAGE_URL.test(value.trim()) ? value.trim() : null;
}

/** Changes whenever the picture would, so a client drops its cached copy. */
export function avatarTag(profile: Profile): string | undefined {
  return profile.avatar ? createHash('md5').update(profile.avatar).digest('hex').slice(0, 16) : undefined;
}

export function profileUserId(userUUID: string, id: string | null): string {
  const serverId = normaliseJellyfinId(userUUID);
  if (!id) return serverId;
  return createHash('md5').update(`${serverId}|user|${id}`).digest('hex');
}

/** Only tags the configuration still has; a renamed or deleted one drops out. */
function knownTags(config: any, wanted: unknown): string[] {
  const registry = new Map<string, string>();
  for (const tag of Array.isArray(config?.tags) ? config.tags : []) {
    if (typeof tag?.name === 'string' && tag.name.trim()) registry.set(tag.name.trim().toLowerCase(), tag.name.trim());
  }
  const out: string[] = [];
  for (const raw of Array.isArray(wanted) ? wanted : []) {
    const stored = typeof raw === 'string' ? registry.get(raw.trim().toLowerCase()) : undefined;
    if (stored && !out.includes(stored)) out.push(stored);
  }
  return out;
}

export function listProfiles(config: any, userUUID: string): Profile[] {
  const profiles: Profile[] = [{
    id: null,
    name: defaultUserName(config, userUUID),
    userId: profileUserId(userUUID, null),
    avatar: avatarOf(config?.jellyfinUserAvatar),
    tags: [],
    sharesHistory: true,
  }];
  const seen = new Set<string>();

  for (const user of Array.isArray(config?.jellyfinUsers) ? config.jellyfinUsers : []) {
    const id = typeof user?.id === 'string' ? user.id.trim() : '';
    const name = typeof user?.name === 'string' ? user.name.trim() : '';
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    profiles.push({
      id,
      name,
      userId: profileUserId(userUUID, id),
      avatar: avatarOf(user.avatar),
      tags: knownTags(config, user.tags),
      sharesHistory: user.trackers === true,
    });
  }

  return profiles;
}

/** A sign-in name that is not a user falls back to the main user. */
export function profileByName(config: any, userUUID: string, username: unknown): Profile {
  const wanted = String(username ?? '').trim().toLowerCase();
  const profiles = listProfiles(config, userUUID);
  return profiles.find((p) => p.id && p.name.toLowerCase() === wanted) ?? profiles[0];
}

export function profileById(config: any, userUUID: string, id: string | null | undefined): Profile {
  const profiles = listProfiles(config, userUUID);
  if (!id) return profiles[0];
  return profiles.find((p) => p.id === id) ?? profiles[0];
}

export function profileByUserId(config: any, userUUID: string, userId: unknown): Profile | null {
  const wanted = normaliseJellyfinId(String(userId ?? ''));
  return listProfiles(config, userUUID).find((p) => p.userId === wanted) ?? null;
}

/** The same catalogs and cap an install URL naming this user's tags would get. */
export function scopeConfigToProfile(config: any, userUUID: string, id: string | null): any {
  if (!id) return config;

  const profile = profileById(config, userUUID, id);
  if (!profile.id) return config;

  const scoped = { ...config, jellyfinProfileId: profile.id, jellyfinProfileTags: profile.tags, jellyfinProfileShares: profile.sharesHistory };
  if (profile.tags.length) {
    const { ageRating, allowUnrated } = resolveInstallFilters(config, { tags: profile.tags });
    if (ageRating) scoped.ageRating = ageRating;
    if (allowUnrated === false) scoped.allowUnratedContent = false;
  }
  return scoped;
}

/** The tags a scoped configuration lists catalogs for; none means all of them. */
export function profileTags(config: any): string[] {
  return Array.isArray(config?.jellyfinProfileTags) ? config.jellyfinProfileTags : [];
}

/** The account's state is under the empty key; a separate viewer has its own and no trackers. */
export function profileKey(config: any): string {
  if (config?.jellyfinProfileShares === true) return '';
  return typeof config?.jellyfinProfileId === 'string' ? config.jellyfinProfileId : '';
}

export function readsTrackers(config: any): boolean {
  return !profileKey(config);
}

/** Items built from tracker rows never went through the catalog route's cap. */
export function keepsUnderProfileCap(config: any): (item: any) => boolean {
  if (!hasAgeRatingCap(config)) return () => true;

  const cap = String(config.ageRating);
  const unrated = allowsUnrated(config);
  return (item: any) => {
    const type = item?.Type === 'Movie' ? 'movie' : 'series';
    return passesAgeRating(item?.OfficialRating, type, cap, unrated);
  };
}
