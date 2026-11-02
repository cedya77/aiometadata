import { scrobblesJellyfin, scrobblesStremio } from './watchTracking';

export interface PlaySource {
  /** Whether what this source reports reaches the trackers. */
  scrobbles: (config: any) => boolean;
  /** Manifest resources that make the client start sending its events. */
  resources: string[];
  /** The resources are declared only while someone has a tracker to send to. */
  needsTracker: boolean;
  /** Reports progress while playing; one that does not is taken as stopped once it outlasts what it had left. */
  sendsProgress: boolean;
  /** How the client shows on the server, for one whose events do not arrive as its own requests. */
  client?: { name: string; deviceId: string };
}

const CLIENTS = {
  jellyfin: { scrobbles: scrobblesJellyfin, resources: ['watch_state', 'playback'], needsTracker: true, sendsProgress: true },
  stremio: { scrobbles: scrobblesStremio, resources: ['player', 'library'], needsTracker: false, sendsProgress: false, client: { name: 'Stremio', deviceId: 'stremio' } },
} satisfies Record<string, PlaySource>;

export type PlaySourceId = keyof typeof CLIENTS | 'dashboard';

export const PLAY_SOURCES: Record<PlaySourceId, PlaySource> = {
  ...CLIENTS,
  dashboard: {
    scrobbles: (config) => Object.values(CLIENTS).some((source) => source.scrobbles(config)),
    resources: [],
    needsTracker: false,
    sendsProgress: true,
  },
};

/** The source a live session came from, told apart by the client name a source without its own requests plays under. */
export function sourceOfApp(app: { client: string } | null | undefined): PlaySourceId {
  const found = (Object.entries(CLIENTS) as Array<[keyof typeof CLIENTS, PlaySource]>).find(([, source]) => source.client && source.client.name === app?.client);
  return found ? found[0] : 'jellyfin';
}

/** Event resources the manifest declares; declaring one is what makes a front-end start delivering it. */
export function scrobbleResources(config: any, anyoneTracks: boolean): string[] {
  return Object.values(PLAY_SOURCES).flatMap((source) => (source.scrobbles(config) && (anyoneTracks || !source.needsTracker) ? source.resources : []));
}
