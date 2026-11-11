import { ISO_639 } from './iso639';

const languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
const standardNames = new Intl.DisplayNames(['en'], { type: 'language', languageDisplay: 'standard', fallback: 'none' });
const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

/** ISO 639-1 and 639-2/T codes to the 639-2/B code Jellyfin stores. */
const BIBLIOGRAPHIC = new Map<string, string>();
const BIBLIOGRAPHIC_CODES = new Set<string>();
for (const entry of ISO_639.split(' ')) {
  const [one, codes] = entry.split(':');
  const [b, t] = codes.split('/');
  BIBLIOGRAPHIC.set(one, b);
  BIBLIOGRAPHIC_CODES.add(b);
  if (t) BIBLIOGRAPHIC.set(t, b);
}

const BILINGUAL = '-x-bilingual';

// Codes subtitle sites made up, which no standard holds; several are other languages in ISO 639-3.
const ADDON_CODES: Record<string, string> = {
  pob: 'pt-BR', pb: 'pt-BR', ea: 'es-419', spl: 'es-419', spn: 'es-419',
  zht: 'zh-Hant', zt: 'zh-Hant', cht: 'zh-Hant', zhs: 'zh-Hans', chs: 'zh-Hans', ze: `zh${BILINGUAL}`, zhe: `zh${BILINGUAL}`,
  me: 'cnr',
};

const NAME_ALIASES: Record<string, string> = { farsi: 'fa', tagalog: 'tl', latino: 'es-419', cantonese: 'yue', montenegrin: 'cnr' };

// `LA` is Laos to ISO 3166, and Latin America to every subtitle site.
const QUALIFIERS: Record<string, string> = {
  la: '419', latam: '419', 'latin america': '419', simplified: 'Hans', traditional: 'Hant', latin: 'Latn', cyrillic: 'Cyrl', bilingual: BILINGUAL.slice(1),
};

// Variants whose English names a site may send whole, as in "Brazilian Portuguese".
const DIALECTS = ['pt-BR', 'pt-PT', 'es-419', 'es-ES', 'es-MX', 'zh-Hans', 'zh-Hant', 'fr-CA', 'en-GB', 'en-US', 'sr-Latn', 'sr-Cyrl', 'nb', 'nn'];

let byName: Map<string, string> | null = null;
function nameIndex(): Map<string, string> {
  if (byName) return byName;
  const index = new Map<string, string>(Object.entries(NAME_ALIASES));
  for (const code of [...ISO_639.split(' ').map((entry) => entry.split(':')[0]), ...DIALECTS]) {
    const name = languageNames.of(code)?.toLowerCase();
    if (name && !index.has(name)) index.set(name, code);
  }
  byName = index;
  return index;
}

let byRegion: Map<string, string> | null = null;
function regionIndex(): Map<string, string> {
  if (byRegion) return byRegion;
  const index = new Map<string, string>();
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const a of letters) {
    for (const b of letters) {
      const name = regionNames.of(a + b);
      if (name && name !== a + b) index.set(name.toLowerCase(), a + b);
    }
  }
  byRegion = index;
  return index;
}

const keyOf = (value: string) => value.trim().toLowerCase().replace(/_/g, '-');

function canonical(tag: string): string | null {
  try {
    const [canonicalTag] = Intl.getCanonicalLocales(tag);
    return languageNames.of(new Intl.Locale(canonicalTag).language) ? canonicalTag : null;
  } catch {
    return null;
  }
}

function qualifierOf(qualifier: string): string | null {
  const key = qualifier.trim().toLowerCase();
  if (QUALIFIERS[key]) return QUALIFIERS[key];
  if (/^[a-z]{2}$|^\d{3}$/.test(key)) return key.toUpperCase();
  return regionIndex().get(key) ?? null;
}

function tagOf(value: string): string | null {
  const raw = value.trim();
  const key = keyOf(raw);
  if (!key || key === 'und' || key === 'mul' || key === 'zxx') return null;
  if (ADDON_CODES[key]) return ADDON_CODES[key];
  if (/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(key)) {
    const tag = canonical(key);
    if (tag) return tag;
  }
  const named = nameIndex().get(key);
  if (named) return named;

  // "Portuguese (BR)", "Spanish (Latin America)", "Chinese bilingual"
  const parts = /^(.*\S)\s*\(([^()]+)\)$/.exec(raw) ?? /^(\S+)\s+(.+)$/.exec(raw);
  if (!parts) return null;
  const whole = nameIndex().get(`${parts[1]} ${parts[2]}`.toLowerCase());
  if (whole) return whole;
  const base = tagOf(parts[1]);
  if (!base) return null;
  const qualifier = qualifierOf(parts[2]);
  if (!qualifier) return base;
  const language = new Intl.Locale(base).language;
  return qualifier === BILINGUAL.slice(1) ? `${language}${BILINGUAL}` : canonical(`${language}-${qualifier}`) ?? base;
}

// Before Intl's own folding, which turns `tl` into `fil`; after it for codes ISO 639-2 lacks, like `scc` or `cnr`.
function bibliographic(code: string): string | null {
  if (BIBLIOGRAPHIC.has(code)) return BIBLIOGRAPHIC.get(code)!;
  if (BIBLIOGRAPHIC_CODES.has(code)) return code;
  const language = canonical(code)?.split('-')[0];
  if (!language) return null;
  return BIBLIOGRAPHIC.get(language) ?? (language.length === 3 ? language : null);
}

function codeOf(input: string, tag: string): string | null {
  const key = keyOf(input);
  if (!ADDON_CODES[key] && /^[a-z]{2,3}(-|$)/.test(key)) {
    const code = bibliographic(key.split('-')[0]);
    if (code) return code;
  }
  return bibliographic(tag.replace(BILINGUAL, '').split('-')[0]);
}

function nameOf(tag: string): string {
  const bilingual = tag.endsWith(BILINGUAL);
  const locale = new Intl.Locale(tag.replace(BILINGUAL, ''));
  let { script, region } = locale;
  // A Chinese region stands for a script; a language's own country adds nothing.
  if (locale.language === 'zh' && region && !script) {
    script = locale.maximize().script;
    region = undefined;
  }
  if (region === locale.language.toUpperCase()) region = undefined;
  const shown = [locale.language, script, region].filter(Boolean).join('-');
  const name = standardNames.of(shown) ?? languageNames.of(locale.language) ?? shown;
  return bilingual ? `${name} (Bilingual)` : name;
}

export interface ResolvedLanguage {
  /** ISO 639-2/B, what a client matches its preferred language against. */
  code: string;
  /** English name, with the variant when the addon named one. */
  name: string;
}

const resolved = new Map<string, ResolvedLanguage | null>();

/** A subtitle's language from its `lang`, and the finer `lang_code` some addons add. */
export function resolveLanguage(lang: string, hint?: string): ResolvedLanguage | null {
  const cacheKey = `${lang}|${hint ?? ''}`;
  if (resolved.has(cacheKey)) return resolved.get(cacheKey)!;
  const tag = (hint ? tagOf(hint) : null) ?? tagOf(lang);
  const code = tag ? codeOf(lang, tag) ?? (hint ? codeOf(hint, tag) : null) : null;
  const result = tag && code ? { code, name: nameOf(tag) } : null;
  if (resolved.size >= 2000) resolved.clear();
  resolved.set(cacheKey, result);
  return result;
}
