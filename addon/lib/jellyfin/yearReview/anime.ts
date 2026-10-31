import { envInt } from '../../../utils/envNumber';
import { mapWithConcurrency } from '../../../utils/concurrency';
import { parseStremioId } from '../idsCodec';
import type { TimedPlay, TimedYear } from './timed';

const idMapper: any = require('../../id-mapper');
const mal: any = require('../../mal');

const VOICES = 8;
const VOICE_NAMES = 4;

export interface AnimeEntry {
  malId: number;
  titleKey: string;
  name: string;
  title: string | null;
  japanese: string | null;
  type: string | null;
  year: number | null;
  season: string | null;
  airedFrom: string | null;
  airedTo: string | null;
  status: string | null;
  episodesTotal: number | null;
  episodes: number;
  plays: number;
  watchMs: number;
  firstAt: number;
  image: string | null;
  rank: number | null;
  score: number | null;
  source: string | null;
  studios: string[];
  genres: string[];
  themes: string[];
  demographics: string[];
}

export interface AnimeVoice {
  malId: number;
  name: string;
  japanese: string | null;
  image: string | null;
  episodes: number;
  roles: Array<{ character: string; image: string | null; entries: number[] }>;
}

export interface AnimeYear {
  entries: AnimeEntry[];
  voices: AnimeVoice[];
  missing: number;
  unmatched: number;
}

const flipped = (name: string | null | undefined): string => {
  const parts = String(name ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  return parts.length === 2 ? `${parts[1]} ${parts[0]}` : String(name ?? '').trim();
};

function entryOf(play: TimedPlay): { malId: number; episode: string } | null {
  for (const prefix of ['mal', 'kitsu']) {
    for (const id of play.spellings) {
      if (!id.startsWith(`${prefix}:`)) continue;
      const parsed = parseStremioId(id);
      const numeric = Number(String(parsed?.base ?? id).split(':')[1]);
      if (!Number.isFinite(numeric)) continue;
      const malId = prefix === 'mal' ? numeric : Number(idMapper.getMappingByKitsuId(numeric)?.mal_id);
      if (!Number.isFinite(malId) || malId <= 0) continue;
      return { malId, episode: parsed?.episode === null || parsed?.episode === undefined ? 'film' : String(parsed.episode) };
    }
  }
  return null;
}

export async function animeYear(timed: TimedYear): Promise<AnimeYear | null> {
  const grouped = new Map<number, { titleKey: string; episodes: Set<string>; plays: number; watchMs: number; firstAt: number }>();
  let unmatched = 0;
  let animePlays = 0;
  for (const title of timed.titles) {
    if (!title.anime) continue;
    for (const play of title.plays) {
      animePlays += 1;
      const found = entryOf(play);
      if (!found) {
        unmatched += 1;
        continue;
      }
      const entry = grouped.get(found.malId) ?? { titleKey: title.key, episodes: new Set<string>(), plays: 0, watchMs: 0, firstAt: play.at };
      entry.episodes.add(found.episode);
      entry.plays += 1;
      entry.watchMs += play.runtimeMs;
      entry.firstAt = Math.min(entry.firstAt, play.at);
      grouped.set(found.malId, entry);
    }
  }
  if (!animePlays) return null;
  if (!grouped.size) return { entries: [], voices: [], missing: 0, unmatched };

  const ranked = [...grouped.entries()].sort((a, b) => b[1].episodes.size - a[1].episodes.size || b[1].watchMs - a[1].watchMs);
  const factsBudget = envInt('JELLYFIN_YEAR_REVIEW_ANIME_ENTRIES', 80, 0);
  const castBudget = envInt('JELLYFIN_YEAR_REVIEW_ANIME_CAST', 40, 0);
  const facts = await mapWithConcurrency(ranked.slice(0, factsBudget), 1, async ([malId]) => mal.getAnimeFactsCached(malId));

  const entries: AnimeEntry[] = [];
  ranked.slice(0, factsBudget).forEach(([malId, held], i) => {
    const fact = facts[i];
    if (!fact) return;
    entries.push({
      malId,
      titleKey: held.titleKey,
      name: fact.title_english || fact.title || String(malId),
      title: fact.title ?? null,
      japanese: fact.title_japanese ?? null,
      type: fact.type ?? null,
      year: fact.year ?? (fact.aired?.from ? new Date(fact.aired.from).getUTCFullYear() : null),
      season: fact.season ?? null,
      airedFrom: fact.aired?.from ?? null,
      airedTo: fact.aired?.to ?? null,
      status: fact.status ?? null,
      episodesTotal: fact.episodes ?? null,
      episodes: held.episodes.size,
      plays: held.plays,
      watchMs: held.watchMs,
      firstAt: held.firstAt,
      image: fact.image ?? null,
      rank: fact.rank ?? null,
      score: fact.score ?? null,
      source: fact.source ?? null,
      studios: fact.studios ?? [],
      genres: fact.genres ?? [],
      themes: fact.themes ?? [],
      demographics: fact.demographics ?? [],
    });
  });

  const casts = await mapWithConcurrency(entries.slice(0, castBudget), 1, async (entry) => mal.getAnimeCastCached(entry.malId));
  const voices = new Map<number, AnimeVoice & { characters: Map<number, AnimeVoice['roles'][number]>; titles: Set<string> }>();
  entries.slice(0, castBudget).forEach((entry, i) => {
    for (const member of casts[i] ?? []) {
      if (member.role !== 'Main' || !member.voice?.mal_id || !member.character?.mal_id) continue;
      const voice = voices.get(member.voice.mal_id) ?? { malId: member.voice.mal_id, name: flipped(member.voice.name), japanese: null, image: member.voice.image ?? null, episodes: 0, roles: [], characters: new Map(), titles: new Set<string>() };
      const role = voice.characters.get(member.character.mal_id) ?? { character: flipped(member.character.name), image: member.character.image ?? null, entries: [] };
      if (!role.entries.includes(entry.malId)) {
        role.entries.push(entry.malId);
        voice.episodes += entry.episodes;
      }
      voice.characters.set(member.character.mal_id, role);
      voice.titles.add(entry.titleKey);
      voices.set(voice.malId, voice);
    }
  });
  const top = [...voices.values()].sort((a, b) => b.titles.size - a.titles.size || b.characters.size - a.characters.size || b.episodes - a.episodes).slice(0, VOICES);
  const names = await mapWithConcurrency(top.slice(0, VOICE_NAMES), 1, async (voice) => mal.getPersonNameCached(voice.malId));
  return {
    entries,
    voices: top.map(({ characters, titles, ...voice }, i) => {
      const person = names[i];
      const japanese = person?.family_name || person?.given_name ? `${person.family_name ?? ''}${person.given_name ?? ''}` : null;
      return { ...voice, japanese, roles: [...characters.values()] };
    }),
    missing: grouped.size - entries.length,
    unmatched,
  };
}
