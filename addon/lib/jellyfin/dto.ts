export const JELLYFIN_VERSION = '10.10.7';
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
    EnableContentDownloading: false,
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
    SyncPlayAccess: 'None',
  };
}

export function userDto(userId: string, serverId: string, name: string): any {
  const now = new Date().toISOString();
  return {
    Name: name,
    ServerId: serverId,
    Id: userId,
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
  client: { client: string; device: string; deviceId: string; version: string }
): any {
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
    SupportsMediaControl: false,
    SupportsRemoteControl: false,
    HasCustomDeviceName: false,
    PlayableMediaTypes: ['Video'],
    SupportedCommands: [],
    NowPlayingQueue: [],
    NowPlayingQueueFullItems: [],
    AdditionalUsers: [],
    LastActivityDate: new Date().toISOString(),
  };
}

export function itemList(items: any[], total: number, startIndex: number): any {
  return { Items: items, TotalRecordCount: total, StartIndex: startIndex };
}

const EMPTY_USER_DATA = {
  PlaybackPositionTicks: 0,
  PlayCount: 0,
  IsFavorite: false,
  Played: false,
  UnplayedItemCount: 0,
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
    UserData: { ...EMPTY_USER_DATA, Key: id },
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

export { EMPTY_USER_DATA };
