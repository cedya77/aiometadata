import { createHash } from 'crypto';
import { normaliseJellyfinId } from './idsCodec';
import { imageTag, wideTag } from './imageTags';

// The official Kotlin SDK refuses anything below 12.0.0.
export const JELLYFIN_VERSION = '12.1.0';
export const SERVER_NAME = 'AIOMetadata';

export function publicSystemInfo(serverId: string, localAddress: string): any {
  return {
    LocalAddress: localAddress,
    ServerName: SERVER_NAME,
    Version: JELLYFIN_VERSION,
    ProductName: 'Jellyfin Server',
    OperatingSystem: 'Linux',
    Id: serverId,
    StartupWizardCompleted: true,
  };
}

const buildInfo: any = require('../buildInfo');

/** The AIOStreams Jellyfin extensions this server offers, each with its version. */
const EXTENSIONS = {
  users: 1,
  history: 1,
  playedUpTo: 1,
  dropped: 1,
  refreshVersions: 1,
  versions: 1,
  genreRequired: 1,
  ranked: 1,
  watchlistFavorites: 1,
  fillers: 1,
  playlists: 1,
} as const;

export function extensionInfo(origin: string): any {
  return {
    logo: process.env.ADDON_LOGO_URL?.trim() || `${origin}/logo.png`,
    configureUrl: `${origin}/configure`,
    pinSignIn: false,
    features: require('../criticRatings').criticRatingsEnabled() ? { ...EXTENSIONS, criticRatings: 1 } : EXTENSIONS,
    version: { tag: `v${buildInfo.version}` },
  };
}

export function systemInfo(serverId: string, localAddress: string): any {
  return {
    ...publicSystemInfo(serverId, localAddress),
    OperatingSystemDisplayName: 'Linux',
    PackageName: 'aiometadata',
    HasPendingRestart: false,
    IsShuttingDown: false,
    SupportsLibraryMonitor: false,
    WebSocketPortNumber: 8096,
    CompletedInstallations: [],
    CanSelfRestart: false,
    CanLaunchWebBrowser: false,
    ProgramDataPath: '/config',
    WebPath: '/web',
    ItemsByNamePath: '/config/metadata',
    CachePath: '/cache',
    LogPath: '/config/log',
    InternalMetadataPath: '/config/metadata',
    TranscodingTempPath: '/cache/transcodes',
    HasUpdateAvailable: false,
    EncoderLocation: 'NotFound',
    SystemArchitecture: 'X64',
  };
}

export function userConfiguration(): any {
  return {
    PlayDefaultAudioTrack: true,
    AudioLanguages: [],
    SubtitleLanguages: [],
    SubtitleTypes: [],
    ListPreferredSubtitlesOnly: false,
    SubtitleLanguagePreference: '',
    DisplayMissingEpisodes: false,
    GroupedFolders: [],
    SubtitleMode: 'Default',
    DisplayCollectionsView: false,
    EnableLocalPassword: false,
    OrderedViews: [],
    LatestItemsExcludes: [],
    MyMediaExcludes: [],
    HidePlayedInLatest: true,
    RememberAudioSelections: true,
    RememberSubtitleSelections: true,
    EnableNextEpisodeAutoPlay: true,
  };
}

export function userPolicy(): any {
  return {
    IsAdministrator: false,
    IsHidden: true,
    IsDisabled: false,
    EnableCollectionManagement: false,
    EnableSubtitleManagement: false,
    EnableLyricManagement: false,
    BlockedTags: [],
    EnableUserPreferenceAccess: true,
    AccessSchedules: [],
    BlockUnratedItems: [],
    EnableRemoteControlOfOtherUsers: false,
    EnableSharedDeviceControl: false,
    EnableRemoteAccess: true,
    EnableLiveTvManagement: false,
    EnableLiveTvAccess: false,
    EnableMediaPlayback: true,
    EnableAudioPlaybackTranscoding: false,
    EnableVideoPlaybackTranscoding: false,
    EnablePlaybackRemuxing: false,
    ForceRemoteSourceTranscoding: false,
    EnableContentDeletion: false,
    EnableContentDeletionFromFolders: [],
    EnableContentDownloading: true,
    EnableSyncTranscoding: false,
    EnableMediaConversion: false,
    EnabledDevices: [],
    EnableAllDevices: true,
    EnabledChannels: [],
    EnableAllChannels: true,
    EnabledFolders: [],
    EnableAllFolders: true,
    InvalidLoginAttemptCount: 0,
    LoginAttemptsBeforeLockout: -1,
    MaxActiveSessions: 0,
    EnablePublicSharing: false,
    BlockedMediaFolders: [],
    BlockedChannels: [],
    RemoteClientBitrateLimit: 0,
    AuthenticationProviderId:
      'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider',
    PasswordResetProviderId:
      'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider',
    SyncPlayAccess: require('./syncplay/settings').syncPlayEnabled() ? 'CreateAndJoinGroups' : 'None',
  };
}

export function userDto(userId: string, serverId: string, name: string, primaryImageTag?: string): any {
  const now = new Date().toISOString();
  return {
    Name: name,
    ServerId: serverId,
    Id: userId,
    ...(primaryImageTag ? { PrimaryImageTag: primaryImageTag } : {}),
    HasPassword: true,
    HasConfiguredPassword: true,
    HasConfiguredEasyPassword: false,
    EnableAutoLogin: false,
    LastLoginDate: now,
    LastActivityDate: now,
    Configuration: userConfiguration(),
    Policy: userPolicy(),
  };
}

export function sessionInfo(
  userId: string,
  serverId: string,
  userName: string,
  client: { client: string; device: string; deviceId: string; version: string },
  remote?: { playableMediaTypes?: string[]; supportedCommands: string[]; supportsMediaControl?: boolean; lastSeen: number }
): any {
  const seen = new Date(remote?.lastSeen ?? Date.now()).toISOString();
  return {
    Id: `${userId}-${client.deviceId}`,
    UserId: userId,
    UserName: userName,
    ServerId: serverId,
    Client: client.client,
    DeviceName: client.device,
    DeviceId: client.deviceId,
    ApplicationVersion: client.version,
    IsActive: true,
    SupportsMediaControl: remote ? remote.supportsMediaControl !== false : false,
    SupportsRemoteControl: remote ? remote.supportsMediaControl !== false : false,
    HasCustomDeviceName: false,
    PlayableMediaTypes: remote?.playableMediaTypes ?? ['Video'],
    SupportedCommands: remote?.supportedCommands ?? [],
    NowPlayingQueue: [],
    NowPlayingQueueFullItems: [],
    AdditionalUsers: [],
    LastActivityDate: seen,
    LastPlaybackCheckIn: seen,
  };
}

export function itemList(items: any[], total: number, startIndex: number): any {
  return { Items: items, TotalRecordCount: total, StartIndex: startIndex };
}

/** Plays of a title as a client is told them: none once it is unmarked, as Jellyfin resets them, and at least one while it is played. */
export function playCountOf(played: boolean, stored: unknown): number {
  return played ? Math.max(1, Number(stored) || 0) : 0;
}

const EMPTY_USER_DATA = {
  PlaybackPositionTicks: 0,
  PlayCount: 0,
  IsFavorite: false,
  Played: false,
};

export function collectionFolder(
  id: string,
  serverId: string,
  name: string,
  collectionType: string | null,
  childCount: number | null
): any {
  return {
    Name: name,
    ServerId: serverId,
    Id: id,
    Etag: id,
    DateCreated: new Date(0).toISOString(),
    CanDelete: false,
    CanDownload: false,
    SortName: name,
    ExternalUrls: [],
    Path: `/${id}`,
    EnableMediaSourceDisplay: false,
    Taglines: [],
    RemoteTrailers: [],
    ProviderIds: {},
    IsFolder: true,
    ParentId: null,
    Type: 'CollectionFolder',
    People: [],
    Studios: [],
    GenreItems: [],
    LocalTrailerCount: 0,
    UserData: { ...EMPTY_USER_DATA, Key: id, ItemId: id },
    ChildCount: childCount,
    DisplayPreferencesId: id,
    Tags: [],
    PrimaryImageAspectRatio: 1,
    CollectionType: collectionType,
    ImageTags: {},
    BackdropImageTags: [],
    ImageBlurHashes: {},
    LocationType: 'FileSystem',
    MediaType: 'Unknown',
    LockedFields: [],
    LockData: false,
  };
}

const md5 = (value: string): string => createHash('md5').update(value).digest('hex');

export function namedItem(type: 'Genre' | 'Studio' | 'Year', name: string, id: string, serverId: string, extra: Record<string, unknown> = {}): any {
  return {
    Name: name,
    Id: id,
    ServerId: serverId,
    Type: type,
    IsFolder: false,
    ImageTags: {},
    BackdropImageTags: [],
    ImageBlurHashes: {},
    ...extra,
  };
}

export function rootFolderId(userUUID: string): string {
  return md5(`root:${userUUID}`);
}

export function rootFolder(id: string, serverId: string): any {
  return {
    Name: 'Media Folders',
    Id: id,
    ServerId: serverId,
    Type: 'UserRootFolder',
    IsFolder: true,
    ImageTags: {},
    BackdropImageTags: [],
    ImageBlurHashes: {},
  };
}

/** A listing under the root folder is a listing with no parent. */
export function isRootParent(rawParentId: unknown, userUUID: string): boolean {
  if (rawParentId === undefined || rawParentId === null || rawParentId === '') return false;
  return normaliseJellyfinId(String(rawParentId)) === rootFolderId(userUUID);
}

export function yearItemId(year: number): string {
  return md5(`year:${year}`);
}

export function parseYear(raw: string, now: Date): number | null {
  if (!/^\d{4}$/.test(raw)) return null;
  const year = Number(raw);
  return year >= 1850 && year <= now.getUTCFullYear() + 10 ? year : null;
}

type ListImages = { primary?: string; backdrop?: string; logo?: string; thumb?: string };

/** An item's images as Jellyfin lists them, tagged as the item builder tags them (items.ts:742-755). */
export function imageInfos(images: ListImages): any[] {
  const entry = (type: string, url: string | undefined, index: number | null, tag?: string) =>
    typeof url === 'string' && url ? [{ ImageType: type, ImageIndex: index, ImageTag: tag ?? imageTag(url), Size: 0 }] : [];
  const { primary, backdrop, logo, thumb } = images;
  const widePrimary = Boolean(primary) && primary === thumb ? wideTag(imageTag(primary as string)) : undefined;
  return [
    ...entry('Primary', primary, null, widePrimary),
    ...entry('Backdrop', backdrop, 0),
    ...entry('Logo', logo, null),
    ...entry('Thumb', thumb, null),
  ];
}

export type NameLookup<T> = { status: 200; found: T } | { status: 404 } | { status: 503; error: unknown };

export async function lookupByName<T>(name: string, find: (name: string) => Promise<T | null>): Promise<NameLookup<T>> {
  const wanted = String(name ?? '').trim();
  if (!wanted) return { status: 404 };
  let found: T | null;
  try {
    found = await find(wanted);
  } catch (error) {
    return { status: 503, error };
  }
  return found ? { status: 200, found } : { status: 404 };
}

export { EMPTY_USER_DATA };
