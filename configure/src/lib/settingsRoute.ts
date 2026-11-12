export type SettingsSectionId =
  | 'presets'
  | 'general'
  | 'integrations'
  | 'providers'
  | 'art-providers'
  | 'filters'
  | 'search'
  | 'catalogs'
  | 'people'
  | 'watch-tracking'
  | 'jellyfin'
  | 'configuration';

export interface SettingsSection {
  id: SettingsSectionId;
  title: string;
}

/** Nav order. The layout renders in this order and joins components by id. */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'presets', title: 'Presets' },
  { id: 'general', title: 'General' },
  { id: 'integrations', title: 'Integrations' },
  { id: 'providers', title: 'Meta Providers' },
  { id: 'art-providers', title: 'Art Providers' },
  { id: 'filters', title: 'Filters' },
  { id: 'search', title: 'Search' },
  { id: 'catalogs', title: 'Catalogs' },
  { id: 'people', title: 'People' },
  { id: 'watch-tracking', title: 'Watch Tracking' },
  { id: 'jellyfin', title: 'Jellyfin' },
  { id: 'configuration', title: 'Configuration' },
];

/** The sections this instance offers; the route still accepts every id so a deep link survives loading. */
export function visibleSettingsSections({ jellyfin }: { jellyfin: boolean }): SettingsSection[] {
  return jellyfin ? SETTINGS_SECTIONS : SETTINGS_SECTIONS.filter((section) => section.id !== 'jellyfin');
}

export const DEFAULT_SECTION: SettingsSectionId = 'general';

/** `/stremio/<name>/configure` means an existing config is being opened, not a first run. */
export function isExistingConfigUrl(pathname: string): boolean {
  const parts = pathname.split('/');
  const configure = parts.findIndex(part => part.toLowerCase() === 'configure');
  const stremio = parts.findIndex(part => part.toLowerCase() === 'stremio');
  return stremio !== -1 && (configure === stremio + 2 || configure === stremio + 3);
}

/** True when the URL names a section outright, which must beat any default. */
export function hasExplicitSection(hash: string): boolean {
  const raw = (hash || '').trim().replace(/^#/, '');
  const slash = raw.indexOf('/');
  return isSettingsSectionId((slash === -1 ? raw : raw.slice(0, slash)).toLowerCase());
}

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}

export interface SettingsRoute {
  section: SettingsSectionId;
  anchor: string | null;
}


const ANCHOR_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const OLD_PEOPLE_ANCHOR = 'household-users';

export function parseRoute(hash: string): SettingsRoute {
  const raw = (hash || '').trim().replace(/^#/, '');
  const slash = raw.indexOf('/');
  const sectionPart = (slash === -1 ? raw : raw.slice(0, slash)).toLowerCase();

  if (!isSettingsSectionId(sectionPart)) {
    return { section: DEFAULT_SECTION, anchor: null };
  }
  const anchorPart = slash === -1 ? '' : raw.slice(slash + 1);
  if (sectionPart === 'watch-tracking' && (anchorPart === OLD_PEOPLE_ANCHOR || anchorPart.startsWith(`${OLD_PEOPLE_ANCHOR}.`))) {
    const key = anchorPart.slice(OLD_PEOPLE_ANCHOR.length + 1);
    return { section: 'people', anchor: ANCHOR_PATTERN.test(key) ? key : null };
  }
  return {
    section: sectionPart,
    anchor: ANCHOR_PATTERN.test(anchorPart) ? anchorPart : null,
  };
}

export function hashFor(id: SettingsSectionId, anchor?: string | null): string {
  return anchor ? `#${id}/${anchor}` : `#${id}`;
}

export const SETTINGS_LAYOUT_NAVIGATE_EVENT = 'settings-layout:navigate';

/** Lets components outside the layout switch sections without threading a prop through. */
export function navigateToSettingsSection(tab: SettingsSectionId, anchor?: string): void {
  window.dispatchEvent(
    new CustomEvent(SETTINGS_LAYOUT_NAVIGATE_EVENT, { detail: { tab, scrollToTop: true, ...(anchor ? { anchor } : {}) } })
  );
}

export type IntegrationDialog = 'simkl' | 'anilist' | 'mal';
export const OPEN_INTEGRATION_EVENT = 'settings:open-integration';

let pendingIntegration: IntegrationDialog | null = null;

/** Asks Catalogs to open a service's sign-in, now if it is showing or as soon as it mounts. */
export function requestIntegrationDialog(service: IntegrationDialog): void {
  pendingIntegration = service;
  window.dispatchEvent(new CustomEvent(OPEN_INTEGRATION_EVENT, { detail: service }));
}

export function consumeIntegrationDialogRequest(): IntegrationDialog | null {
  const requested = pendingIntegration;
  pendingIntegration = null;
  return requested;
}

let pendingCollectionBuilder = false;

export function requestCollectionBuilder(): void {
  pendingCollectionBuilder = true;
}

export function consumeCollectionBuilderRequest(): boolean {
  const requested = pendingCollectionBuilder;
  pendingCollectionBuilder = false;
  return requested;
}

export function adjacentSections(id: SettingsSectionId, sections: SettingsSection[] = SETTINGS_SECTIONS): {
  prev: SettingsSection | null;
  next: SettingsSection | null;
} {
  const index = sections.findIndex((section) => section.id === id);
  if (index === -1) return { prev: null, next: null };
  return {
    prev: index > 0 ? sections[index - 1] : null,
    next: index < sections.length - 1 ? sections[index + 1] : null,
  };
}
