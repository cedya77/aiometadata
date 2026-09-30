import { isUnratedCertification } from './ageRating';

type RatingConfig = { language?: string; contentRatingCountry?: string; displayAgeRating?: boolean };
type ProviderRatings = { us?: string | null; local?: string | null };
export interface ContentRating {
  country: string | null;
  system: string;
  code: string;
  source: string;
  requestedCountry: string;
  isFallback: boolean;
}

type RatingSystemRule = { name: string; codes: RegExp; type?: 'movie' | 'series'; explicitOnly?: boolean };
const RATING_SYSTEMS: Record<string, RatingSystemRule[]> = {
  AR: [{ name: 'INCAA', codes: /^(ATP|SAM(?:13|16|18)|\+?(13|16|18)|C)$/i }],
  AT: [{ name: 'JMK', codes: /^(AA|0|6|8|10|12|14|16)\+?$/i, type: 'movie' }],
  AU: [
    { name: 'ACMA', codes: /^(P|C|G|PG|M|MA|MA15\+?|AV15\+?)$/i, type: 'series' },
    { name: 'ACB', codes: /^(G|PG|M|MA\s?15\+?|R\s?18\+?|X\s?18\+?|RC)$/i },
  ],
  BR: [{ name: 'ClassInd', codes: /^(AL|ER|L|L-?(10|12|14|16|18)|A?(10|12|14|16|18)(-(12|14|16|18))?)\+?$/i }],
  BE: [
    { name: 'GoedGezien / BienVu', codes: /^(AL|0|6|10|12|16)\+?$/i },
    { name: 'GoedGezien / BienVu', codes: /^18\+?$/i, type: 'movie' },
    { name: 'Kijkwijzer', codes: /^(9|14)\+?$/i },
    // These names are provider aliases, not separate settings or data sources.
    ...['GoedGezien', 'BienVu'].flatMap(name => [
      { name, codes: /^(AL|0|6|10|12|16)\+?$/i, explicitOnly: true },
      { name, codes: /^18\+?$/i, type: 'movie' as const, explicitOnly: true },
    ]),
    { name: 'Kijkwijzer', codes: /^(AL|0|6|9|12|14|16|18)\+?$/i, explicitOnly: true },
  ],
  CA: [{ name: 'CHVRS', codes: /^(G|E|PG|14A|18A|R)$/i, type: 'movie' }],
  CH: [{ name: 'JIF', codes: /^(0|6|8|10|12|14|16|18)$/i, type: 'movie' }],
  CL: [
    { name: 'ANATEL', codes: /^(F|I|I-?(7|10|12)|R|A)$/i, type: 'series' },
    { name: 'CCC', codes: /^(TE|TE\+7|18X|6|7|14|18)$/i, type: 'movie' },
  ],
  DE: [
    { name: 'FSF', codes: /^(0|6|12|12ab20uhr|16|18|X)$/i },
    { name: 'FSK', codes: /^(0|6|12|16|18)\+?$/i },
  ],
  DK: [{ name: 'Medierådet', codes: /^(A|7|11|15)$/i }],
  ES: [{ name: 'ICAA', codes: /^(APTA|A|TP|ER|7|12|13|16|18|X)$/i, type: 'movie' }],
  FI: [{ name: 'KAVI', codes: /^(S|ST|T|K-?(7|12|16|18)|7|12|16|18)$/i }],
  FR: [
    { name: 'Arcom', codes: /^(TP|T|U|-?(10|12|16|18)|interdiction)$/i, type: 'series' },
    { name: 'CNC', codes: /^(TP|T|U|-?(12|16|18)|interdiction)$/i, type: 'movie' },
  ],
  GB: [{ name: 'BBFC', codes: /^(U|PG|12|12A|15|18|R18)$/i }],
  HK: [{ name: 'OFNAA', codes: /^(I|II|IIA|IIB|III)$/i, type: 'movie' }],
  HU: [{ name: 'NMHH', codes: /^(I|II|III|IV|V|VI|KN|0|6|12|16|18|X)$/i }],
  ID: [{ name: 'LSF', codes: /^(SU|A|R13|D17|D21|13|17|21)\+?$/i }],
  IE: [
    { name: 'RTÉ', codes: /^(Ch|GA|PS|MA)$/i, type: 'series' },
    { name: 'IFCO', codes: /^(G|PG|12A?|15A?|16|18)$/i, type: 'movie' },
  ],
  IN: [{ name: 'CBFC', codes: /^(U|U\/?A(?:\s?(7|13|16)\+?)?|A|S)$/i, type: 'movie' }],
  IT: [
    { name: 'AGCOM', codes: /^(T|VM(6|14|18))$/i, type: 'series' },
    { name: 'MiC', codes: /^(T|VM(6|10|14|16|18)|6|10|14|16|18)$/i, type: 'movie' },
  ],
  JP: [{ name: 'Eirin', codes: /^(G|PG-?12|R-?(15|18)\+?)$/i, type: 'movie' }],
  KR: [
    { name: 'KCC', codes: /^(ALL|7|12|15|19)\+?$/i, type: 'series' },
    { name: 'KMRB', codes: /^(ALL|G|12|15|18|19|LIM)\+?$/i, type: 'movie' },
  ],
  LT: [{ name: 'LKC', codes: /^(V|N-?(7|13|16|18))$/i, type: 'movie' }],
  LU: [{ name: 'CSCF', codes: /^(T|A|6|12|16|18)$/i, type: 'movie' }],
  LV: [{ name: 'NKC', codes: /^(U|7|12|16|18)\+?$/i }],
  MX: [{ name: 'RTC', codes: /^(AA|A|B|B-?15|C|D)$/i }],
  MY: [{ name: 'LPF', codes: /^(U|P12|P13|PG13|13|16|18|18SX|18PA|18SG|18PL)$/i, type: 'movie' }],
  NL: [{ name: 'Kijkwijzer', codes: /^(AL|0|6|9|12|14|16|18)\+?$/i }],
  NO: [{ name: 'Medietilsynet', codes: /^(A|6|7|9|11|12|15|18)$/i }],
  NZ: [{ name: 'NZ Classification', codes: /^(13|16|18|G|PG|M|R|RP(13|16|18)|R(13|15|16|18))$/i }],
  PH: [{ name: 'MTRCB', codes: /^(G(?:-TV)?|PG(?:-TV)?|SPG|R-?(13|16|18)|X)$/i }],
  PL: [{ name: 'KRRiT', codes: /^(I|II|III|IV|0|7|12|16|18)\+?$/i, type: 'series' }],
  PT: [{ name: 'IGAC', codes: /^(A|M\/(3|4|6|12|14|16|18)(-P)?|3|4|6|12|14|16|18)$/i, type: 'movie' }],
  RO: [{ name: 'CNA', codes: /^(AP|12|15|18\+?|G)$/i, type: 'series' }],
  RU: [{ name: 'MKRF', codes: /^(0|6|12|14|16|18)\+?$/i }],
  SG: [{ name: 'IMDA', codes: /^(G|PG|PG13|NC16|M18|R21)$/i }],
  SE: [{ name: 'Mediemyndigheten', codes: /^(Btl|Barntillåten|Barntillaten|0|7|11|15)$/i, type: 'movie' }],
  TH: [{ name: 'BFVC', codes: /^(G|E|13|15|18|20|B)$/i, type: 'movie' }],
  TW: [{ name: 'Taiwan MOC', codes: /^(G|P|PG|PG-?(12|15)|R-?(12|15)|R)$/i, type: 'movie' }],
  US: [
    { name: 'TV Parental Guidelines', codes: /^TV-(Y|Y7(?:-FV)?|G|PG|14|MA)$/i },
    { name: 'MPA', codes: /^(G|PG|PG-13|R|NC-17|M|GP|X)$/i },
  ],
  ZA: [{ name: 'FPB', codes: /^(A|PG|7-9-?PG|10(?:M|-12-?PG)?|13|16|18|X18|XX)$/i }],
};

function withoutSystemPrefix(code: string, name: string): string {
  return code.toLowerCase().startsWith(name.toLowerCase() + ' ')
    ? code.slice(name.length).trim() : code;
}

function ratingSystem(country: string, type: string, code: string): string {
  const rules = RATING_SYSTEMS[country] || [];
  const eligible = rules.filter(rule => !rule.type || rule.type === type);
  // Explicit provider prefixes take precedence over an inferred system.
  const explicit = eligible.find(rule => withoutSystemPrefix(code, rule.name) !== code
    && rule.codes.test(withoutSystemPrefix(code, rule.name)));
  if (explicit) return country === 'BE' && ['GoedGezien', 'BienVu', 'GoedGezien / BienVu'].includes(explicit.name)
    ? 'GoedGezien / BienVu' : explicit.name;
  if (country === 'BE') {
    return eligible.find(rule => !rule.explicitOnly && rule.codes.test(code))?.name || country;
  }
  // Bare German ages use the familiar FSK scale; FSF-only codes retain FSF.
  const candidates = country === 'DE' ? [...eligible].reverse() : eligible;
  return candidates.find(rule => rule.codes.test(code))?.name || country;
}

/** This preference affects presentation, never the existing US profile limits. */
export function getContentRatingCountry(config: RatingConfig = {}): string {
  const explicit = typeof config.contentRatingCountry === 'string' ? config.contentRatingCountry.trim().toUpperCase() : '';
  if (explicit && /^[A-Z]{2}$/.test(explicit)) return explicit;
  return (typeof config.language === 'string' ? config.language.match(/[-_]([a-z]{2})$/i)?.[1].toUpperCase() : null) || 'US';
}

/** Versioned for provenance and the native-client display fields. */
export function contentRatingCacheKey(config: RatingConfig): string {
  return `v3:${getContentRatingCountry(config)}`;
}

function known(value: unknown): value is string {
  return typeof value === 'string' && !isUnratedCertification(value);
}

export function resolveContentRating(
  config: RatingConfig,
  type: string,
  sources: { tmdb?: ProviderRatings; tvdb?: ProviderRatings },
) {
  const requestedCountry = getContentRatingCountry(config);
  const entries = Object.entries(sources);
  // Keep the legacy US value for filtering, including explicit unrated values.
  const certification = entries.map(([, ratings]) => ratings.us).find(Boolean) || null;
  const local = requestedCountry !== 'US'
    ? entries.find(([, ratings]) => known(ratings.local)) : undefined;
  const us = entries.find(([, ratings]) => known(ratings.us));
  const selected = local || us;
  const country = local ? requestedCountry : 'US';
  const code = selected ? String(local ? selected[1].local : selected[1].us).trim() : null;
  const contentRating: ContentRating | null = code ? {
    country,
    system: ratingSystem(country, type, code),
    code,
    source: selected![0],
    requestedCountry,
    isFallback: country !== requestedCountry,
  } : null;
  return { certification, certificationLocal: code, contentRating };
}

/** Native anime classifications are not national certifications. */
export function nativeContentRating(config: RatingConfig, code: unknown, source: 'mal' | 'kitsu'): ContentRating | null {
  if (!known(code)) return null;
  return {
    country: null, system: source === 'mal' ? 'MAL' : 'Kitsu', code: code.trim(), source,
    requestedCountry: getContentRatingCountry(config), isFallback: true,
  };
}

export function formatContentRating(rating: ContentRating | null | undefined): string | null {
  if (!rating || !known(rating.code)) return null;
  const { code, country, system } = rating;
  if (!country && system === 'MAL') {
    // MAL/Jikan appends an English explanation; retain it in code, not the badge.
    const shortCode = code.match(/^(G|PG|PG-13|R|R\+|Rx)(?=\s+-\s+|$)/i)?.[0].toUpperCase();
    return `MAL · ${shortCode || code}`;
  }
  if (country === 'BE' && ['GoedGezien', 'BienVu', 'GoedGezien / BienVu'].includes(system)) {
    const age = code.replace(/^(GoedGezien \/ BienVu|GoedGezien|BienVu)\s+/i, '').replace(/\+$/, '');
    return `${system} · ${/^(AL|0)$/i.test(age) ? 'AL' : `${age}+`}`;
  }
  if (country === 'NL' || (country === 'BE' && system === 'Kijkwijzer')) {
    const age = withoutSystemPrefix(code, 'Kijkwijzer').replace(/\+$/, '');
    if (/^(AL|0)$/i.test(age)) return 'Kijkwijzer · AL';
    if (['6', '9', '12', '14', '16', '18'].includes(age)) return `Kijkwijzer · ${age}+`;
  }
  if (country === 'US' && code === 'NC-17') return `MPA · NC-17 · 18+${rating.isFallback ? ' (US)' : ''}`;
  if (country === 'US' && system === 'TV Parental Guidelines') return `${code}${rating.isFallback ? ' (US)' : ''}`;
  if (country && system && system !== country) {
    return `${system} · ${withoutSystemPrefix(code, system)}${rating.isFallback ? ` (${country})` : ''}`;
  }
  return country ? `${code} (${country})` : `${system} · ${code}`;
}

/** Shared by fresh metadata, catalog/search responses and reconstructed cache hits. */
export function applyContentRatingDisplay(meta: any, config: RatingConfig): any {
  if (!meta) return meta;
  const extras = meta.app_extras || {};
  const display = Object.prototype.hasOwnProperty.call(extras, 'contentRating')
    ? formatContentRating(extras.contentRating)
    : extras.certificationLocal || extras.certification || meta.certification;
  const names = new Set([extras.certification, extras.certificationLocal, extras.contentRating?.code, display].filter(Boolean));
  // Publish the display value even when genre links are disabled.
  // The original regional code stays in contentRating.code; US filters continue
  // to read certification.
  if (Object.prototype.hasOwnProperty.call(extras, 'contentRating')) {
    meta.ageRating = known(display) ? display : null;
    extras.certificationLocal = meta.ageRating;
  }
  const links = (Array.isArray(meta.links) ? meta.links : []).filter((link: any) =>
    !(link?.category === 'Genres' && names.has(link.name)));
  if (config.displayAgeRating && known(display)) {
    const imdbId = meta.id?.match(/^tt\d+/)?.[0] || meta.imdb_id || meta._imdbId;
    const tmdbId = meta._tmdbId || String(meta.id || '').match(/^tmdb:(\d+)/)?.[1];
    const malId = meta._malId || String(meta.id || '').match(/^mal:(\d+)/)?.[1];
    const kitsuId = meta._kitsuId || String(meta.id || '').match(/^kitsu:(\d+)/)?.[1];
    const existing = Array.isArray(meta.links) ? meta.links.find((link: any) => link?.category === 'Genres' && names.has(link.name)) : null;
    const url = existing?.url || (imdbId ? `https://www.imdb.com/title/${imdbId}/parentalguide/`
      : tmdbId ? `https://www.themoviedb.org/${meta.type === 'series' ? 'tv' : 'movie'}/${tmdbId}`
      : malId ? `https://myanimelist.net/anime/${malId}`
      : kitsuId ? `https://kitsu.app/anime/${kitsuId}`
      : extras.contentRating?.country === 'NL' ? 'https://www.kijkwijzer.nl/' : 'https://www.themoviedb.org/');
    links.unshift({ name: display, category: 'Genres', url });
  }
  meta.links = links;
  return meta;
}
