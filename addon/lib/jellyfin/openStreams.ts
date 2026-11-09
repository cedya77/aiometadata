// A second, lighter stream addon for listings started when a title opens.
//
// Resolve-on-open lists a title's streams as soon as its page opens, so the
// addon's own background work (preloading the top links, for example) starts
// before play. Every opened page then costs a full search, rate-limited
// indexers included, for titles that are only browsed. An open addon, such as
// a copy of the same AIOStreams configuration without those indexers, takes
// that listing instead; the version picker and play keep the playback addon.

export type OnOpenPlan = 'attach' | 'list-open' | 'list-full' | 'none';

/** The open addon's base, only when it sits beside a different playback addon. */
export function openStreamBase(playbackBase: string | null, openBase: string | null): string | null {
  if (!playbackBase || !openBase || openBase === playbackBase) return null;
  return openBase;
}

/** What a single title's request does about its streams. */
export function onOpenPlan(state: {
  asked: boolean;
  known: 'cached' | 'fetching' | null;
  on: boolean;
  openBase: string | null;
}): OnOpenPlan {
  const { asked, known, on, openBase } = state;
  if (asked || known === 'cached' || (on && known === 'fetching')) return 'attach';
  if (!on) return 'none';
  return openBase ? 'list-open' : 'list-full';
}

/** Open listings are kept apart, so the picker never shows a partial list. */
export function openListingKey(fullKey: string): string {
  return `${fullKey}:open`;
}

/** A profile's own playback addon replaces the configuration's, and its open addon with it. */
export function profileStreamAddons(streamUrl: string | undefined): Record<string, string | undefined> {
  return streamUrl ? { jellyfinStreamUrl: streamUrl, jellyfinOpenStreamUrl: undefined } : {};
}
