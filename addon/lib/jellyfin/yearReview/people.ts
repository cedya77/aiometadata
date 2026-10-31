import { LRUCache } from 'lru-cache';
import { mapWithConcurrency } from '../../../utils/concurrency';
import { personIdOf } from '../items';
import type { AnimeYear } from './anime';
import { metaIdOf } from './plays';
import type { FactsPerson } from './facts';
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

export interface TitleRef {
  name: string;
  key: string;
  kind: 'movie' | 'series';
  poster: string | null;
}

export interface PersonRef {
  id: string;
  name: string;
  photo: string | null;
}

export interface PeopleCard extends PersonRef {
  titles: number;
  shown: TitleRef[];
  voiced: boolean;
}

export interface PeopleYear {
  cast: PeopleCard[];
  directors: Array<PersonRef & { films: number }>;
  together: { people: [PersonRef, PersonRef]; films: number } | null;
  link: (PersonRef & { show: TitleRef; films: TitleRef[] }) | null;
  themes: Array<[string, number]>;
  books: number;
  manga: number;
  networks: Array<{ name: string; logo: string | null; plays: number }>;
}

// Accents are folded off Latin names; any other script is kept, so a name in Hangul or kanji still has a key.
const personKey = (name: string): string => name.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const nameOf = (title: YearTitle): string => (title.facts?.name ?? metaIdOf(title.key)).replace(/\s+\(\d{4}\)$/, '');
const refOf = (title: YearTitle): TitleRef => ({ name: nameOf(title), key: title.key, kind: title.kind, poster: title.facts?.poster ?? null });

interface Credit {
  name: string;
  photo: string | null;
  member: FactsPerson;
  titles: YearTitle[];
}

const personOf = (credit: Credit): PersonRef => ({ id: personIdOf(credit.member), name: credit.name, photo: credit.photo });

function credits(titles: YearTitle[], pick: (title: YearTitle) => FactsPerson[]): Map<string, Credit> {
  const out = new Map<string, Credit>();
  for (const title of titles) {
    const seen = new Set<string>();
    for (const person of pick(title)) {
      const key = personKey(person.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const held = out.get(key) ?? { name: person.name, photo: null, member: person, titles: [] };
      held.photo = held.photo ?? person.photo;
      if (!held.member.tmdbId && !held.member.tvdbId && (person.tmdbId || person.tvdbId)) held.member = person;
      held.titles.push(title);
      out.set(key, held);
    }
  }
  return out;
}

const playsOf = (titles: YearTitle[]): number => titles.reduce((total, title) => total + title.plays.length, 0);
const byReach = (a: Credit, b: Credit): number => b.titles.length - a.titles.length || playsOf(b.titles) - playsOf(a.titles);
const byPlays = (a: YearTitle, b: YearTitle): number => b.plays.length - a.plays.length || b.watchMs - a.watchMs;

function voiceCard(anime: AnimeYear | null, titles: Map<string, YearTitle>): PeopleCard | null {
  const voice = anime?.voices[0];
  if (!voice) return null;
  const keyOf = new Map(anime!.entries.map((entry) => [entry.malId, entry.titleKey]));
  const entryOf = new Map(anime!.entries.map((entry) => [entry.titleKey, entry]));
  const keys = [...new Set(voice.roles.flatMap((role) => role.entries.map((id) => keyOf.get(id)).filter((key): key is string => !!key)))];
  if (keys.length < 2) return null;
  const shown = keys.slice(0, CAST_TITLES).map((key): TitleRef => {
    const title = titles.get(key);
    const entry = entryOf.get(key);
    return { name: entry?.name ?? (title ? nameOf(title) : key), key, kind: title?.kind ?? 'series', poster: entry?.image ?? title?.facts?.poster ?? null };
  });
  return { id: personIdOf({ name: voice.name }), name: voice.name, photo: voice.image, titles: keys.length, shown, voiced: true };
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
  return best ? { people: [personOf(best.a), personOf(best.b)], films: best.films } : null;
}

function linkOf(cast: Map<string, Credit>): PeopleYear['link'] {
  const candidates = [...cast.values()]
    .map((credit) => ({ credit, shows: credit.titles.filter((title) => title.kind === 'series').sort(byPlays), films: credit.titles.filter((title) => title.kind === 'movie').sort(byPlays) }))
    .filter(({ shows, films }) => shows.length >= 1 && films.length >= 1)
    .sort((a, b) => Math.min(b.shows.length, b.films.length) - Math.min(a.shows.length, a.films.length) || b.films.length - a.films.length || playsOf(b.credit.titles) - playsOf(a.credit.titles));
  const best = candidates[0];
  if (!best) return null;
  return { ...personOf(best.credit), show: refOf(best.shows[0]), films: best.films.slice(0, LINK_FILMS).map(refOf) };
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

// The top show's network is asked for by the review and again by its networks, so one lookup serves both.
const logos = new LRUCache<string, Promise<string | null>>({ max: 500, ttl: 24 * 60 * 60 * 1000 });

export function networkLogo(config: any, name: string): Promise<string | null> {
  const held = logos.get(name);
  if (held) return held;
  const found = readNetworkLogo(config, name);
  logos.set(name, found);
  // A failed lookup reads as no logo, so it is not kept.
  void found.then((logo) => {
    if (logo === null) logos.delete(name);
  });
  return found;
}

async function readNetworkLogo(config: any, name: string): Promise<string | null> {
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
  const voice = voiceCard(anime, new Map(titles.map((title) => [title.key, title])));
  const actors = [...cast.values()].filter((credit) => credit.titles.length >= 2).sort(byReach).slice(0, voice ? CAST_CARDS - 1 : CAST_CARDS)
    .map((credit): PeopleCard => ({ ...personOf(credit), titles: credit.titles.length, shown: [...credit.titles].sort(byPlays).slice(0, CAST_TITLES).map(refOf), voiced: false }));
  const directors = [...credits(films, (title) => title.facts?.directors ?? []).values()].filter((credit) => credit.titles.length >= 2).sort(byReach).slice(0, DIRECTORS)
    .map((credit) => ({ ...personOf(credit), films: credit.titles.length }));

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
