export const MOVIE_RATING_HIERARCHY = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
export const TV_RATING_HIERARCHY = ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'];
export const MOVIE_TO_TV_RATING: Record<string, string> = {
  'G': 'TV-G',
  'PG': 'TV-PG',
  'PG-13': 'TV-14',
  'R': 'TV-MA',
  'NC-17': 'TV-MA',
};

const MAL_RATING_TO_MPAA: Record<string, string> = {
  'G': 'G',
  'PG': 'PG',
  'PG-13': 'PG-13',
  'R': 'R',
  'R+': 'NC-17',
  'RX': 'NC-17',
};

/** Jikan spells a rating as "PG-13 - Teens 13 or older"; only the prefix is the rating. */
export function malRatingToCertification(rating: unknown): string | null {
  if (typeof rating !== 'string' || !rating.trim()) return null;
  const prefix = rating.split(' - ')[0].trim().toUpperCase();
  return MAL_RATING_TO_MPAA[prefix] || null;
}

/**
 * TMDB spells "no rating information" as NR or UR and lists it at order 0 of a
 * country's own scale, so these are the absence of a rating rather than one of its
 * steps. 14 countries use NR and 2 use UR; the rest are spellings seen in the wild.
 */
const UNRATED_CERTIFICATIONS = new Set(['NR', 'UR', 'UNRATED', 'NOT RATED', 'N/A', 'NONE']);

export function isUnratedCertification(certification: unknown): boolean {
  const value = typeof certification === 'string' ? certification.trim() : '';
  return value === '' || UNRATED_CERTIFICATIONS.has(value.toUpperCase());
}

export function hasAgeRatingCap(config: { ageRating?: unknown } | null | undefined): boolean {
  const cap = config?.ageRating;
  return typeof cap === 'string' && cap !== '' && cap.toLowerCase() !== 'none';
}

export function stripCertificationLinks(links: any[], certification: string): any[] {
  if (!Array.isArray(links) || !certification) return links;
  return links.filter((link: any) => !(link?.name === certification && link?.category === 'Genres'));
}

/**
 * Clients read an age rating off the first of `meta.links`, so the certification has to
 * be restated there. Idempotent: any chip already present is stripped before the current
 * one is prepended, which lets a meta be projected more than once without stacking.
 */
export function applyDisplayAgeRatingProjection(meta: any, config: any): any {
  const certification = meta?.app_extras?.certification;
  if (!certification) return meta;
  const displayCert = meta?.app_extras?.certificationLocal || certification;
  const links = Array.isArray(meta.links) ? stripCertificationLinks(meta.links, certification).filter((l: any) => !(l?.name === displayCert && l?.category === 'Genres')) : [];
  if (config.displayAgeRating) {
    const imdbId = meta.id?.match(/^tt\d+/)?.[0] || meta.imdb_id || meta._imdbId;
    const tmdbPath = meta.type === 'series' ? 'tv' : 'movie';
    const url = imdbId
      ? `https://www.imdb.com/title/${imdbId}/parentalguide/`
      : `https://www.themoviedb.org/${tmdbPath}/${meta.id}`;
    meta.links = [{ name: displayCert, category: 'Genres', url }, ...links];
  } else if (Array.isArray(meta.links)) {
    meta.links = links;
  }
  return meta;
}

/**
 * Catalog rows carry no certification at all, so treating unknown as blocked empties
 * them outright. Opting out is the strict reading and stays available.
 */
export function allowsUnrated(config: { allowUnratedContent?: unknown } | null | undefined): boolean {
  return config?.allowUnratedContent !== false;
}

export function passesAgeRating(
  certification: string | null | undefined,
  type: string,
  ageRating: string,
  allowUnrated: boolean = true
): boolean {
  const isTvRating = type === 'series';
  const userRating = isTvRating ? (MOVIE_TO_TV_RATING[ageRating] || ageRating) : ageRating;

  if (isUnratedCertification(certification)) {
    return allowUnrated;
  }

  // A certification does not always use the scale its media type implies: MAL hands back
  // MPAA ratings for series. Compare on whichever scale actually carries it.
  let hierarchy = isTvRating ? TV_RATING_HIERARCHY : MOVIE_RATING_HIERARCHY;
  let cap = userRating;
  if (hierarchy.indexOf(certification) === -1) {
    const other = isTvRating ? MOVIE_RATING_HIERARCHY : TV_RATING_HIERARCHY;
    if (other.indexOf(certification) !== -1) {
      hierarchy = other;
      cap = isTvRating ? ageRating : (MOVIE_TO_TV_RATING[ageRating] || ageRating);
    }
  }

  const userRatingIndex = hierarchy.indexOf(cap);
  const resultRatingIndex = hierarchy.indexOf(certification);
  if (userRatingIndex === -1 || resultRatingIndex === -1) return true;
  return resultRatingIndex <= userRatingIndex;
}

/**
 * Spellings an install URL may use for a cap, mapped onto the scale it is stored on.
 * The TV scale collapses onto the nearest MPAA step, and TV-MA lands on R rather than
 * NC-17 because the reverse mapping is lossy and the stricter reading is the safe one.
 */
const RATING_OVERRIDE_ALIASES: Record<string, string> = {
  'NONE': 'None',
  'G': 'G',
  'PG': 'PG',
  'PG13': 'PG-13',
  'PG-13': 'PG-13',
  'R': 'R',
  'NC17': 'NC-17',
  'NC-17': 'NC-17',
  'R18': 'NC-17',
  'R+': 'NC-17',
  'RX': 'NC-17',
  'TV-Y': 'G',
  'TV-Y7': 'G',
  'TV-G': 'G',
  'TV-PG': 'PG',
  'TV-14': 'PG-13',
  'TV-MA': 'R',
};

/** How permissive a cap is. An absent or "None" cap permits everything. */
function capRank(rating: string | null | undefined): number {
  if (typeof rating !== 'string' || !rating.trim() || rating.trim().toLowerCase() === 'none') {
    return MOVIE_RATING_HIERARCHY.length;
  }
  const index = MOVIE_RATING_HIERARCHY.indexOf(rating.trim());
  return index === -1 ? MOVIE_RATING_HIERARCHY.length : index;
}

/** Spellings an install URL may use for the unrated switch. */
const UNRATED_CHOICES: Record<string, boolean> = {
  HIDE: false, EXCLUDE: false, OFF: false, NO: false, FALSE: false, '0': false,
  SHOW: true, INCLUDE: true, ON: true, YES: true, TRUE: true, '1': true,
};

/**
 * Whether an install URL asks for titles with no rating to be hidden. Like the cap it
 * may only tighten, so a config that already hides them cannot be talked into showing
 * them by editing the URL. `null` means the saved setting stands.
 */
export function resolveUnratedOverride(
  config: { ageRating?: unknown; allowUnratedContent?: unknown } | null | undefined,
  raw: unknown
): { allowUnrated: boolean | null; refused: string[] } {
  const values = queryValues(raw);
  if (values.length === 0) return { allowUnrated: null, refused: [] };

  // A config that filters nothing is not restricting anything, so the switch it holds
  // is leftover state rather than intent: the picker is hidden while the cap is None.
  // Only treat it as a restriction the URL may not undo once a cap is actually set.
  const stored = hasAgeRatingCap(config) ? allowsUnrated(config) : true;
  let allowUnrated: boolean | null = null;
  const refused: string[] = [];
  for (const value of values) {
    const choice = UNRATED_CHOICES[value.toUpperCase()];
    if (choice === undefined || (choice && !stored)) {
      refused.push(value);
      continue;
    }
    if (!choice) allowUnrated = false;
  }
  return { allowUnrated, refused };
}

/** A single ?contentrating= value, or null when it names nothing recognisable. */
export function parseRatingOverride(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toUpperCase();
  return RATING_OVERRIDE_ALIASES[key] || null;
}

/**
 * Works out the cap an install URL asks for. The override may only tighten what the
 * stored config allows: it is the mechanism behind a kids install off a shared UUID,
 * so letting it loosen would mean anyone who can edit the URL can lift the limit.
 * Anything unrecognised or more permissive is refused rather than approximated, and
 * several values resolve to the strictest of them.
 */
function queryValues(raw: unknown): string[] {
  return (raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw])
    .filter((value: any) => typeof value === 'string' && value.trim())
    .map((value: string) => value.trim());
}

export function resolveRatingOverride(
  config: { ageRating?: unknown } | null | undefined,
  raw: unknown
): { rating: string | null; requested: string[]; refused: string[] } {
  const values = queryValues(raw);
  if (values.length === 0) return { rating: null, requested: [], refused: [] };

  const stored = typeof config?.ageRating === 'string' ? config.ageRating : null;
  const storedRank = capRank(stored);

  let rating: string | null = null;
  const refused: string[] = [];
  for (const value of values) {
    const parsed = parseRatingOverride(value);
    if (!parsed || capRank(parsed) >= storedRank) {
      refused.push(value);
      continue;
    }
    if (rating === null || capRank(parsed) < capRank(rating)) rating = parsed;
  }
  return { rating, requested: values, refused };
}

export interface InstallFilterTag {
  name: string;
  ageRating?: unknown;
  allowUnratedContent?: unknown;
}

/**
 * A tag carries the limit it was created for, so installing a profile brings its own
 * cap with it rather than leaving one to be aimed at catalogs by hand. Several tags
 * resolve to the strictest of them, which the resolvers below already do.
 */
function tagFilters(
  config: { tags?: unknown } | null | undefined,
  tags: string[]
): { ratings: string[]; hidesUnrated: boolean } {
  const defined = new Map<string, InstallFilterTag>();
  for (const tag of (Array.isArray(config?.tags) ? config!.tags as InstallFilterTag[] : [])) {
    if (tag?.name) defined.set(String(tag.name).toLowerCase(), tag);
  }

  const ratings: string[] = [];
  let hidesUnrated = false;
  for (const name of tags) {
    const tag = defined.get(name.toLowerCase());
    if (!tag) continue;
    if (typeof tag.ageRating === 'string' && tag.ageRating.trim() && tag.ageRating !== 'None') {
      ratings.push(tag.ageRating.trim());
    }
    if (tag.allowUnratedContent === false) hidesUnrated = true;
  }
  return { ratings, hidesUnrated };
}

/**
 * The rating every named profile agrees on, or null when they disagree. Used for the
 * addon name, which must not claim a cap that only part of the install carries.
 */
export function uniformTagRating(
  config: { tags?: unknown } | null | undefined,
  tags: string[]
): string | null {
  if (tags.length === 0) return null;
  const defined = new Map<string, InstallFilterTag>();
  for (const tag of (Array.isArray(config?.tags) ? config!.tags as InstallFilterTag[] : [])) {
    if (tag?.name) defined.set(String(tag.name).toLowerCase(), tag);
  }
  const seen = new Set<string>();
  for (const name of tags) {
    const raw = defined.get(name.toLowerCase())?.ageRating;
    const rating = typeof raw === 'string' && raw.trim() ? raw.trim() : 'None';
    seen.add(rating === 'None' ? 'None' : rating);
  }
  if (seen.size !== 1) return null;
  const only = [...seen][0];
  return only === 'None' ? null : only;
}

/**
 * Everything an install URL says about filtering, from the tags it names and from the
 * raw parameters, resolved together so the strictest wins and nothing may loosen what
 * the saved config already enforces.
 */
export function resolveInstallFilters(
  config: { ageRating?: unknown; allowUnratedContent?: unknown; tags?: unknown } | null | undefined,
  input: { rating?: unknown; unrated?: unknown; tags?: string[] }
): { ageRating: string | null; allowUnrated: boolean | null; refused: string[] } {
  const fromTags = tagFilters(config, input.tags || []);
  const rating = resolveRatingOverride(config, [...fromTags.ratings, ...queryValues(input.rating)]);
  const unrated = resolveUnratedOverride(config, [
    ...(fromTags.hidesUnrated ? ['hide'] : []),
    ...queryValues(input.unrated),
  ]);
  return {
    ageRating: rating.rating,
    allowUnrated: unrated.allowUnrated,
    refused: [...rating.refused, ...unrated.refused],
  };
}

/**
 * The profiles that decide this catalog's limit: the ones it is actually in, out of
 * those the URL named. A row that belongs only to an unrestricted profile must not
 * inherit the cap of another profile installed alongside it. Rows outside the user's
 * catalog list, search among them, fall back to every named profile, so the strictest
 * one wins rather than none of them.
 */
export function scopeTagsToCatalog(config: any, tags: string[], id: string, type: string): string[] {
  if (tags.length === 0) return tags;
  const catalogs = config.catalogs || [];
  const matches = (c: any) => c.id === id && (c.type === type || c.displayType === type);
  const stripped = String(id).replace(/_(movie|series|anime|all)$/, '');
  const catalog = catalogs.find(matches)
    || (stripped === id ? null : catalogs.find((c: any) => c.id === stripped && (c.type === type || c.displayType === type)));

  const own = Array.isArray(catalog?.tags) ? catalog.tags.map((t: any) => String(t).toLowerCase()) : [];
  if (own.length === 0) return tags;
  const scoped = tags.filter(t => own.includes(t.toLowerCase()));
  return scoped.length > 0 ? scoped : tags;
}
