import { createHash } from 'crypto';
import { allowsUnrated, hasAgeRatingCap, passesAgeRating, resolveInstallFilters } from '../../utils/ageRating';
import { normaliseJellyfinId } from './idsCodec';
import { ACCOUNT_SERVICES, ACCOUNT_SERVICE_LIST, AccountService, accountOwner, credentialOf, trackerConfig, withAccountOwner } from '../accounts';

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
  handoffNames: string[];
  /** Whether this user is the same person as the account: its history and trackers. */
  sharesHistory: boolean;
  /** Undefined follows the main user. */
  trackerSource?: string;
  skipSource?: string;
  watchlistServices?: string[];
  /** Overrides the configuration's stream addon for this user. */
  streamUrl?: string;
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

function namesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name && !out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

export function listProfiles(config: any, userUUID: string): Profile[] {
  const profiles: Profile[] = [{
    id: null,
    name: defaultUserName(config, userUUID),
    userId: profileUserId(userUUID, null),
    avatar: avatarOf(config?.jellyfinUserAvatar),
    tags: knownTags(config, config?.jellyfinUserTags),
    handoffNames: namesOf(config?.jellyfinUserHandoffNames),
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
      handoffNames: namesOf(user.handoffNames),
      sharesHistory: user.trackers === true,
      trackerSource: typeof user.trackerSource === 'string' ? user.trackerSource : undefined,
      skipSource: typeof user.skipSource === 'string' ? user.skipSource : undefined,
      watchlistServices: Array.isArray(user.watchlistServices) ? user.watchlistServices.map(String) : undefined,
      streamUrl: typeof user.streamUrl === 'string' && user.streamUrl.trim() ? user.streamUrl.trim() : undefined,
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

/** A service is held only while it is connected and its own master switch is on. */
function isHeld(held: any, service: AccountService): boolean {
  if (!ACCOUNT_SERVICE_LIST.includes(service)) return false;
  if (!credentialOf(held, service)) return false;
  return trackerConfig(held, service)?.[ACCOUNT_SERVICES[service].master] !== false;
}

/** A PublicMetaDB watchlist pick also needs a chosen list; nothing else does. */
function isHeldForWatchlist(held: any, service: AccountService): boolean {
  if (!isHeld(held, service)) return false;
  return service !== 'publicmetadb' || Boolean(held.jellyfinAccounts?.publicmetadbWatchlist);
}

/** A holder's tracker pick, falling back to 'auto' once it names a service the holder doesn't hold. */
function heldTrackerSource(held: any, trackerSource: string): string {
  if (trackerSource === 'auto' || trackerSource === 'off') return trackerSource;
  return isHeld(held, trackerSource as AccountService) ? trackerSource : 'auto';
}

/** A holder's watchlist picks, dropping any whose service it doesn't hold; undefined once none are left. */
function heldWatchlistServices(held: any, watchlistServices: string[]): string[] | undefined {
  if (watchlistServices.includes('none')) return watchlistServices;
  const kept = watchlistServices.filter((token) => isHeldForWatchlist(held, token.split(':')[0] as AccountService));
  return kept.length ? kept : undefined;
}

/** The same catalogs and cap an install URL naming this user's tags would get. */
export function scopeConfigToProfile(config: any, userUUID: string, id: string | null): any {
  const profile = profileById(config, userUUID, id);
  if (!profile.id && !profile.tags.length) return config;

  const held = profile.id ? withAccountOwner(config, profile.id) : config;
  const owns = held !== config;
  // The main user keeps its own history and trackers whatever tags it picks.
  const scoped = profile.id
    ? {
        ...held,
        jellyfinProfileId: profile.id,
        jellyfinProfileTags: profile.tags,
        jellyfinProfileShares: profile.sharesHistory,
        ...(profile.trackerSource
          ? { jellyfinResumeSource: owns ? heldTrackerSource(held, profile.trackerSource) : profile.trackerSource }
          : owns ? { jellyfinResumeSource: 'auto' } : {}),
        ...(profile.skipSource ? { jellyfinSkipSource: profile.skipSource } : {}),
        ...(profile.watchlistServices
          ? { jellyfinWatchlistServices: owns ? heldWatchlistServices(held, profile.watchlistServices) : profile.watchlistServices }
          : owns ? { jellyfinWatchlistServices: undefined } : {}),
        ...(profile.streamUrl ? { jellyfinStreamUrl: profile.streamUrl } : {}),
      }
    : { ...config, jellyfinProfileTags: profile.tags };
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

export function writesTrackers(config: any): boolean {
  return !profileKey(config) || Boolean(accountOwner(config));
}

export function readsTrackers(config: any): boolean {
  return (config?.jellyfinResumeSource ?? 'auto') !== 'off';
}

/** Internal filter value: object spreads retain it, JSON responses omit it. */
export const FILTER_CERTIFICATION = Symbol('filterCertification');

/** Items built from tracker rows never went through the catalog route's cap. */
export function keepsUnderProfileCap(config: any): (item: any) => boolean {
  if (!hasAgeRatingCap(config)) return () => true;

  const cap = String(config.ageRating);
  const unrated = allowsUnrated(config);
  return (item: any) => {
    const type = item?.Type === 'Movie' ? 'movie' : 'series';
    const certification = item && Object.prototype.hasOwnProperty.call(item, FILTER_CERTIFICATION)
      ? item[FILTER_CERTIFICATION] : item?.OfficialRating;
    return passesAgeRating(certification, type, cap, unrated);
  };
}

/** A handoff names its viewer the way the sign-in screen does, or by a name set for AIOStreams. */
function personaIdOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'user';
}

export function viewerByName(config: any, userUUID: string, name: unknown): Profile | undefined {
  const wanted = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (!wanted) return undefined;
  const matches = (candidate: string) => candidate.trim().toLowerCase() === wanted || personaIdOf(candidate) === wanted;
  return listProfiles(config, userUUID).find((p) => matches(p.name) || p.handoffNames.some(matches));
}

export function hasNamedViewers(config: any, userUUID: string): boolean {
  const [main, ...others] = listProfiles(config, userUUID);
  return others.length > 0 || main.handoffNames.length > 0;
}

/** The config a handoff request acts as; undefined when it names nobody here while others could be named. */
export function configForViewer(config: any, userUUID: string, name: unknown): any | undefined {
  if (name === undefined || name === null || (typeof name === 'string' && !name.trim())) return config;
  if (!hasNamedViewers(config, userUUID)) return config;
  if (typeof name !== 'string') return undefined;
  const profile = viewerByName(config, userUUID, name);
  if (!profile) return undefined;
  return profile.id ? scopeConfigToProfile(config, userUUID, profile.id) : config;
}
