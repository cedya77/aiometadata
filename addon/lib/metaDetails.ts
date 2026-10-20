import getCountryISO3 from 'country-iso-2-to-3';

/** Detail-page fields beside the Stremio ones, as Jellyfin servers read them off a meta. */
export interface MetaDetails {
  tagline?: string;
  studios?: string[];
  networks?: string[];
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
    countries: names(data?.production_countries).map(countryName),
  });
}

export function tvdbSeriesDetails(show: any): MetaDetails {
  const companies = Array.isArray(show?.companies) ? show.companies : [];
  const ofType = (type: string) => companies.filter((company: any) => company?.companyType?.companyTypeName === type);
  const status = String(show?.status?.name ?? '');
  return present({
    studios: names([...ofType('Studio'), ...ofType('Production Company')]),
    networks: names([show?.originalNetwork, show?.latestNetwork, ...ofType('Network')]),
    countries: show?.originalCountry ? [countryName(String(show.originalCountry))] : [],
    ...schedule(status === 'Continuing' || status === 'Upcoming', WEEKDAYS.filter((day) => show?.airsDays?.[day.toLowerCase()] === true), show?.airsTime),
  });
}

export function tvdbMovieDetails(movie: any): MetaDetails {
  const companies = movie?.companies && typeof movie.companies === 'object' ? movie.companies : {};
  return present({
    studios: names([...(companies.studio ?? []), ...(companies.production ?? [])]),
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
    ...schedule(anime?.status === 'Currently Airing' || anime?.status === 'Not yet aired', WEEKDAYS.includes(day) ? [day] : [], anime?.broadcast?.time),
  });
}
