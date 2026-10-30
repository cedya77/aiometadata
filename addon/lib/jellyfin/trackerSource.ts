import { ACCOUNT_SERVICES, credentialOf, trackerConfig, type AccountService } from '../accounts';
import { TRACKERS, isAnimeList, resumeTrackers } from '../trackers';

/** Services that store a playback position or a watch history we can read. */
export type Capable = AccountService;

const POSITIONAL: readonly Capable[] = resumeTrackers();
export const CAPABLE: readonly Capable[] = [...POSITIONAL, ...(Object.keys(TRACKERS) as Capable[]).filter((service) => !POSITIONAL.includes(service))];

export function credentialFor(config: any, service: Capable): string | undefined {
  return trackerConfig(config, service)?.[ACCOUNT_SERVICES[service].master] !== false ? credentialOf(config, service) : undefined;
}

/**
 * One service answers both the resume shelf and the watched ticks, so a title
 * cannot read as unwatched in the library while sitting part-played in continue
 * watching because two trackers were asked.
 */
// A choice of a service no longer read, such as Trakt, reads as Automatic.
function choiceOf(config: any): string {
  const choice = config?.jellyfinResumeSource ?? 'auto';
  return choice === 'off' || (CAPABLE as readonly string[]).includes(choice) ? choice : 'auto';
}

export function sourceFor(config: any): Capable | null {
  const choice = choiceOf(config);
  if (choice === 'off') return null;
  if (choice !== 'auto') {
    return credentialFor(config, choice as Capable) ? (choice as Capable) : null;
  }
  return POSITIONAL.find((service) => credentialFor(config, service)) ?? null;
}

/** Every service the resume shelf reads under Automatic; a named choice is that one alone. */
export function resumeSourcesFor(config: any): Capable[] {
  const choice = choiceOf(config);
  if (choice === 'off') return [];
  if (choice !== 'auto') {
    return POSITIONAL.includes(choice as Capable) && credentialFor(config, choice as Capable) ? [choice as Capable] : [];
  }
  return POSITIONAL.filter((service) => credentialFor(config, service));
}

export function keepsAnimeOnly(config: any): boolean {
  const service = sourceFor(config);
  return service !== null && isAnimeList(service);
}
