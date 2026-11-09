import getCountryISO3 from 'country-iso-2-to-3';

export type StudioSource = 'tmdb-company' | 'tmdb-network' | 'tvdb' | 'mal';

/** A studio or network as its provider knows it, so a studio page can be asked of that provider. */
export interface StudioRef {
  name: string;
  source: StudioSource;
  id: number;
}

/** Detail-page fields beside the Stremio ones, as Jellyfin servers read them off a meta. */
export interface MetaDetails {
  tagline?: string;
  studios?: string[];
  networks?: string[];
  _studioRefs?: StudioRef[];
  countries?: string[];
  airDays?: string[];
  airTime?: string;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

let alpha3ToAlpha2: Map<string, string> | null = null;

function alpha2Of(alpha3: string): string | undefined {
  if (!alpha3ToAlpha2) {
    alpha3ToAlpha2 = new Map();
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const a of letters) {
      for (const b of letters) {
        const code3 = getCountryISO3(a + b);
        if (code3) alpha3ToAlpha2.set(code3, a + b);
      }
    }
  }
  return alpha3ToAlpha2.get(alpha3.toUpperCase());
}

/** A country's English name, from a name or an ISO 3166 alpha-2 or alpha-3 code. */
export function countryName(country: string): string {
  const trimmed = country.trim();
  const code = /^[A-Za-z]{2}$/.test(trimmed) ? trimmed.toUpperCase() : /^[A-Za-z]{3}$/.test(trimmed) ? alpha2Of(trimmed) : undefined;
  if (!code) return trimmed;
  try {
    const name = regionNames.of(code);
    return name && name !== code ? name : trimmed;
  } catch {
    return trimmed;
  }
}

function names(list: any): string[] {
  const out = (Array.isArray(list) ? list : [list])
    .map((entry: any) => String((typeof entry === 'string' ? entry : entry?.name) ?? '').trim())
    .filter(Boolean);
  return [...new Set(out)];
}

function refs(groups: Array<[any, StudioSource, string?]>): StudioRef[] {
  const out: StudioRef[] = [];
  const seen = new Set<string>();
  for (const [list, source, idKey = 'id'] of groups) {
    for (const entry of Array.isArray(list) ? list : [list]) {
      const name = String(entry?.name ?? '').trim();
      const id = Number(entry?.[idKey]);
      if (!name || !Number.isInteger(id) || id <= 0 || seen.has(`${source}:${id}`)) continue;
      seen.add(`${source}:${id}`);
      out.push({ name, source, id });
    }
  }
  return out;
}

function present(details: MetaDetails): MetaDetails {
  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => (Array.isArray(value) ? value.length > 0 : Boolean(value)))
  ) as MetaDetails;
}

/** Air days only for a show still airing: an ended one does not air every Sunday. */
function schedule(airing: boolean, days: string[], time: unknown): MetaDetails {
  if (!airing || !days.length) return {};
  const at = typeof time === 'string' && /^\d{1,2}:\d{2}$/.test(time.trim()) ? time.trim().padStart(5, '0') : undefined;
  return { airDays: days, airTime: at };
}

export function tmdbDetails(data: any): MetaDetails {
  return present({
    tagline: typeof data?.tagline === 'string' ? data.tagline.trim() : undefined,
    studios: names(data?.production_companies),
    networks: names(data?.networks),
    _studioRefs: refs([[data?.production_companies, 'tmdb-company'], [data?.networks, 'tmdb-network']]),
    countries: names(data?.production_countries).map(countryName),
  });
}

export function tvdbSeriesDetails(show: any): MetaDetails {
  const companies = Array.isArray(show?.companies) ? show.companies : [];
  const ofType = (type: string) => companies.filter((company: any) => company?.companyType?.companyTypeName === type);
  const status = String(show?.status?.name ?? '');
  const studios = [...ofType('Studio'), ...ofType('Production Company')];
  const networks = [show?.originalNetwork, show?.latestNetwork, ...ofType('Network')];
  return present({
    studios: names(studios),
    networks: names(networks),
    _studioRefs: refs([[studios, 'tvdb'], [networks, 'tvdb']]),
    countries: show?.originalCountry ? [countryName(String(show.originalCountry))] : [],
    ...schedule(status === 'Continuing' || status === 'Upcoming', WEEKDAYS.filter((day) => show?.airsDays?.[day.toLowerCase()] === true), show?.airsTime),
  });
}

export function tvdbMovieDetails(movie: any): MetaDetails {
  const companies = movie?.companies && typeof movie.companies === 'object' ? movie.companies : {};
  const studios = [...(companies.studio ?? []), ...(companies.production ?? [])];
  return present({
    studios: names(studios),
    _studioRefs: refs([[studios, 'tvdb']]),
    countries: Array.isArray(movie?.production_countries) && movie.production_countries.length
      ? names(movie.production_countries).map(countryName)
      : movie?.originalCountry ? [countryName(String(movie.originalCountry))] : [],
  });
}

export function tvmazeDetails(show: any): MetaDetails {
  const channel = show?.network ?? show?.webChannel;
  const days = Array.isArray(show?.schedule?.days) ? show.schedule.days.filter((day: string) => WEEKDAYS.includes(day)) : [];
  return present({
    networks: names(channel),
    countries: channel?.country?.name ? [String(channel.country.name)] : [],
    ...schedule(show?.status === 'Running' || show?.status === 'In Development', days, show?.schedule?.time),
  });
}

/** MyAnimeList's broadcast is Japan's time, as TVDB's air time is the network's own. */
export function jikanDetails(anime: any): MetaDetails {
  const day = String(anime?.broadcast?.day ?? '').replace(/s$/, '');
  return present({
    studios: names(anime?.studios),
    _studioRefs: refs([[anime?.studios, 'mal', 'mal_id']]),
    ...schedule(anime?.status === 'Currently Airing' || anime?.status === 'Not yet aired', WEEKDAYS.includes(day) ? [day] : [], anime?.broadcast?.time),
  });
}
