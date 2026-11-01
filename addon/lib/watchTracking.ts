import type { UserConfig } from '../types';
import { ACCOUNT_SERVICES, credentialOf, trackerConfig } from './accounts';

export type WatchTrackingService =
  | 'simkl'
  | 'anilist'
  | 'mal'
  | 'mdblist'
  | 'publicmetadb';

export type WatchTrackingMediaType = 'movie' | 'series';

export function scrobblesJellyfin(config: any): boolean {
  return config?.playbackReporting === true && config?.jellyfinScrobbling !== false;
}

export function scrobblesStremio(config: any): boolean {
  return config?.playbackReporting === true && config?.stremioScrobbling === true;
}

export function syncsStremioLibrary(config: any): boolean {
  return scrobblesStremio(config) && config?.stremioLibraryWatchlist === true;
}

export const WATCH_TRACKING_SERVICES: WatchTrackingService[] = [
  'simkl',
  'anilist',
  'mal',
  'mdblist',
  'publicmetadb',
];

export function isWatchTrackingMediaTypeSelected(
  config: UserConfig,
  service: WatchTrackingService,
  mediaType: WatchTrackingMediaType,
): boolean {
  return trackerConfig(config, service)?.watchTracking?.[service]?.[mediaType] !== false;
}

export function isWatchTrackingServiceEnabled(
  config: UserConfig,
  service: WatchTrackingService,
): boolean {
  return Boolean(credentialOf(config, service)) && trackerConfig(config, service)?.[ACCOUNT_SERVICES[service].master] === true;
}

export function shouldTrackServiceMediaType(
  config: UserConfig,
  service: WatchTrackingService,
  mediaType: WatchTrackingMediaType,
): boolean {
  return (
    isWatchTrackingServiceEnabled(config, service) &&
    isWatchTrackingMediaTypeSelected(config, service, mediaType)
  );
}

export function hasAnyWatchTrackingEnabled(config: UserConfig): boolean {
  return WATCH_TRACKING_SERVICES.some(
    (service) =>
      shouldTrackServiceMediaType(config, service, 'movie') ||
      shouldTrackServiceMediaType(config, service, 'series'),
  );
}

export function normalizeWatchTrackingMediaType(
  routeType: unknown,
  parsedType: WatchTrackingMediaType,
): WatchTrackingMediaType | null {
  const normalizedRouteType =
    typeof routeType === 'string' ? routeType.trim().toLowerCase() : '';

  if (
    normalizedRouteType === 'movie' ||
    normalizedRouteType === 'series'
  ) {
    return normalizedRouteType === parsedType ? normalizedRouteType : null;
  }

  return parsedType;
}

