import consola from 'consola';
import type { AICatalogOutput, ValidationResult } from './ai-catalog-schema';
import {
  CATALOG_TYPE_TO_SIMKL_MEDIA,
  getAllowedCatalogParams,
  getCatalogSorts,
  getSourceSchema,
  MAL_GENRE_NAMES,
  SIMKL_MEDIA_TO_CATALOG_TYPE,
  SOURCE_SCHEMAS,
  SORT_CORRECTIONS,
  TMDB_GENRE_NAMES,
  VALID_TMDB_MOVIE_GENRES,
  VALID_TMDB_TV_GENRES,
  VALID_SOURCES,
} from './ai-catalog-schema';

const logger = consola.withTag('AICatalog');

interface NormalizeCatalogOptions {
  originalQuery?: string;
  now?: Date;
}

export function isPlainObject(value: any): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function splitParamValues(value: any, separator: RegExp = /[|,]/): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).split(separator).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

export function isPositiveIntegerString(value: string): boolean {
  return /^\d+$/.test(value.trim()) && Number(value) > 0;
}

export function mergeResolveValues(catalog: AICatalogOutput, key: string, values: string[]): void {
  const cleaned = values.map((value) => value.trim()).filter(Boolean);
  if (!cleaned.length) return;
  if (!catalog.resolve) catalog.resolve = {};
  if (!catalog.resolve[key]) catalog.resolve[key] = [];
  catalog.resolve[key].push(...cleaned);
}

export function moveNamedIdParamToResolve(catalog: AICatalogOutput, paramKey: string, resolveKey: string, separator: string = ','): string[] {
  if (catalog.params[paramKey] === undefined) return [];

  const values = splitParamValues(catalog.params[paramKey]);
  const idValues = values.filter(isPositiveIntegerString);
  const namedValues = values.filter((value) => !isPositiveIntegerString(value));

  if (namedValues.length) {
    mergeResolveValues(catalog, resolveKey, namedValues);
  }

  if (idValues.length) {
    catalog.params[paramKey] = idValues.join(separator);
  } else {
    delete catalog.params[paramKey];
  }

  return namedValues;
}

export function coerceBooleanParam(params: Record<string, any>, key: string): void {
  const value = params[key];
  if (typeof value === 'boolean') return;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') params[key] = true;
    if (normalized === 'false') params[key] = false;
  }
}

export function coerceNumberParam(params: Record<string, any>, key: string, integer = false): void {
  const value = params[key];
  if (typeof value === 'number') return;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) params[key] = integer ? Math.floor(parsed) : parsed;
  }
}

export function canonicalEnumValue(value: any, validValues: readonly string[]): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  return validValues.find((valid) => valid.toLowerCase() === normalized.toLowerCase()) || null;
}

export function coerceEnumParam(params: Record<string, any>, key: string, validValues: readonly string[]): void {
  const canonical = canonicalEnumValue(params[key], validValues);
  if (canonical) params[key] = canonical;
}

export function coerceDelimitedEnumParam(params: Record<string, any>, key: string, validValues: readonly string[]): void {
  if (params[key] === undefined) return;
  const values = splitParamValues(params[key], /,/);
  if (!values.length) {
    delete params[key];
    return;
  }
  params[key] = values.map((value) => canonicalEnumValue(value, validValues) || value).join(',');
}

function normalizeDelimitedEnumParam(params: Record<string, any>, key: string, validValues: readonly string[]): { valid: string[]; invalid: string[] } {
  if (params[key] === undefined) return { valid: [], invalid: [] };
  const values = splitParamValues(params[key], /,/);
  const valid: string[] = [];
  const invalid: string[] = [];

  for (const value of values) {
    const canonical = canonicalEnumValue(value, validValues);
    if (canonical) {
      valid.push(canonical);
    } else {
      invalid.push(value);
    }
  }

  if (valid.length) {
    params[key] = valid.join(',');
  } else {
    delete params[key];
  }

  return { valid, invalid };
}

export function normalizeDelimitedStringParam(params: Record<string, any>, key: string): void {
  if (params[key] === undefined) return;
  const values = splitParamValues(params[key], /,/);
  if (values.length) {
    params[key] = values.join(',');
  } else {
    delete params[key];
  }
}

export function coerceSingleEnumParam(params: Record<string, any>, key: string, validValues: readonly string[]): string | null {
  if (params[key] === undefined) return null;

  const rawValue = params[key];
  const canonical = canonicalEnumValue(params[key], validValues);
  if (canonical) {
    params[key] = canonical;
    return null;
  }

  const validDelimitedValues = splitParamValues(params[key], /,/)
    .map((value) => canonicalEnumValue(value, validValues))
    .filter((value): value is string => !!value);

  if (validDelimitedValues.length === 1) {
    params[key] = validDelimitedValues[0];
    return null;
  }

  if (validDelimitedValues.length > 1) {
    delete params[key];
    return `Removed multi-value ${key}: ${validDelimitedValues.join(', ')}`;
  }

  delete params[key];
  return `Removed invalid ${key}: ${rawValue}`;
}

export function isIsoDate(value: any): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function coerceIsoDateParam(params: Record<string, any>, key: string): void {
  if (typeof params[key] === 'string' && /^\d{8}$/.test(params[key])) {
    params[key] = params[key].replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  }
}

export function coerceFuzzyDateParam(params: Record<string, any>, key: string): void {
  if (typeof params[key] === 'string') {
    params[key] = params[key].trim().replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1$2$3');
  }
}

export function isFuzzyDate(value: any): boolean {
  const text = String(value ?? '');
  return /^\d{8}$/.test(text);
}

export function validateNumberRange(errors: string[], params: Record<string, any>, key: string, min: number, max: number, integer = false): void {
  if (params[key] === undefined) return;
  if (typeof params[key] === 'string' && !params[key].trim()) {
    errors.push(`${key} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
    return;
  }
  const value = Number(params[key]);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    errors.push(`${key} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
}

export function validateEnum(errors: string[], params: Record<string, any>, key: string, validValues: readonly string[], label: string): void {
  if (params[key] !== undefined && !validValues.includes(params[key])) {
    errors.push(`Invalid ${label}: ${params[key]}`);
  }
}

export function validateDelimitedEnum(errors: string[], params: Record<string, any>, key: string, validValues: readonly string[], label: string): void {
  if (params[key] === undefined) return;
  for (const value of splitParamValues(params[key], /,/)) {
    if (!validValues.includes(value)) {
      errors.push(`Invalid ${label}: ${value}`);
    }
  }
}

function getAllowedParamsForCatalog(catalog: AICatalogOutput): ReadonlySet<string> | null {
  return getAllowedCatalogParams(catalog.source, catalog.catalogType, catalog.params);
}

const ALLOWED_RESOLVE_KEYS: Record<string, ReadonlySet<string>> = {
  tmdb: new Set(['genres', 'excludeGenres', 'genreMode', 'excludeGenreMode', 'keywords', 'excludeKeywords', 'companies', 'cast', 'people', 'watchProviders', 'networks']),
  anilist: new Set(['studios']),
  mal: new Set(['producers']),
  tvdb: new Set(['company', 'genre', 'status', 'contentRating']),
  simkl: new Set([]),
};

interface TmdbGenreRepairRule {
  genreIds?: number[];
  keywords?: string[];
  drop?: boolean;
}

const TMDB_MOVIE_GENRE_TO_TV_REPAIR: Record<number, TmdbGenreRepairRule> = {
  12: { genreIds: [10759] },
  14: { genreIds: [10765] },
  27: { keywords: ['horror'] },
  28: { genreIds: [10759] },
  36: { keywords: ['history'] },
  53: { keywords: ['thriller'] },
  878: { genreIds: [10765] },
  10402: { keywords: ['music'] },
  10749: { keywords: ['romance'] },
  10752: { genreIds: [10768] },
  10770: { drop: true },
};

const TMDB_TV_GENRE_TO_MOVIE_REPAIR: Record<number, TmdbGenreRepairRule> = {
  10759: { genreIds: [28, 12] },
  10762: { genreIds: [10751] },
  10763: { keywords: ['news'] },
  10764: { keywords: ['reality'] },
  10765: { genreIds: [878, 14] },
  10766: { keywords: ['soap opera'] },
  10767: { keywords: ['talk show'] },
  10768: { genreIds: [10752], keywords: ['politics'] },
};

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatFuzzyDate(date: Date): string {
  return formatIsoDate(date).replace(/-/g, '');
}

function subtractYears(date: Date, years: number): Date {
  const next = new Date(date.getTime());
  next.setUTCFullYear(next.getUTCFullYear() - years);
  return next;
}

function parseRelativeYearWindow(query: string, now: Date): { isoStart: string; fuzzyStart: string } | null {
  const match = query.match(/\blast\s+(\d{1,2})\s+years?\b/i);
  if (!match) return null;
  const years = Number(match[1]);
  if (!Number.isInteger(years) || years <= 0 || years > 99) return null;
  const start = subtractYears(now, years);
  return { isoStart: formatIsoDate(start), fuzzyStart: formatFuzzyDate(start) };
}

function parseDecadeWindow(query: string): { startYear: number; endYear: number; isoStart: string; isoEnd: string; fuzzyStart: string; fuzzyEnd: string } | null {
  const match = query.match(/\b((?:19|20)\d0)s\b/i);
  if (!match) return null;
  const startYear = Number(match[1]);
  const endYear = startYear + 9;
  return {
    startYear,
    endYear,
    isoStart: `${startYear}-01-01`,
    isoEnd: `${endYear}-12-31`,
    fuzzyStart: `${startYear}0101`,
    fuzzyEnd: `${endYear}1231`,
  };
}

function parseFromYearWindow(query: string): { year: number; isoStart: string; fuzzyStart: string } | null {
  const match = query.match(/\bfrom\s+((?:19|20)\d{2})\s+(?:onwards?|or later|and later)\b/i) || query.match(/\b((?:19|20)\d{2})\+\b/);
  if (!match) return null;
  const year = Number(match[1]);
  return { year, isoStart: `${year}-01-01`, fuzzyStart: `${year}0101` };
}

function applyQueryDateRepairs(catalog: AICatalogOutput, options: NormalizeCatalogOptions, diagnostics: string[]): void {
  const query = options.originalQuery?.trim();
  if (!query) return;

  const now = options.now || new Date();
  const today = formatIsoDate(now);
  const relative = parseRelativeYearWindow(query, now);
  const decade = parseDecadeWindow(query);
  const fromYear = parseFromYearWindow(query);

  if (catalog.source === 'tmdb') {
    const startKey = catalog.catalogType === 'series' ? 'first_air_date.gte' : 'primary_release_date.gte';
    const endKey = catalog.catalogType === 'series' ? 'first_air_date.lte' : 'primary_release_date.lte';
    if (relative) {
      catalog.params[startKey] = relative.isoStart;
      const addedEnd = catalog.params[endKey] === undefined;
      if (addedEnd) catalog.params[endKey] = today;
      diagnostics.push(`Repaired TMDB relative date range for "${catalog.name}" from query: ${startKey}=${relative.isoStart}${addedEnd ? `, ${endKey}=${today}` : ''}`);
    } else if (decade) {
      catalog.params[startKey] = decade.isoStart;
      catalog.params[endKey] = decade.isoEnd;
      diagnostics.push(`Repaired TMDB decade date range for "${catalog.name}" from query: ${decade.startYear}s`);
    } else if (fromYear) {
      catalog.params[startKey] = fromYear.isoStart;
      diagnostics.push(`Repaired TMDB from-year date range for "${catalog.name}" from query: ${fromYear.year}+`);
    }
  }

  if (catalog.source === 'anilist') {
    if (relative) {
      catalog.params.startDate_greater = relative.fuzzyStart;
      diagnostics.push(`Repaired AniList relative date range for "${catalog.name}" from query: startDate_greater=${relative.fuzzyStart}`);
    } else if (decade) {
      catalog.params.startDate_greater = decade.fuzzyStart;
      catalog.params.startDate_lesser = decade.fuzzyEnd;
      delete catalog.params.seasonYear;
      diagnostics.push(`Repaired AniList decade date range for "${catalog.name}" from query: ${decade.startYear}s`);
    } else if (fromYear) {
      catalog.params.startDate_greater = fromYear.fuzzyStart;
      delete catalog.params.seasonYear;
      diagnostics.push(`Repaired AniList from-year date range for "${catalog.name}" from query: ${fromYear.year}+`);
    }
  }

  if (catalog.source === 'mal') {
    if (relative) {
      catalog.params.start_date = relative.isoStart;
      diagnostics.push(`Repaired MAL relative date range for "${catalog.name}" from query: start_date=${relative.isoStart}`);
    } else if (decade) {
      catalog.params.start_date = decade.isoStart;
      catalog.params.end_date = decade.isoEnd;
      delete catalog.params.seasonYear;
      diagnostics.push(`Repaired MAL decade date range for "${catalog.name}" from query: ${decade.startYear}s`);
    } else if (fromYear) {
      catalog.params.start_date = fromYear.isoStart;
      delete catalog.params.seasonYear;
      diagnostics.push(`Repaired MAL from-year date range for "${catalog.name}" from query: ${fromYear.year}+`);
    }
  }

  if (catalog.source === 'tvdb' && catalog.params.year && (decade || fromYear || /\bfrom\b/i.test(query))) {
    delete catalog.params.year;
    diagnostics.push(`Removed exact TVDB year from "${catalog.name}" because the query asks for a range TVDB cannot express`);
  }
}

function normalizeResolveValues(value: any): string[] {
  const rawValues = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const values: string[] = [];
  for (const rawValue of rawValues) {
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number') continue;
    const normalized = String(rawValue).trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(normalized);
  }
  return values;
}

function normalizeResolveFields(catalog: AICatalogOutput, diagnostics: string[]): void {
  if (!catalog.resolve || !isPlainObject(catalog.resolve)) {
    delete catalog.resolve;
    return;
  }

  const allowedResolveKeys = ALLOWED_RESOLVE_KEYS[catalog.source];
  const stripped: string[] = [];

  for (const key of Object.keys(catalog.resolve)) {
    const values = normalizeResolveValues(catalog.resolve[key]);
    if (!values.length) {
      delete catalog.resolve[key];
      continue;
    }

    if (allowedResolveKeys && !allowedResolveKeys.has(key)) {
      stripped.push(key);
      delete catalog.resolve[key];
      continue;
    }

    catalog.resolve[key] = values;
  }

  if (stripped.length) {
    diagnostics.push(`Stripped unsupported ${catalog.source} resolve fields from "${catalog.name}": ${stripped.join(', ')}`);
  }

  if (!Object.keys(catalog.resolve).length) {
    delete catalog.resolve;
  }
}

function normalizeCatalogLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TMDB_GENRE_NAME_ALIASES: Record<string, number> = {
  'sci fi': 878,
  'science fiction': 878,
  'sci fi and fantasy': 10765,
  'sci fi fantasy': 10765,
  'action adventure': 10759,
  'war politics': 10768,
  'tv movie': 10770,
};

const TMDB_GENRE_ID_BY_NAME: Record<string, number> = (() => {
  const entries: Record<string, number> = { ...TMDB_GENRE_NAME_ALIASES };
  for (const [rawId, name] of Object.entries(TMDB_GENRE_NAMES)) {
    const id = Number(rawId);
    const normalized = normalizeCatalogLabel(name);
    if (!entries[normalized] || id < entries[normalized]) {
      entries[normalized] = id;
    }
  }
  return entries;
})();

function getTmdbGenreIdByName(value: string): number | null {
  const normalized = normalizeCatalogLabel(value);
  if (!normalized) return null;
  return TMDB_GENRE_ID_BY_NAME[normalized] ?? null;
}

function tmdbGenreNamesFromParam(value: any): Set<string> {
  const names = new Set<string>();
  for (const rawId of splitParamValues(value)) {
    const id = Number(rawId);
    const name = Number.isFinite(id) ? TMDB_GENRE_NAMES[id] : undefined;
    if (name) names.add(normalizeCatalogLabel(name));
  }
  return names;
}

function uniquePush<T>(values: T[], value: T): void {
  if (!values.includes(value)) values.push(value);
}

function normalizeTmdbResolveGenreMode(value: any, fallback: 'and' | 'or'): 'and' | 'or' {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const normalized = String(rawValue || '').trim().toLowerCase();
  if (normalized === 'or' || normalized === 'any' || normalized === '|') return 'or';
  if (normalized === 'and' || normalized === 'all' || normalized === ',') return 'and';
  return fallback;
}

function appendDelimitedParam(params: Record<string, any>, key: string, parts: string[], separator: string): void {
  const cleaned = parts.map((part) => part.trim()).filter(Boolean);
  if (!cleaned.length) return;
  const existing = typeof params[key] === 'string' || typeof params[key] === 'number'
    ? String(params[key]).trim()
    : '';
  params[key] = existing ? `${existing}${separator}${cleaned.join(separator)}` : cleaned.join(separator);
}

function applyTmdbGenreNameResolve(catalog: AICatalogOutput, diagnostics: string[]): void {
  if (!catalog.resolve) return;

  const configs: Array<{
    resolveKey: string;
    modeKey: string;
    paramKey: 'with_genres' | 'without_genres';
    keywordKey: 'keywords' | 'excludeKeywords';
    defaultMode: 'and' | 'or';
  }> = [
    { resolveKey: 'genres', modeKey: 'genreMode', paramKey: 'with_genres', keywordKey: 'keywords', defaultMode: 'and' },
    { resolveKey: 'excludeGenres', modeKey: 'excludeGenreMode', paramKey: 'without_genres', keywordKey: 'excludeKeywords', defaultMode: 'or' },
  ];

  const validGenres = catalog.catalogType === 'movie' ? VALID_TMDB_MOVIE_GENRES : VALID_TMDB_TV_GENRES;
  const repairRules = catalog.catalogType === 'movie' ? TMDB_TV_GENRE_TO_MOVIE_REPAIR : TMDB_MOVIE_GENRE_TO_TV_REPAIR;

  for (const config of configs) {
    const rawValues = catalog.resolve[config.resolveKey];
    if (!rawValues?.length) {
      delete catalog.resolve[config.modeKey];
      continue;
    }

    const mode = normalizeTmdbResolveGenreMode(catalog.resolve[config.modeKey], config.defaultMode);
    const separator = mode === 'or' ? '|' : ',';
    const values = splitParamValues(rawValues, /[|,]/);
    const genreParts: string[] = [];
    const keywords: string[] = [];
    const mapped: string[] = [];
    const invalid: string[] = [];

    for (const value of values) {
      const asId = isPositiveIntegerString(value) ? Number(value) : null;
      const id = asId || getTmdbGenreIdByName(value);
      if (!id) {
        invalid.push(value);
        continue;
      }

      const name = TMDB_GENRE_NAMES[id] || value;
      if (validGenres.has(id)) {
        uniquePush(genreParts, String(id));
        mapped.push(`${value} -> ${id}=${name}`);
        continue;
      }

      const rule = repairRules[id];
      if (!rule) {
        invalid.push(value);
        continue;
      }

      const targets: string[] = [];
      const targetGenreIds = (rule.genreIds || []).filter((targetId) => validGenres.has(targetId));
      if (targetGenreIds.length) {
        const part = targetGenreIds.length > 1 ? targetGenreIds.join('|') : String(targetGenreIds[0]);
        uniquePush(genreParts, part);
        targets.push(...targetGenreIds.map((targetId) => `${targetId}=${TMDB_GENRE_NAMES[targetId] || `Genre ${targetId}`}`));
      }
      for (const keyword of rule.keywords || []) {
        uniquePush(keywords, keyword);
        targets.push(`keyword "${keyword}"`);
      }
      if (rule.drop) targets.push('dropped');
      mapped.push(`${value} -> ${targets.join(' + ')}`);
    }

    appendDelimitedParam(catalog.params, config.paramKey, genreParts, separator);
    if (keywords.length) mergeResolveValues(catalog, config.keywordKey, keywords);

    delete catalog.resolve[config.resolveKey];
    delete catalog.resolve[config.modeKey];

    if (mapped.length) {
      diagnostics.push(`Resolved TMDB ${config.resolveKey} names for "${catalog.name}": ${mapped.join(', ')}`);
    }
    if (invalid.length) {
      diagnostics.push(`Removed invalid TMDB ${config.resolveKey} names for "${catalog.name}": ${invalid.join(', ')}`);
    }
  }
}

function repairTmdbGenreParam(catalog: AICatalogOutput, field: 'with_genres' | 'without_genres', diagnostics: string[]): void {
  if (catalog.params[field] === undefined) return;

  const rawValue = catalog.params[field];
  const values = splitParamValues(rawValue);
  if (!values.length) {
    delete catalog.params[field];
    return;
  }

  const validGenres = catalog.catalogType === 'movie' ? VALID_TMDB_MOVIE_GENRES : VALID_TMDB_TV_GENRES;
  const repairRules = catalog.catalogType === 'movie' ? TMDB_TV_GENRE_TO_MOVIE_REPAIR : TMDB_MOVIE_GENRE_TO_TV_REPAIR;
  const genreParts: string[] = [];
  const seenGenreParts = new Set<string>();
  const keywords: string[] = [];
  const repairs: string[] = [];
  const invalid: string[] = [];

  const pushGenrePart = (part: string): void => {
    if (seenGenreParts.has(part)) return;
    seenGenreParts.add(part);
    genreParts.push(part);
  };

  for (const rawId of values) {
    const id = Number(rawId);
    if (!Number.isInteger(id)) {
      invalid.push(rawId);
      continue;
    }

    if (validGenres.has(id)) {
      pushGenrePart(String(id));
      continue;
    }

    const name = TMDB_GENRE_NAMES[id] || `Genre ${id}`;
    const rule = repairRules[id];
    if (!rule) {
      invalid.push(`${id}=${name}`);
      continue;
    }

    const targets: string[] = [];
    const targetGenreIds = (rule.genreIds || []).filter((targetId) => validGenres.has(targetId));
    if (targetGenreIds.length) {
      pushGenrePart(targetGenreIds.length > 1 ? targetGenreIds.join('|') : String(targetGenreIds[0]));
      targets.push(...targetGenreIds.map((targetId) => `${targetId}=${TMDB_GENRE_NAMES[targetId] || `Genre ${targetId}`}`));
    }
    for (const keyword of rule.keywords || []) {
      uniquePush(keywords, keyword);
      targets.push(`keyword "${keyword}"`);
    }
    if (rule.drop) targets.push('dropped');
    repairs.push(`${id}=${name} -> ${targets.join(' + ')}`);
  }

  const sep = String(rawValue).includes('|') ? '|' : ',';
  if (genreParts.length) {
    catalog.params[field] = genreParts.join(sep);
  } else {
    delete catalog.params[field];
  }

  if (keywords.length) {
    const resolveField = field === 'with_genres' ? 'keywords' : 'excludeKeywords';
    mergeResolveValues(catalog, resolveField, keywords);
  }

  if (repairs.length) {
    diagnostics.push(`Repaired TMDB ${field} cross-media genres for "${catalog.name}": ${repairs.join(', ')}`);
  }
  if (invalid.length) {
    diagnostics.push(`Removed invalid TMDB ${field} values for "${catalog.name}": ${invalid.join(', ')}`);
  }
}

function dropTmdbGenreDuplicateKeywords(catalog: AICatalogOutput, diagnostics: string[]): void {
  if (!catalog.resolve) return;

  const fieldPairs: Array<[string, string]> = [
    ['keywords', 'with_genres'],
    ['excludeKeywords', 'without_genres'],
  ];

  for (const [resolveField, genreParam] of fieldPairs) {
    const values = catalog.resolve[resolveField];
    if (!values?.length || catalog.params[genreParam] === undefined) continue;

    const genreNames = tmdbGenreNamesFromParam(catalog.params[genreParam]);
    if (!genreNames.size) continue;

    const kept: string[] = [];
    const dropped: string[] = [];
    for (const value of values) {
      if (genreNames.has(normalizeCatalogLabel(value))) {
        dropped.push(value);
      } else {
        kept.push(value);
      }
    }

    if (dropped.length) {
      if (kept.length) {
        catalog.resolve[resolveField] = kept;
      } else {
        delete catalog.resolve[resolveField];
      }
      diagnostics.push(`Dropped TMDB ${resolveField} duplicated by ${genreParam} for "${catalog.name}": ${dropped.join(', ')}`);
    }
  }
}

function hasTmdbStrongIncludeConstraint(catalog: AICatalogOutput): boolean {
  const params = catalog.params;
  const constrainedParamFields = [
    'with_companies',
    'with_cast',
    'with_people',
    'with_networks',
    'with_watch_providers',
    'with_keywords',
    'with_origin_country',
    'with_original_language',
    'certification',
    'certification.gte',
    'certification.lte',
    'certification_country',
    'with_runtime.gte',
    'with_runtime.lte',
  ];

  if (constrainedParamFields.some((field) => params[field] !== undefined)) return true;

  const resolve = catalog.resolve;
  if (!resolve) return false;

  return ['companies', 'cast', 'people', 'networks', 'watchProviders', 'keywords'].some((field) => {
    const values = resolve[field];
    return Array.isArray(values) && values.length > 0;
  });
}

function applyTmdbVoteFloorDefaults(catalog: AICatalogOutput, diagnostics: string[]): void {
  const params = catalog.params;
  const voteCount = Number(params['vote_count.gte']);
  const hasVoteFloor = params['vote_count.gte'] !== undefined && Number.isFinite(voteCount);
  const constrained = hasTmdbStrongIncludeConstraint(catalog);

  if (params.sort_by === 'vote_average.desc' && !hasVoteFloor) {
    params['vote_count.gte'] = constrained ? 50 : 300;
    diagnostics.push(`Added TMDB vote_count.gte=${params['vote_count.gte']} for "${catalog.name}" because vote_average.desc needs a vote floor`);
    return;
  }

  if (params.sort_by !== 'vote_average.desc' && constrained && hasVoteFloor && voteCount > 50) {
    params['vote_count.gte'] = 10;
    diagnostics.push(`Lowered TMDB vote_count.gte for constrained non-rating catalog "${catalog.name}": ${voteCount} -> 10`);
  }
}

function applyTmdbReleasedDateCaps(catalog: AICatalogOutput, options: NormalizeCatalogOptions, diagnostics: string[]): void {
  if (catalog.source !== 'tmdb') return;

  const params = catalog.params;
  const now = options.now || new Date();
  const today = formatIsoDate(now);
  const currentYear = now.getUTCFullYear();
  const datePrefix = catalog.catalogType === 'series' ? 'first_air_date' : 'primary_release_date';
  const startKey = `${datePrefix}.gte`;
  const endKey = `${datePrefix}.lte`;
  const dateDescSort = catalog.catalogType === 'series' ? 'first_air_date.desc' : 'primary_release_date.desc';

  if (params[endKey] !== undefined) return;

  const start = typeof params[startKey] === 'string' && isIsoDate(params[startKey])
    ? params[startKey]
    : null;

  if (start) {
    const startYear = Number(start.slice(0, 4));
    if (Number.isFinite(startYear) && startYear < currentYear) {
      params[endKey] = today;
      diagnostics.push(`Capped TMDB open date range for "${catalog.name}": ${endKey}=${today}`);
    }
    return;
  }

  if (params.sort_by === dateDescSort) {
    params[endKey] = today;
    diagnostics.push(`Capped TMDB release-date sort for "${catalog.name}": ${endKey}=${today}`);
  }
}

function normalizeSimklEnumParam(
  catalog: AICatalogOutput,
  schema: any,
  key: string,
  diagnostics: string[],
): void {
  if (catalog.params[key] === undefined) return;

  const schemaFieldByParam: Record<string, string> = {
    genre: 'genres',
    type: 'types',
    country: 'countries',
    network: 'networks',
  };
  const validValues = schema?.[schemaFieldByParam[key]];
  if (!validValues) {
    delete catalog.params[key];
    diagnostics.push(`Removed unsupported Simkl ${key} from "${catalog.name}" for media "${catalog.params.media}"`);
    return;
  }

  const original = catalog.params[key];
  const canonical = canonicalEnumValue(original, validValues);
  if (canonical) {
    catalog.params[key] = canonical;
    return;
  }

  delete catalog.params[key];
  diagnostics.push(`Removed invalid Simkl ${key} from "${catalog.name}": ${original}`);
}

function isSimklDecadeYear(value: any): boolean {
  return typeof value === 'string' && /^(?:19|20)\d0s$/.test(value.trim());
}

function normalizeSimklYearParam(catalog: AICatalogOutput, schema: any, diagnostics: string[]): void {
  if (catalog.params.year === undefined) return;

  const original = catalog.params.year;
  const canonical = canonicalEnumValue(original, schema?.yearShortcuts || []);
  if (canonical) {
    catalog.params.year = canonical;
    return;
  }

  if (isSimklDecadeYear(original)) {
    catalog.params.year = String(original).trim().toLowerCase();
    return;
  }

  delete catalog.params.year;
  diagnostics.push(`Removed invalid Simkl year from "${catalog.name}": ${original}`);
}

export function stripUnknownParams(catalog: AICatalogOutput): string[] {
  if (!isPlainObject(catalog.params)) {
    catalog.params = {};
    return [];
  }

  const allowedParams = getAllowedParamsForCatalog(catalog);
  if (!allowedParams) return [];

  const stripped: string[] = [];
  for (const key of Object.keys(catalog.params)) {
    if (!allowedParams.has(key)) {
      stripped.push(key);
      delete catalog.params[key];
    }
  }

  return stripped;
}

export function normalizeCatalogMediaTypes(catalog: AICatalogOutput): void {
  if (catalog.source === 'tmdb') {
    catalog.mediaType = catalog.catalogType === 'series' ? 'tv' : 'movie';
    return;
  }

  if (catalog.source === 'tvdb') {
    catalog.mediaType = catalog.catalogType === 'series' ? 'series' : 'movie';
    return;
  }

  if (catalog.source === 'anilist' || catalog.source === 'mal') {
    catalog.catalogType = 'anime';
    catalog.mediaType = 'anime';
    return;
  }

  if (catalog.source === 'simkl') {
    const rawMedia = typeof catalog.params.media === 'string' ? catalog.params.media.trim().toLowerCase() : '';
    const media = SIMKL_MEDIA_TO_CATALOG_TYPE[rawMedia]
      ? rawMedia
      : CATALOG_TYPE_TO_SIMKL_MEDIA[catalog.catalogType] || 'movies';
    catalog.params.media = media;
    catalog.catalogType = SIMKL_MEDIA_TO_CATALOG_TYPE[media];
    catalog.mediaType = catalog.catalogType;
  }
}

export function normalizeCatalog(catalog: AICatalogOutput, options: NormalizeCatalogOptions = {}): string[] {
  const diagnostics: string[] = [];
  if (!isPlainObject(catalog.params)) catalog.params = {};

  const typeAliases: Record<string, string> = { movies: 'movie', shows: 'series', tv: 'series' };
  if (typeAliases[catalog.catalogType]) catalog.catalogType = typeAliases[catalog.catalogType];
  normalizeCatalogMediaTypes(catalog);

  if (catalog.source === 'tmdb') {
    coerceEnumParam(catalog.params, 'sort_by', getCatalogSorts(catalog.source, catalog.catalogType, catalog.params));
    coerceBooleanParam(catalog.params, 'include_adult');
    coerceBooleanParam(catalog.params, 'include_video');
    for (const field of ['vote_average.gte', 'vote_average.lte', 'vote_count.gte', 'vote_count.lte', 'with_runtime.gte', 'with_runtime.lte', 'primary_release_year', 'first_air_date_year', 'year']) {
      coerceNumberParam(catalog.params, field, field.includes('year') || field.includes('count') || field.includes('runtime'));
    }
    for (const field of ['primary_release_date.gte', 'primary_release_date.lte', 'first_air_date.gte', 'first_air_date.lte', 'air_date.gte', 'air_date.lte', 'release_date.gte', 'release_date.lte']) {
      coerceIsoDateParam(catalog.params, field);
    }

    const corrections = SORT_CORRECTIONS[catalog.catalogType];
    if (corrections && catalog.params.sort_by && corrections[catalog.params.sort_by]) {
      const originalSort = catalog.params.sort_by;
      catalog.params.sort_by = corrections[originalSort];
      diagnostics.push(`Repaired TMDB sort_by for "${catalog.name}": ${originalSort} -> ${catalog.params.sort_by}`);
    }

    if (catalog.catalogType === 'series') {
      for (const suffix of ['.gte', '.lte']) {
        if (catalog.params[`primary_release_date${suffix}`]) {
          catalog.params[`first_air_date${suffix}`] = catalog.params[`primary_release_date${suffix}`];
          delete catalog.params[`primary_release_date${suffix}`];
        }
      }
    } else if (catalog.catalogType === 'movie') {
      for (const suffix of ['.gte', '.lte']) {
        if (catalog.params[`first_air_date${suffix}`]) {
          catalog.params[`primary_release_date${suffix}`] = catalog.params[`first_air_date${suffix}`];
          delete catalog.params[`first_air_date${suffix}`];
        }
      }
    }

    for (const field of ['keywords', 'excludeKeywords', 'companies', 'cast', 'people', 'watchProviders', 'networks']) {
      if (catalog.params[field]) {
        if (!catalog.resolve) catalog.resolve = {};
        const value = catalog.params[field];
        const names = typeof value === 'string' ? value.split(/[|,]/).map((s: string) => s.trim()) : Array.isArray(value) ? value : [];
        const resolveKey = field;
        if (!catalog.resolve[resolveKey]) catalog.resolve[resolveKey] = [];
        catalog.resolve[resolveKey].push(...names);
        delete catalog.params[field];
      }
    }

    const tmdbEntityParams: Array<[string, string]> = [
      ['with_keywords', 'keywords'],
      ['without_keywords', 'excludeKeywords'],
      ['with_companies', 'companies'],
      ['with_cast', 'cast'],
      ['with_people', 'people'],
      ['with_watch_providers', 'watchProviders'],
      ['with_networks', 'networks'],
    ];
    for (const [paramKey, resolveKey] of tmdbEntityParams) {
      const movedNames = moveNamedIdParamToResolve(catalog, paramKey, resolveKey, '|');
      if (movedNames.length) {
        diagnostics.push(`Moved TMDB ${paramKey} names from params to resolve for "${catalog.name}": ${movedNames.join(', ')}`);
      }
    }

    repairTmdbGenreParam(catalog, 'with_genres', diagnostics);
    repairTmdbGenreParam(catalog, 'without_genres', diagnostics);
    applyTmdbGenreNameResolve(catalog, diagnostics);
    dropTmdbGenreDuplicateKeywords(catalog, diagnostics);
    applyTmdbVoteFloorDefaults(catalog, diagnostics);
  }

  if (catalog.source === 'tvdb') {
    const schema = getSourceSchema(catalog.source, catalog.catalogType, catalog.params);
    coerceEnumParam(catalog.params, 'sort', schema.sorts);
    coerceEnumParam(catalog.params, 'sortType', schema.sortDirections);
    coerceNumberParam(catalog.params, 'year', true);
    if (!catalog.params.country) catalog.params.country = 'usa';
    if (!catalog.params.lang) catalog.params.lang = 'eng';
    if (!catalog.resolve) catalog.resolve = {};
    for (const field of ['genre', 'status', 'contentRating']) {
      if (catalog.params[field] !== undefined) {
        const val = catalog.params[field];
        if (!catalog.resolve[field]?.length) {
          catalog.resolve[field] = [String(val)];
        }
        delete catalog.params[field];
      }
    }
  }

  if (catalog.source === 'anilist') {
    const schema = getSourceSchema(catalog.source, catalog.catalogType, catalog.params);
    coerceEnumParam(catalog.params, 'sort', schema.sorts);
    for (const [genreField, tagField] of [['genre_in', 'tag_in'], ['genre_not_in', 'tag_not_in']] as const) {
      const result = normalizeDelimitedEnumParam(catalog.params, genreField, schema.genres);
      if (result.invalid.length) {
        const existingTags = splitParamValues(catalog.params[tagField], /,/);
        catalog.params[tagField] = [...existingTags, ...result.invalid].join(',');
        diagnostics.push(`Moved AniList ${genreField} values to ${tagField} for "${catalog.name}": ${result.invalid.join(', ')}`);
      }
    }
    normalizeDelimitedStringParam(catalog.params, 'tag_in');
    normalizeDelimitedStringParam(catalog.params, 'tag_not_in');
    coerceDelimitedEnumParam(catalog.params, 'format_in', schema.formats);
    coerceEnumParam(catalog.params, 'season', schema.seasons);
    const statusDiagnostic = coerceSingleEnumParam(catalog.params, 'status', schema.statuses);
    if (statusDiagnostic) {
      diagnostics.push(`${statusDiagnostic} for "${catalog.name}"`);
    }
    coerceEnumParam(catalog.params, 'countryOfOrigin', schema.countries);
    coerceBooleanParam(catalog.params, 'isAdult');
    for (const field of ['seasonYear', 'averageScore_greater', 'averageScore_lesser', 'popularity_greater', 'episodes_greater', 'episodes_lesser', 'duration_greater', 'duration_lesser']) {
      coerceNumberParam(catalog.params, field, true);
    }
    for (const field of ['startDate_greater', 'startDate_lesser']) {
      coerceFuzzyDateParam(catalog.params, field);
    }
    const movedStudios = moveNamedIdParamToResolve(catalog, 'studios', 'studios');
    if (movedStudios.length) {
      diagnostics.push(`Moved AniList studios from params to resolve for "${catalog.name}": ${movedStudios.join(', ')}`);
    }
  }

  if (catalog.source === 'mal') {
    const schema = getSourceSchema(catalog.source, catalog.catalogType, catalog.params);
    coerceEnumParam(catalog.params, 'order_by', schema.sorts);
    coerceEnumParam(catalog.params, 'sort', schema.sortDirections);
    coerceEnumParam(catalog.params, 'type', schema.types);
    coerceEnumParam(catalog.params, 'status', schema.statuses);
    coerceEnumParam(catalog.params, 'rating', schema.ratings);
    coerceEnumParam(catalog.params, 'season', schema.seasons);
    coerceBooleanParam(catalog.params, 'sfw');
    for (const field of ['seasonYear']) {
      coerceNumberParam(catalog.params, field, true);
    }
    for (const field of ['min_score', 'max_score']) {
      coerceNumberParam(catalog.params, field);
    }
    for (const field of ['start_date', 'end_date']) {
      coerceIsoDateParam(catalog.params, field);
    }
    const movedProducers = moveNamedIdParamToResolve(catalog, 'producers', 'producers');
    if (movedProducers.length) {
      diagnostics.push(`Moved MAL producers from params to resolve for "${catalog.name}": ${movedProducers.join(', ')}`);
    }

    const malNameToId = Object.fromEntries(
      Object.entries(MAL_GENRE_NAMES).map(([id, name]) => [name.toLowerCase(), Number(id)])
    );
    for (const field of ['genres', 'genres_exclude']) {
      if (catalog.params[field]) {
        const parts = String(catalog.params[field]).split(',').map((s: string) => s.trim());
        const ids = parts.map(p => {
          const asNum = Number(p);
          if (Number.isFinite(asNum) && MAL_GENRE_NAMES[asNum]) return asNum;
          return malNameToId[p.toLowerCase()] ?? null;
        }).filter((id): id is number => id !== null);
        catalog.params[field] = ids.length ? ids.join(',') : undefined;
        if (!catalog.params[field]) delete catalog.params[field];
      }
    }
  }

  if (catalog.source === 'simkl') {
    const schema = getSourceSchema(catalog.source, catalog.catalogType, catalog.params);
    coerceEnumParam(catalog.params, 'media', SOURCE_SCHEMAS.simkl.media);
    if (typeof catalog.params.genre === 'string' && catalog.params.genre.includes(',')) {
      delete catalog.params.genre;
      diagnostics.push(`Removed multi-value Simkl genre from "${catalog.name}" because Simkl supports one genre per catalog`);
    }
    normalizeSimklEnumParam(catalog, schema, 'genre', diagnostics);
    normalizeSimklEnumParam(catalog, schema, 'type', diagnostics);
    normalizeSimklEnumParam(catalog, schema, 'country', diagnostics);
    normalizeSimklEnumParam(catalog, schema, 'network', diagnostics);
    normalizeSimklYearParam(catalog, schema, diagnostics);
    coerceEnumParam(catalog.params, 'sort', getCatalogSorts(catalog.source, catalog.catalogType, catalog.params));
  }

  applyQueryDateRepairs(catalog, options, diagnostics);
  applyTmdbReleasedDateCaps(catalog, options, diagnostics);

  const strippedParams = stripUnknownParams(catalog);
  if (strippedParams.length) {
    logger.debug(`[AI Catalog] Stripped unsupported ${catalog.source} params from "${catalog.name}": ${strippedParams.join(', ')}`);
    diagnostics.push(`Stripped unsupported ${catalog.source} params from "${catalog.name}": ${strippedParams.join(', ')}`);
  }

  normalizeResolveFields(catalog, diagnostics);

  return diagnostics;
}

export function validateCatalogParams(catalog: AICatalogOutput): ValidationResult {
  const errors: string[] = [];

  if (!VALID_SOURCES.includes(catalog.source as any)) {
    errors.push(`Invalid source: ${catalog.source}`);
  }

  if (!['movie', 'series', 'anime'].includes(catalog.catalogType)) {
    errors.push(`Invalid catalogType: ${catalog.catalogType}`);
  }

  if ((catalog.source === 'anilist' || catalog.source === 'mal') && catalog.catalogType !== 'anime') {
    errors.push(`${catalog.source} only supports catalogType "anime"`);
  }

  if ((catalog.source === 'tmdb' || catalog.source === 'tvdb') && !['movie', 'series'].includes(catalog.catalogType)) {
    errors.push(`${catalog.source} only supports catalogType "movie" or "series"`);
  }

  if (!catalog.name || catalog.name.length > 60) {
    errors.push('Name is required and must be under 60 chars');
  }

  if (catalog.source === 'tmdb') {
    const validSorts = getCatalogSorts(catalog.source, catalog.catalogType, catalog.params);
    if (catalog.params.sort_by && !validSorts.includes(catalog.params.sort_by)) {
      errors.push(`Invalid TMDB sort_by: ${catalog.params.sort_by}`);
    }

    validateNumberRange(errors, catalog.params, 'vote_average.gte', 0, 10);
    validateNumberRange(errors, catalog.params, 'vote_average.lte', 0, 10);
    validateNumberRange(errors, catalog.params, 'vote_count.gte', 0, Number.MAX_SAFE_INTEGER, true);
    validateNumberRange(errors, catalog.params, 'vote_count.lte', 0, Number.MAX_SAFE_INTEGER, true);
    validateNumberRange(errors, catalog.params, 'with_runtime.gte', 0, 1440, true);
    validateNumberRange(errors, catalog.params, 'with_runtime.lte', 0, 1440, true);
    validateNumberRange(errors, catalog.params, 'primary_release_year', 1874, 2100, true);
    validateNumberRange(errors, catalog.params, 'first_air_date_year', 1874, 2100, true);
    validateNumberRange(errors, catalog.params, 'year', 1874, 2100, true);

    for (const field of ['primary_release_date.gte', 'primary_release_date.lte', 'first_air_date.gte', 'first_air_date.lte', 'air_date.gte', 'air_date.lte', 'release_date.gte', 'release_date.lte']) {
      if (catalog.params[field] !== undefined && !isIsoDate(catalog.params[field])) {
        errors.push(`${field} must use YYYY-MM-DD`);
      }
    }

    for (const field of ['include_adult', 'include_video']) {
      if (catalog.params[field] !== undefined && typeof catalog.params[field] !== 'boolean') {
        errors.push(`${field} must be boolean`);
      }
    }

    for (const field of ['with_genres', 'without_genres']) {
      if (catalog.params[field]) {
        const ids = String(catalog.params[field]).split(/[|,]/).map(Number);
        const validGenres = catalog.catalogType === 'movie' ? VALID_TMDB_MOVIE_GENRES : VALID_TMDB_TV_GENRES;
        for (const id of ids) {
          if (!validGenres.has(id)) {
            errors.push(`Invalid TMDB genre ID: ${id}`);
          }
        }
      }
    }
  }

  if (catalog.source === 'anilist') {
    const schema = getSourceSchema(catalog.source, catalog.catalogType, catalog.params);
    if (catalog.params.sort && !schema.sorts.includes(catalog.params.sort)) {
      errors.push(`Invalid AniList sort: ${catalog.params.sort}`);
    }
    validateDelimitedEnum(errors, catalog.params, 'genre_in', schema.genres, 'AniList genre');
    validateDelimitedEnum(errors, catalog.params, 'genre_not_in', schema.genres, 'AniList genre');
    validateDelimitedEnum(errors, catalog.params, 'format_in', schema.formats, 'AniList format');
    validateEnum(errors, catalog.params, 'season', schema.seasons, 'AniList season');
    validateEnum(errors, catalog.params, 'status', schema.statuses, 'AniList status');
    validateEnum(errors, catalog.params, 'countryOfOrigin', schema.countries, 'AniList countryOfOrigin');
    validateNumberRange(errors, catalog.params, 'seasonYear', 1900, 2100, true);
    validateNumberRange(errors, catalog.params, 'averageScore_greater', 0, 100, true);
    validateNumberRange(errors, catalog.params, 'averageScore_lesser', 0, 100, true);
    validateNumberRange(errors, catalog.params, 'popularity_greater', 0, Number.MAX_SAFE_INTEGER, true);
    validateNumberRange(errors, catalog.params, 'episodes_greater', 0, 10000, true);
    validateNumberRange(errors, catalog.params, 'episodes_lesser', 0, 10000, true);
    validateNumberRange(errors, catalog.params, 'duration_greater', 0, 1000, true);
    validateNumberRange(errors, catalog.params, 'duration_lesser', 0, 1000, true);
    for (const field of ['startDate_greater', 'startDate_lesser']) {
      if (catalog.params[field] !== undefined && !isFuzzyDate(catalog.params[field])) {
        errors.push(`${field} must use YYYYMMDD`);
      }
    }
    if (catalog.params.isAdult !== undefined && typeof catalog.params.isAdult !== 'boolean') {
      errors.push('isAdult must be boolean');
    }
    if (catalog.params.studios !== undefined) {
      for (const value of splitParamValues(catalog.params.studios, /,/)) {
        if (!isPositiveIntegerString(value)) errors.push(`Invalid AniList studio ID: ${value}`);
      }
    }
  }

  if (catalog.source === 'mal') {
    const schema = getSourceSchema(catalog.source, catalog.catalogType, catalog.params);
    if (catalog.params.order_by && !schema.sorts.includes(catalog.params.order_by)) {
      errors.push(`Invalid MAL order_by: ${catalog.params.order_by}`);
    }
    validateEnum(errors, catalog.params, 'sort', schema.sortDirections, 'MAL sort');
    validateEnum(errors, catalog.params, 'type', schema.types, 'MAL type');
    validateEnum(errors, catalog.params, 'status', schema.statuses, 'MAL status');
    validateEnum(errors, catalog.params, 'rating', schema.ratings, 'MAL rating');
    validateEnum(errors, catalog.params, 'season', schema.seasons, 'MAL season');
    validateNumberRange(errors, catalog.params, 'seasonYear', 1900, 2100, true);
    validateNumberRange(errors, catalog.params, 'min_score', 0, 10);
    validateNumberRange(errors, catalog.params, 'max_score', 0, 10);
    for (const field of ['start_date', 'end_date']) {
      if (catalog.params[field] !== undefined && !isIsoDate(catalog.params[field])) {
        errors.push(`${field} must use YYYY-MM-DD`);
      }
    }
    if (catalog.params.sfw !== undefined && typeof catalog.params.sfw !== 'boolean') {
      errors.push('sfw must be boolean');
    }
    for (const field of ['genres', 'genres_exclude', 'producers']) {
      if (catalog.params[field] !== undefined) {
        for (const value of splitParamValues(catalog.params[field], /,/)) {
          if (!isPositiveIntegerString(value)) errors.push(`Invalid MAL ${field} ID: ${value}`);
        }
      }
    }
  }

  if (catalog.source === 'simkl') {
    const schema = getSourceSchema(catalog.source, catalog.catalogType, catalog.params);
    validateEnum(errors, catalog.params, 'media', SOURCE_SCHEMAS.simkl.media, 'Simkl media');
    const validSorts = getCatalogSorts(catalog.source, catalog.catalogType, catalog.params);
    if (catalog.params.sort && !validSorts.includes(catalog.params.sort)) {
      errors.push(`Invalid Simkl sort: ${catalog.params.sort}`);
    }
    validateEnum(errors, catalog.params, 'genre', schema.genres || [], 'Simkl genre');
    if (catalog.params.type !== undefined) {
      if (schema.types) validateEnum(errors, catalog.params, 'type', schema.types, 'Simkl type');
      else errors.push(`Simkl type is not supported for media: ${catalog.params.media}`);
    }
    if (catalog.params.country !== undefined) {
      if (schema.countries) validateEnum(errors, catalog.params, 'country', schema.countries, 'Simkl country');
      else errors.push(`Simkl country is not supported for media: ${catalog.params.media}`);
    }
    if (catalog.params.network !== undefined) {
      if (schema.networks) validateEnum(errors, catalog.params, 'network', schema.networks, 'Simkl network');
      else errors.push(`Simkl network is not supported for media: ${catalog.params.media}`);
    }
    if (catalog.params.year !== undefined) {
      const validYear = schema.yearShortcuts?.includes(catalog.params.year) || isSimklDecadeYear(catalog.params.year);
      if (!validYear) errors.push(`Invalid Simkl year: ${catalog.params.year}`);
    }
  }

  if (catalog.source === 'tvdb') {
    const schema = getSourceSchema(catalog.source, catalog.catalogType, catalog.params);
    const validTvdbSorts = getCatalogSorts(catalog.source, catalog.catalogType, catalog.params);
    if (catalog.params.sort && !validTvdbSorts.includes(catalog.params.sort)) {
      errors.push(`Invalid TVDB sort: ${catalog.params.sort}`);
    }
    validateEnum(errors, catalog.params, 'sortType', schema.sortDirections, 'TVDB sortType');
    validateNumberRange(errors, catalog.params, 'year', 1874, 2100, true);
  }

  return { valid: errors.length === 0, errors };
}
