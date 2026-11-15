import type { AppConfig, WatchTrackingService } from '@/contexts/config';
import { navigateToSettingsSection, requestIntegrationDialog, type IntegrationDialog, type SettingsSectionId } from './settingsRoute';

export type WatchTrackingMediaType = 'movie' | 'series';
type WatchTrackingMasterKey =
  | 'simklWatchTracking'
  | 'anilistWatchTracking'
  | 'malWatchTracking'
  | 'mdblistWatchTracking'
  | 'publicmetadbWatchTracking';

interface WatchTrackingServiceDefinition {
  label: string;
  masterKey: WatchTrackingMasterKey;
  hasCredential: (config: AppConfig) => boolean;
  movieLabel: string;
  seriesLabel: string;
  connectSection: SettingsSectionId;
  connectHint: string;
}

export const WATCH_TRACKING_SERVICES: WatchTrackingService[] = [
  'simkl',
  'anilist',
  'mal',
  'mdblist',
  'publicmetadb',
];

export const WATCH_TRACKING_SERVICE_DEFINITIONS: Record<
  WatchTrackingService,
  WatchTrackingServiceDefinition
> = {
  simkl: {
    label: 'Simkl',
    masterKey: 'simklWatchTracking',
    hasCredential: (config) => !!config.apiKeys?.simklTokenId,
    movieLabel: 'Movies',
    seriesLabel: 'TV Shows',
    connectSection: 'catalogs',
    connectHint: 'Open the Catalogs tab and tap the Simkl icon to sign in.',
  },
  anilist: {
    label: 'AniList',
    masterKey: 'anilistWatchTracking',
    hasCredential: (config) => !!config.apiKeys?.anilistTokenId,
    movieLabel: 'Anime Movies',
    seriesLabel: 'Anime Series',
    connectSection: 'catalogs',
    connectHint: 'Open the Catalogs tab and tap the AniList icon to sign in.',
  },
  mal: {
    label: 'MyAnimeList',
    masterKey: 'malWatchTracking',
    hasCredential: (config) => !!config.apiKeys?.malTokenId,
    movieLabel: 'Anime Movies',
    seriesLabel: 'Anime Series',
    connectSection: 'catalogs',
    connectHint: 'Open the Catalogs tab and tap the MyAnimeList icon to sign in.',
  },
  mdblist: {
    label: 'MDBList',
    masterKey: 'mdblistWatchTracking',
    hasCredential: (config) => !!config.apiKeys?.mdblist,
    movieLabel: 'Movies',
    seriesLabel: 'TV Shows',
    connectSection: 'integrations',
    connectHint: 'Add your MDBList API key in the Integrations tab.',
  },
  publicmetadb: {
    label: 'PublicMetaDB',
    masterKey: 'publicmetadbWatchTracking',
    hasCredential: (config) => !!config.apiKeys?.publicmetadb,
    movieLabel: 'Movies',
    seriesLabel: 'TV Shows',
    connectSection: 'integrations',
    connectHint: 'Add your PublicMetaDB API key in the Integrations tab.',
  },
};

export function scrobblesJellyfin(config: AppConfig): boolean {
  return config.playbackReporting === true && config.jellyfinScrobbling !== false;
}

export function scrobblesStremio(config: AppConfig): boolean {
  return config.playbackReporting === true && config.stremioScrobbling === true;
}

export type ConnectTarget = { section: SettingsSectionId; dialog?: IntegrationDialog; anchor?: string };

/** Where a service is connected: its sign-in in Catalogs, or its key field in Integrations. */
export function connectTargetFor(service: WatchTrackingService): ConnectTarget {
  if (service === 'simkl' || service === 'anilist' || service === 'mal') return { section: 'catalogs', dialog: service };
  return { section: 'integrations', anchor: service };
}

export function openServiceConnect(service: WatchTrackingService): void {
  const target = connectTargetFor(service);
  if (target.dialog) requestIntegrationDialog(target.dialog);
  navigateToSettingsSection(target.section, target.anchor);
}

export function anyServiceConnected(config: AppConfig): boolean {
  return WATCH_TRACKING_SERVICES.some((service) => WATCH_TRACKING_SERVICE_DEFINITIONS[service].hasCredential(config));
}

/** Mirrors the manifest: the Stremio events are declared with the switch alone. */
export function declaresStremioEvents(config: AppConfig): boolean {
  return scrobblesStremio(config);
}

/** What a missing key already means, so setting one back to it is no change. */
const WATCH_TRACKING_DEFAULTS = {
  playbackReporting: false,
  jellyfinScrobbling: true,
  stremioScrobbling: false,
  stremioLibraryWatchlist: false,
} as const;

/** The config less watch tracking values that only restate their default, for telling whether anything changed. */
export function withoutWatchTrackingDefaults(config: AppConfig): AppConfig {
  const out: Record<string, unknown> = { ...config };
  for (const [key, value] of Object.entries(WATCH_TRACKING_DEFAULTS)) {
    if (out[key] === value) delete out[key];
  }
  // The sources only count while a title counts once finished.
  if (config.playbackReporting !== true) {
    delete out.jellyfinScrobbling;
    delete out.stremioScrobbling;
    delete out.stremioLibraryWatchlist;
  }
  // Retaken whenever the events are declared again, so turning them off and on restamps it.
  delete out.stremioScrobblingSince;
  const left = Object.entries(config.watchTracking ?? {}).flatMap(([service, types]) => {
    const off = Object.fromEntries(Object.entries(types ?? {}).filter(([, on]) => on === false));
    return Object.keys(off).length ? [[service, off]] : [];
  });
  if (left.length) out.watchTracking = Object.fromEntries(left);
  else delete out.watchTracking;
  return out as unknown as AppConfig;
}

export function withStremioEventsSince<T extends AppConfig>(prev: T, next: T): T {
  return !declaresStremioEvents(prev) && declaresStremioEvents(next) ? { ...next, stremioScrobblingSince: Date.now() } : next;
}

export type StremioLinkState = 'reinstall' | 'waiting' | 'ok';

export function stremioLinkState(
  since: number | undefined,
  status?: { manifestAt: number | null; eventAt: number | null },
): StremioLinkState {
  const from = since ?? 0;
  if (status?.eventAt && status.eventAt >= from) return 'ok';
  if (status?.manifestAt && status.manifestAt >= from) return 'waiting';
  return 'reinstall';
}

export function withViewer(installUrl: string, cardId: string): string {
  const url = new URL(installUrl);
  url.searchParams.set('viewer', cardId);
  return url.toString();
}

export function isWatchTrackingMediaTypeSelected(
  config: AppConfig,
  service: WatchTrackingService,
  mediaType: WatchTrackingMediaType,
): boolean {
  return config.watchTracking?.[service]?.[mediaType] !== false;
}

export function isWatchTrackingServiceEnabled(
  config: AppConfig,
  service: WatchTrackingService,
): boolean {
  const { masterKey } = WATCH_TRACKING_SERVICE_DEFINITIONS[service];
  return config[masterKey] === true;
}

export function isWatchTrackingMediaTypeEnabled(
  config: AppConfig,
  service: WatchTrackingService,
  mediaType: WatchTrackingMediaType,
): boolean {
  return (
    isWatchTrackingServiceEnabled(config, service) &&
    isWatchTrackingMediaTypeSelected(config, service, mediaType)
  );
}

export function hasAnyWatchTrackingEnabled(config: AppConfig): boolean {
  return WATCH_TRACKING_SERVICES.some((service) => {
    const definition = WATCH_TRACKING_SERVICE_DEFINITIONS[service];
    return (
      definition.hasCredential(config) &&
      (isWatchTrackingMediaTypeEnabled(config, service, 'movie') ||
        isWatchTrackingMediaTypeEnabled(config, service, 'series'))
    );
  });
}

export function getWatchTrackingMediaTypeSummary(
  config: AppConfig,
  service: WatchTrackingService,
): string {
  const definition = WATCH_TRACKING_SERVICE_DEFINITIONS[service];
  const movie = isWatchTrackingMediaTypeSelected(config, service, 'movie');
  const series = isWatchTrackingMediaTypeSelected(config, service, 'series');

  if (movie && series) return `${definition.movieLabel} & ${definition.seriesLabel}`;
  if (movie) return definition.movieLabel;
  if (series) return definition.seriesLabel;
  return 'No media types selected';
}

