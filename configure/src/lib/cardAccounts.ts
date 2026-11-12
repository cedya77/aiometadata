import type { AppConfig, CardService, CatalogConfig, JellyfinUser, JellyfinUserAccounts } from '@/contexts/config';
import { WATCH_TRACKING_SERVICE_DEFINITIONS, WATCH_TRACKING_SERVICES } from './watchTracking';

type Shelf = 'movies' | 'series' | 'anime';
type KeyField = keyof NonNullable<JellyfinUserAccounts['apiKeys']>;
type MasterField = 'simklWatchTracking' | 'mdblistWatchTracking' | 'publicmetadbWatchTracking' | 'anilistWatchTracking' | 'malWatchTracking';

interface CardServiceInfo {
  label: string;
  key: KeyField;
  master: MasterField;
  shelves: Shelf[];
  resume: boolean;
  icon: string;
  disconnectPath?: string;
}

export const CARD_SERVICE_ORDER: CardService[] = ['simkl', 'mdblist', 'publicmetadb', 'anilist', 'mal'];

export const CARD_SERVICES: Record<CardService, CardServiceInfo> = {
  simkl: { label: 'Simkl', key: 'simklTokenId', master: 'simklWatchTracking', shelves: ['movies', 'series', 'anime'], resume: true, icon: 'https://us.simkl.in/img_favicon/v2/favicon-192x192.png', disconnectPath: '/api/auth/simkl/disconnect' },
  mdblist: { label: 'MDBList', key: 'mdblist', master: 'mdblistWatchTracking', shelves: ['movies', 'series'], resume: true, icon: '/mdblist_icon.png' },
  publicmetadb: { label: 'PublicMetaDB', key: 'publicmetadb', master: 'publicmetadbWatchTracking', shelves: ['movies', 'series'], resume: true, icon: '/pmdb_icon.svg' },
  anilist: { label: 'AniList', key: 'anilistTokenId', master: 'anilistWatchTracking', shelves: ['anime'], resume: false, icon: '/anilist_icon.png', disconnectPath: '/anilist/disconnect' },
  mal: { label: 'MyAnimeList', key: 'malTokenId', master: 'malWatchTracking', shelves: ['anime'], resume: false, icon: '/mal_icon.png', disconnectPath: '/mal/disconnect' },
};

export function connectedServices(user?: JellyfinUser): CardService[] {
  if (!user || user.trackers === true) return [];
  return CARD_SERVICE_ORDER.filter((service) => Boolean(user.accounts?.apiKeys?.[CARD_SERVICES[service].key]));
}

export function mainConnectedServices(config: AppConfig): CardService[] {
  return WATCH_TRACKING_SERVICES.filter((service) => {
    const definition = WATCH_TRACKING_SERVICE_DEFINITIONS[service];
    return definition.hasCredential(config) && config[definition.masterKey] === true;
  });
}

export function mainPersonName(config: { jellyfinUserName?: string; addonName?: string }, userUUID: string): string {
  return config.jellyfinUserName || config.addonName || userUUID.slice(0, 8) || 'You';
}

export function newPersonId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function personNameTaken(config: AppConfig, userUUID: string, name: string): boolean {
  const wanted = name.trim().toLowerCase();
  return mainPersonName(config, userUUID).toLowerCase() === wanted
    || (config.jellyfinUsers ?? []).some((user) => user.name.toLowerCase() === wanted);
}

export interface HouseholdPerson {
  key: string;
  name: string;
  avatar?: string;
  main: boolean;
  user?: JellyfinUser;
}

/** The main person first, then everyone added, as the sign-in screen lists them. */
export function householdPeople(config: AppConfig, userUUID: string): HouseholdPerson[] {
  return [
    { key: 'main', name: mainPersonName(config, userUUID), avatar: config.jellyfinUserAvatar, main: true },
    ...(config.jellyfinUsers ?? []).map((user) => ({ key: user.id, name: user.name || 'Unnamed person', avatar: user.avatar, main: false, user })),
  ];
}

export function isHolder(user?: JellyfinUser): boolean {
  return connectedServices(user).length > 0;
}

export function cardAccount(user: JellyfinUser | undefined, service: CardService) {
  const info = CARD_SERVICES[service];
  const accounts = user?.trackers === true ? undefined : user?.accounts;
  const media = accounts?.watchTracking?.[service];
  return {
    connected: Boolean(accounts?.apiKeys?.[info.key]),
    label: accounts?.labels?.[service],
    enabled: accounts?.[info.master] === true,
    movie: media?.movie !== false,
    series: media?.series !== false,
  };
}

function copyAccounts(user: JellyfinUser): JellyfinUserAccounts & Required<Pick<JellyfinUserAccounts, 'apiKeys' | 'watchTracking' | 'labels'>> {
  return {
    ...(user.accounts ?? {}),
    apiKeys: { ...(user.accounts?.apiKeys ?? {}) },
    watchTracking: { ...(user.accounts?.watchTracking ?? {}) },
    labels: { ...(user.accounts?.labels ?? {}) },
  };
}

export function withAccount(user: JellyfinUser, service: CardService, value: string | undefined, extra: { label?: string; publicmetadbWatchlist?: string } = {}): JellyfinUser {
  const info = CARD_SERVICES[service];
  const accounts = copyAccounts(user);
  if (value) {
    accounts.apiKeys[info.key] = value;
    accounts[info.master] = true;
    if (extra.label) accounts.labels[service] = extra.label;
    if (service === 'publicmetadb') accounts.publicmetadbWatchlist = extra.publicmetadbWatchlist;
  } else {
    delete accounts.apiKeys[info.key];
    delete accounts[info.master];
    delete accounts.watchTracking[service];
    delete accounts.labels[service];
    if (service === 'publicmetadb') delete accounts.publicmetadbWatchlist;
  }
  return { ...user, accounts };
}

export function withTracking(user: JellyfinUser, service: CardService, patch: { enabled?: boolean; movie?: boolean; series?: boolean }): JellyfinUser {
  const accounts = copyAccounts(user);
  if (patch.enabled !== undefined) accounts[CARD_SERVICES[service].master] = patch.enabled;
  if (patch.movie !== undefined || patch.series !== undefined) {
    accounts.watchTracking[service] = {
      ...(accounts.watchTracking[service] ?? {}),
      ...(patch.movie !== undefined ? { movie: patch.movie } : {}),
      ...(patch.series !== undefined ? { series: patch.series } : {}),
    };
  }
  return { ...user, accounts };
}

function reads(user: JellyfinUser, service: CardService): boolean {
  return user.trackers !== true && cardAccount(user, service).connected && user.accounts?.[CARD_SERVICES[service].master] !== false;
}

export function trackerOptionsFor(user: JellyfinUser): Array<{ value: string; label: string }> {
  return (['mdblist', 'simkl', 'publicmetadb'] as CardService[])
    .filter((service) => reads(user, service))
    .map((service) => ({ value: service, label: CARD_SERVICES[service].label }));
}

export function watchlistOptionsFor(user: JellyfinUser): Array<{ value: string; label: string; shelves: Shelf[] }> {
  return (['mdblist', 'simkl', 'publicmetadb', 'anilist', 'mal'] as CardService[])
    .filter((service) => reads(user, service) && (service !== 'publicmetadb' || Boolean(user.accounts?.publicmetadbWatchlist)))
    .map((service) => ({ value: service, label: CARD_SERVICES[service].label, shelves: CARD_SERVICES[service].shelves }));
}

const WATCHLIST_SLOTS: Partial<Record<CardService, CatalogConfig[]>> = {
  mdblist: [{
    id: 'mdblist.watchlist', type: 'all', name: 'Watchlist', enabled: true, showInHome: true, source: 'mdblist',
    sourceUrl: 'https://api.mdblist.com/watchlist/items?unified=true', enableRatingPosters: true, metadata: { accountsOnly: true },
  } as CatalogConfig],
  simkl: (['movies', 'shows', 'anime'] as const).map((type) => ({
    id: `simkl.watchlist.${type}.plantowatch`,
    type: type === 'movies' ? 'movie' : type === 'anime' ? 'anime' : 'series',
    name: `Simkl Plan to Watch ${type.charAt(0).toUpperCase()}${type.slice(1)}`,
    enabled: true, showInHome: true, source: 'simkl', metadata: { status: 'plantowatch', accountsOnly: true },
  } as CatalogConfig)),
  anilist: [{ id: 'anilist.Planning', type: 'anime', name: 'Planning', enabled: true, showInHome: true, source: 'anilist', metadata: { listName: 'Planning', accountsOnly: true } } as CatalogConfig],
  mal: [{ id: 'mal.userlist.plan_to_watch', type: 'anime', name: 'MyAnimeList Plan to Watch', enabled: true, showInHome: true, source: 'mal', metadata: { accountsOnly: true } } as CatalogConfig],
};

export function missingWatchlistSlots(catalogs: Array<Pick<CatalogConfig, 'id'>>, service: CardService, overrides?: { movie?: string; series?: string }): CatalogConfig[] {
  const held = (id: string) => catalogs.some((c) => c.id === id || (id === 'mdblist.watchlist' && c.id.startsWith('mdblist.watchlist')));
  return (WATCHLIST_SLOTS[service] ?? []).filter((slot) => !held(slot.id)).map((slot) => {
    const displayType = slot.type === 'movie' || slot.type === 'series' ? overrides?.[slot.type] : undefined;
    return displayType ? { ...slot, displayType } : slot;
  });
}

const PIN_PATTERN = /^\d{4,12}$/;
const SAVED_PIN = /^\$2[aby]\$/;

export function pinInvalid(pin?: string): boolean {
  return Boolean(pin && !SAVED_PIN.test(pin) && !PIN_PATTERN.test(pin));
}

/** What stops the configuration being saved because of the people set up in it, or null. */
export function householdIssue(
  config: { jellyfinUserName?: string; addonName?: string; jellyfinUserHandoffNames?: string[]; jellyfinUserPin?: string; jellyfinUsers?: JellyfinUser[] },
  userUUID: string,
): string | null {
  const users = config.jellyfinUsers ?? [];
  const clash = handoffNameClash(mainPersonName(config, userUUID), config.jellyfinUserHandoffNames, users);
  if (clash) return `"${clash}" is used by two people.`;
  if (pinInvalid(config.jellyfinUserPin)) return 'Your PIN must be 4 to 12 digits.';
  const badPin = users.find((user) => pinInvalid(user.pin));
  if (badPin) return `${badPin.name || 'A person'}'s PIN must be 4 to 12 digits.`;
  return null;
}

export type UserBadge = 'You' | 'Same person' | 'Own accounts' | 'Someone else';

export function userBadge(user: JellyfinUser | undefined, main: boolean): UserBadge {
  if (main) return 'You';
  if (user?.trackers === true) return 'Same person';
  return isHolder(user) ? 'Own accounts' : 'Someone else';
}

/** Names already count for every user card, and for the main user wherever playback reporting was on before. */
export function showsAlsoKnownAs(config: { playbackReporting?: boolean; jellyfinUserHandoffNames?: string[] }, users: JellyfinUser[]): boolean {
  return users.length > 0 || config.playbackReporting === true || Boolean(config.jellyfinUserHandoffNames?.length);
}

export function handoffNameClash(mainName: string, mainHandoff: string[] | undefined, users: JellyfinUser[]): string | null {
  const owners = new Map<string, string>();
  const claim = (owner: string, names: Array<string | undefined>): string | null => {
    for (const raw of names) {
      const name = (raw ?? '').trim();
      if (!name) continue;
      const held = owners.get(name.toLowerCase());
      if (held !== undefined && held !== owner) return name;
      owners.set(name.toLowerCase(), owner);
    }
    return null;
  };
  for (const user of users) owners.set(user.id.trim().toLowerCase(), user.id);
  const first = claim('', [mainName, ...(mainHandoff ?? [])]);
  if (first) return first;
  for (const user of users) {
    const clash = claim(user.id, [user.name, ...(user.handoffNames ?? [])]);
    if (clash) return clash;
  }
  return null;
}
