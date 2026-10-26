/**
 * Parent configs: a configuration names another one (its parent) and takes the
 * parent's settings at request time, section by section, the way AIOStreams does.
 *
 * Pure data and functions only, so the configure page imports the same section
 * list the server merges with.
 */

export type MergeStrategy = 'inherit' | 'extend' | 'override';

export type ParentSectionId =
  | 'general'
  | 'apiKeys'
  | 'providers'
  | 'artProviders'
  | 'filters'
  | 'search'
  | 'catalogs';

export interface ParentConfigLink {
  uuid: string;
  /** The parent's configuration password; a changed password ends the link. */
  password: string;
  mergeStrategies?: Partial<Record<ParentSectionId, MergeStrategy>> & {
    fieldOverrides?: Record<string, MergeStrategy>;
  };
}

export interface ParentField {
  /** A top-level config key, or `apiKeys.<name>` for one API key. */
  key: string;
  label: string;
  /** Present on lists that can be extended: what makes two entries the same. */
  identity?: (item: any) => string;
}

export interface ParentSection {
  id: ParentSectionId;
  label: string;
  description: string;
  /** Only Catalogs lets the child's own entries be added after the parent's. */
  extendable?: boolean;
  fields: ParentField[];
}

/**
 * Everything not listed here always stays the child's own: tracker and manager
 * accounts, watch tracking, Jellyfin users and PINs, recommendations, sessionId.
 */
export const PARENT_SECTIONS: ParentSection[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Language, display options and addon resources.',
    fields: [
      { key: 'addonName', label: 'Addon Name' },
      { key: 'language', label: 'Language' },
      { key: 'timezone', label: 'Timezone' },
      { key: 'includeAdult', label: 'Include Adult' },
      { key: 'blurThumbs', label: 'Blur Thumbnails' },
      { key: 'showPrefix', label: 'Show Prefix' },
      { key: 'showMetaProviderAttribution', label: 'Meta Provider Attribution' },
      { key: 'hideErrors', label: 'Hide Errors' },
      { key: 'castCount', label: 'Cast Count' },
      { key: 'displayAgeRating', label: 'Display Age Rating' },
      { key: 'contentRatingCountry', label: 'Content Rating Country' },
      { key: 'displayTypeOverrides', label: 'Display Type Overrides' },
      { key: 'showRateMeButton', label: 'Rate Me Button' },
      { key: 'enableRatingPostersForLibrary', label: 'Rating Posters in Library' },
      { key: 'catalogModeOnly', label: 'Catalog Mode Only' },
      { key: 'hideStremioCatalogs', label: 'Hide Stremio-Specific Catalogs' },
      { key: 'collectionCatalogs', label: 'Collections as Catalogs' },
    ],
  },
  {
    id: 'apiKeys',
    label: 'API Keys',
    description: 'Metadata, artwork and AI keys. Tracker sign-ins always stay yours.',
    fields: [
      { key: 'apiKeys.tmdb', label: 'TMDB Key' },
      { key: 'apiKeys.tvdb', label: 'TVDB Key' },
      { key: 'apiKeys.fanart', label: 'Fanart Key' },
      { key: 'apiKeys.mdblist', label: 'MDBList Key' },
      { key: 'apiKeys.rpdb', label: 'RPDB Key' },
      { key: 'apiKeys.topPoster', label: 'TOP Posters Key' },
      { key: 'apiKeys.publicmetadb', label: 'PublicMetaDB Key' },
      { key: 'apiKeys.gemini', label: 'Gemini Key' },
      { key: 'apiKeys.openrouter', label: 'OpenRouter Key' },
    ],
  },
  {
    id: 'providers',
    label: 'Meta Providers',
    description: 'Meta providers, episode order, MAL, TMDB and trailer options.',
    fields: [
      { key: 'providers', label: 'Meta Providers' },
      { key: 'tvdbSeasonType', label: 'Season Order' },
      { key: 'tvdbNormalizeYearSeasons', label: 'Normalize Year Seasons' },
      { key: 'tvdbEpisodeOrders', label: 'Per-Show Episode Orders' },
      { key: 'tvdbShowSeasonNumbering', label: 'Per-Show Season Numbering' },
      { key: 'animeEpisodeDates', label: 'Anime Episode Dates' },
      { key: 'mal', label: 'MyAnimeList Options' },
      { key: 'tmdb', label: 'TMDB Options' },
      { key: 'trailerProvider', label: 'Trailer Source' },
      { key: 'trailerAddonUrl', label: 'Trailer Addon URL' },
    ],
  },
  {
    id: 'artProviders',
    label: 'Art Providers',
    description: 'Art providers, rating posters and custom art URLs.',
    fields: [
      { key: 'artProviders', label: 'Art Providers' },
      { key: 'posterRatingProvider', label: 'Rating Poster Provider' },
      { key: 'usePosterProxy', label: 'Proxy Rating & Custom Art' },
      { key: 'customPosterUrlPattern', label: 'Custom Poster URL' },
      { key: 'customBackgroundUrlPattern', label: 'Custom Background URL' },
      { key: 'customLandscapeUrlPattern', label: 'Custom Landscape URL' },
      { key: 'customLogoUrlPattern', label: 'Custom Logo URL' },
      { key: 'customThumbnailUrlPattern', label: 'Custom Thumbnail URL' },
    ],
  },
  {
    id: 'filters',
    label: 'Filters',
    description: 'Age rating, unreleased and watched titles, and exclusions.',
    fields: [
      { key: 'ageRating', label: 'Age Rating' },
      { key: 'allowUnratedContent', label: 'Allow Unrated Content' },
      { key: 'sfw', label: 'SFW Mode' },
      { key: 'hideUnreleasedDigital', label: 'Hide Unreleased Movies' },
      { key: 'hideUnreleasedDigitalSearch', label: 'Hide Unreleased Movies in Search' },
      { key: 'hideUnreleasedShows', label: 'Hide Unreleased Shows' },
      { key: 'hideUnreleasedShowsSearch', label: 'Hide Unreleased Shows in Search' },
      { key: 'hideWatchedTrakt', label: 'Hide Watched (Trakt)' },
      { key: 'hideWatchedAnilist', label: 'Hide Watched (AniList)' },
      { key: 'hideWatchedMdblist', label: 'Hide Watched (MDBList)' },
      { key: 'hideWatchedSimkl', label: 'Hide Watched (Simkl)' },
      { key: 'exclusionKeywords', label: 'Excluded Keywords' },
      { key: 'regexExclusionFilter', label: 'Regex Exclusion Filter' },
      { key: 'exclusionGenres', label: 'Excluded Genres' },
      { key: 'exclusionTmdbKeywords', label: 'Excluded TMDB Keywords' },
    ],
  },
  {
    id: 'search',
    label: 'Search',
    description: 'Search engines, AI search and the AI catalog model.',
    fields: [
      { key: 'searchEnabled', label: 'Search Enabled' },
      { key: 'search', label: 'Search Settings' },
      { key: 'ai_catalog', label: 'AI Catalog Model' },
    ],
  },
  {
    id: 'catalogs',
    label: 'Catalogs',
    description: 'Catalogs, their order, tags, collections and streaming services.',
    extendable: true,
    fields: [
      { key: 'catalogs', label: 'Catalogs', identity: (c) => `${c?.id}-${c?.type}` },
      { key: 'tags', label: 'Tags', identity: (t) => String(t?.name ?? '').toLowerCase() },
      { key: 'collections', label: 'Collections' },
      { key: 'collectionImagesViaCache', label: 'Collection Images via Cache' },
      { key: 'streaming', label: 'Streaming Services' },
      { key: 'showDisabledCatalogs', label: 'Show Disabled Catalogs' },
    ],
  },
];

const FIELDS = new Map<string, ParentField>(PARENT_SECTIONS.flatMap((s) => s.fields.map((f) => [f.key, f] as const)));
const STRATEGIES = new Set<string>(['inherit', 'extend', 'override']);

export function parentField(key: string): ParentField | undefined {
  return FIELDS.get(key);
}

/** Keeps known sections and fields with valid strategies; `null` when the link itself is unusable. */
export function normalizeParentLink(link: any): ParentConfigLink | null {
  if (!link || typeof link !== 'object') return null;
  const uuid = typeof link.uuid === 'string' ? link.uuid.trim() : '';
  const password = typeof link.password === 'string' ? link.password : '';
  if (!uuid || !password) return null;

  const raw = link.mergeStrategies && typeof link.mergeStrategies === 'object' ? link.mergeStrategies : {};
  const mergeStrategies: ParentConfigLink['mergeStrategies'] = {};
  for (const section of PARENT_SECTIONS) {
    const value = raw[section.id];
    if (STRATEGIES.has(value) && (value !== 'extend' || section.extendable)) mergeStrategies[section.id] = value;
  }
  const fieldOverrides: Record<string, MergeStrategy> = {};
  for (const [key, value] of Object.entries(raw.fieldOverrides ?? {})) {
    const field = FIELDS.get(key);
    if (field && STRATEGIES.has(value as string) && (value !== 'extend' || field.identity)) {
      fieldOverrides[key] = value as MergeStrategy;
    }
  }
  if (Object.keys(fieldOverrides).length > 0) mergeStrategies.fieldOverrides = fieldOverrides;
  return { uuid, password, mergeStrategies };
}

/** The strategy one field ends up with: its own override, else its section's, else inherit. */
export function fieldStrategy(link: ParentConfigLink | undefined, sectionId: ParentSectionId, key: string): MergeStrategy {
  const strategies = link?.mergeStrategies;
  return strategies?.fieldOverrides?.[key] ?? strategies?.[sectionId] ?? 'inherit';
}

function read(config: any, key: string): any {
  const dot = key.indexOf('.');
  return dot === -1 ? config?.[key] : config?.[key.slice(0, dot)]?.[key.slice(dot + 1)];
}

function write(config: any, key: string, value: any): void {
  const dot = key.indexOf('.');
  const target = dot === -1 ? config : config[key.slice(0, dot)];
  const name = dot === -1 ? key : key.slice(dot + 1);
  if (value === undefined) delete target[name];
  else target[name] = value;
}

/** The parent's entries in their order, then the child's that the parent does not have. */
function extendList(parentList: any, childList: any, identity: (item: any) => string): any[] {
  const parentItems = Array.isArray(parentList) ? parentList : [];
  const seen = new Set(parentItems.map(identity));
  const added = (Array.isArray(childList) ? childList : []).filter((item) => !seen.has(identity(item)));
  return [...parentItems, ...added];
}

/**
 * The child's config with the parent's settings applied. `parent` is the parent's
 * own stored config: a parent's parent is never followed. The result carries no
 * parentConfig, so the parent's password never travels with a route's config.
 */
export function mergeParentConfig(parent: any, child: any): any {
  const link = normalizeParentLink(child?.parentConfig) ?? undefined;
  const result: any = { ...child, apiKeys: { ...(child?.apiKeys ?? {}) } };
  delete result.parentConfig;

  for (const section of PARENT_SECTIONS) {
    for (const field of section.fields) {
      const strategy = fieldStrategy(link, section.id, field.key);
      if (strategy === 'override') continue;
      const value = strategy === 'extend' && field.identity
        ? extendList(read(parent, field.key), read(child, field.key), field.identity)
        // Extend means "add mine" only for lists; a section's other settings follow the parent.
        : read(parent, field.key);
      write(result, field.key, value);
    }
  }

  // A parent edit must look like a new config to clients that cache by version.
  const version = Math.max(Number(child?.configVersion) || 0, Number(parent?.configVersion) || 0);
  if (version) result.configVersion = version;
  return result;
}
