/** Services that store a playback position or a watch history we can read. */
export const CAPABLE = ['mdblist', 'trakt', 'simkl', 'publicmetadb'] as const;

export type Capable = (typeof CAPABLE)[number];

export function credentialFor(config: any, service: Capable): string | undefined {
  const keys = config?.apiKeys ?? {};
  switch (service) {
    case 'mdblist':
      return config?.mdblistWatchTracking !== false ? keys.mdblist : undefined;
    case 'trakt':
      return config?.traktWatchTracking !== false ? keys.traktTokenId : undefined;
    case 'simkl':
      return config?.simklWatchTracking !== false ? keys.simklTokenId : undefined;
    case 'publicmetadb':
      return config?.publicmetadbWatchTracking !== false ? keys.publicmetadb : undefined;
  }
}

/**
 * One service answers both the resume shelf and the watched ticks, so a title
 * cannot read as unwatched in the library while sitting part-played in continue
 * watching because two trackers were asked.
 */
export function sourceFor(config: any): Capable | null {
  const choice = config?.jellyfinResumeSource ?? 'auto';
  if (choice === 'off') return null;
  if (choice !== 'auto') {
    return credentialFor(config, choice as Capable) ? (choice as Capable) : null;
  }
  return CAPABLE.find((service) => credentialFor(config, service)) ?? null;
}

/** Every service the resume shelf reads under Automatic; a named choice is that one alone. */
export function resumeSourcesFor(config: any): Capable[] {
  const choice = config?.jellyfinResumeSource ?? 'auto';
  if (choice === 'off') return [];
  if (choice !== 'auto') {
    return credentialFor(config, choice as Capable) ? [choice as Capable] : [];
  }
  return CAPABLE.filter((service) => credentialFor(config, service));
}
