import { mapWithConcurrency } from '../../../utils/concurrency';
import type { AnimeYear } from './anime';
import type { YearTitle } from './timed';

const CAST_CARDS = 8;
const CAST_TITLES = 5;
const DIRECTORS = 3;
const THEMES = 17;
const NETWORKS = 10;
const LINK_FILMS = 3;

const BOOK = 'based on novel or book';
const MANGA = 'based on manga';
const THEME_NAMES: Record<string, string> = {
  [BOOK]: 'based on a book',
  'based on true story': 'true story',
  'based on comic': 'based on a comic',
};

export interface PeopleCard {
  name: string;
  photo: string | null;
  titles: number;
  shown: string[];
  voiced: boolean;
}

export interface PeopleYear {
  cast: PeopleCard[];
  directors: Array<{ name: string; photo: string | null; films: number }>;
  together: { names: [string, string]; photos: [string | null, string | null]; films: number } | null;
  link: { name: string; photo: string | null; show: { name: string; poster: string | null }; films: Array<{ name: string; poster: string | null }> } | null;
  themes: Array<[string, number]>;
  books: number;
  manga: number;
  networks: Array<{ name: string; logo: string | null; plays: number }>;
}

const personKey = (name: string): string => name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const nameOf = (title: YearTitle): string => (title.facts?.name ?? title.key).replace(/\s+\(\d{4}\)$/, '');

interface Credit {
  name: string;
  photo: string | null;
  titles: YearTitle[];
}

function credits(titles: YearTitle[], pick: (title: YearTitle) => Array<{ name: string; photo: string | null }>): Map<string, Credit> {
  const out = new Map<string, Credit>();
  for (const title of titles) {
    const seen = new Set<string>();
    for (const person of pick(title)) {
      const key = personKey(person.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const held = out.get(key) ?? { name: person.name, photo: null, titles: [] };
      held.photo = held.photo ?? person.photo;
      held.titles.push(title);
      out.set(key, held);
    }
  }
  return out;
}

const playsOf = (titles: YearTitle[]): number => titles.reduce((total, title) => total + title.plays.length, 0);
const byReach = (a: Credit, b: Credit): number => b.titles.length - a.titles.length || playsOf(b.titles) - playsOf(a.titles);
const byPlays = (a: YearTitle, b: YearTitle): number => b.plays.length - a.plays.length || b.watchMs - a.watchMs;

function voiceCard(anime: AnimeYear | null): PeopleCard | null {
  const voice = anime?.voices[0];
  if (!voice) return null;
  const keyOf = new Map(anime!.entries.map((entry) => [entry.malId, entry.titleKey]));
  const nameOfKey = new Map(anime!.entries.map((entry) => [entry.titleKey, entry.name]));
  const keys = [...new Set(voice.roles.flatMap((role) => role.entries.map((id) => keyOf.get(id)).filter((key): key is string => !!key)))];
  if (keys.length < 2) return null;
  return { name: voice.name, photo: voice.image, titles: keys.length, shown: keys.slice(0, CAST_TITLES).map((key) => nameOfKey.get(key) ?? key), voiced: true };
}

function togetherOf(films: YearTitle[]): PeopleYear['together'] {
  const pairs = new Map<string, { a: Credit; b: Credit; films: number }>();
  const cast = credits(films, (title) => title.facts?.cast ?? []);
  const shared = [...cast.values()].filter((credit) => credit.titles.length >= 2);
  for (let i = 0; i < shared.length; i += 1) {
    for (let j = i + 1; j < shared.length; j += 1) {
      const both = shared[i].titles.filter((title) => shared[j].titles.includes(title)).length;
      if (both < 2) continue;
      pairs.set(`${i}|${j}`, { a: shared[i], b: shared[j], films: both });
    }
  }
  const best = [...pairs.values()].sort((x, y) => y.films - x.films || playsOf(y.a.titles) + playsOf(y.b.titles) - playsOf(x.a.titles) - playsOf(x.b.titles))[0];
  return best ? { names: [best.a.name, best.b.name], photos: [best.a.photo, best.b.photo], films: best.films } : null;
}

function linkOf(cast: Map<string, Credit>): PeopleYear['link'] {
  const candidates = [...cast.values()]
    .map((credit) => ({ credit, shows: credit.titles.filter((title) => title.kind === 'series').sort(byPlays), films: credit.titles.filter((title) => title.kind === 'movie').sort(byPlays) }))
    .filter(({ shows, films }) => shows.length >= 1 && films.length >= 1)
    .sort((a, b) => Math.min(b.shows.length, b.films.length) - Math.min(a.shows.length, a.films.length) || b.films.length - a.films.length || playsOf(b.credit.titles) - playsOf(a.credit.titles));
  const best = candidates[0];
  if (!best) return null;
  return {
    name: best.credit.name,
    photo: best.credit.photo,
    show: { name: nameOf(best.shows[0]), poster: best.shows[0].facts?.poster ?? null },
    films: best.films.slice(0, LINK_FILMS).map((film) => ({ name: nameOf(film), poster: film.facts?.poster ?? null })),
  };
}

async function networksOf(config: any, shows: YearTitle[]): Promise<PeopleYear['networks']> {
  const plays = new Map<string, number>();
  for (const show of shows) {
    const name = show.facts?.networks[0];
    if (name) plays.set(name, (plays.get(name) ?? 0) + show.plays.length);
  }
  const top = [...plays].sort((a, b) => b[1] - a[1]).slice(0, NETWORKS);
  return mapWithConcurrency(top, 2, async ([name, count]) => ({ name, logo: await networkLogo(config, name), plays: count }));
}

export async function networkLogo(config: any, name: string): Promise<string | null> {
  try {
    const { resolveTmdbNetworkByName } = require('../../tmdb-network-index');
    const found = await resolveTmdbNetworkByName(name);
    const info = found ? await require('../../getTmdb').networkInfo(found.id, config) : null;
    return info?.logo_path ? `https://image.tmdb.org/t/p/w300${info.logo_path}` : null;
  } catch {
    return null;
  }
}

export async function peopleYear(config: any, titles: YearTitle[], anime: AnimeYear | null): Promise<PeopleYear> {
  const live = titles.filter((title) => !title.anime && title.facts);
  const films = live.filter((title) => title.kind === 'movie');
  const cast = credits(live, (title) => title.facts?.cast ?? []);
  const voice = voiceCard(anime);
  const actors = [...cast.values()].filter((credit) => credit.titles.length >= 2).sort(byReach).slice(0, voice ? CAST_CARDS - 1 : CAST_CARDS)
    .map((credit): PeopleCard => ({ name: credit.name, photo: credit.photo, titles: credit.titles.length, shown: [...credit.titles].sort(byPlays).slice(0, CAST_TITLES).map(nameOf), voiced: false }));
  const directors = [...credits(films, (title) => title.facts?.directors ?? []).values()].filter((credit) => credit.titles.length >= 2).sort(byReach).slice(0, DIRECTORS)
    .map((credit) => ({ name: credit.name, photo: credit.photo, films: credit.titles.length }));

  const themes = new Map<string, number>();
  for (const title of titles) for (const keyword of new Set((title.facts?.keywords ?? []).map((word) => word.toLowerCase()))) themes.set(keyword, (themes.get(keyword) ?? 0) + 1);

  return {
    cast: voice && actors.length ? [...actors, voice] : actors,
    directors,
    together: togetherOf(films),
    link: linkOf(cast),
    themes: [...themes].sort((a, b) => b[1] - a[1]).slice(0, THEMES).map(([name, n]) => [THEME_NAMES[name] ?? name, n]),
    books: themes.get(BOOK) ?? 0,
    manga: themes.get(MANGA) ?? 0,
    networks: await networksOf(config, titles.filter((title) => title.kind === 'series')),
  };
}
