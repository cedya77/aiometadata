import { envInt } from '../../../utils/envNumber';
import { episodeKey, factsRequests, spelledAsAnime, titleFacts, type TitleFacts } from './facts';
import { safeTimeZone, type YearPlay } from './plays';

const database: any = require('../../database');

const DAY_MS = 24 * 60 * 60 * 1000;

export type RuntimeSource = 'played' | 'episode' | 'title' | 'average' | 'estimate';

export interface TimedPlay extends YearPlay {
  runtimeMs: number;
  runtimeSource: RuntimeSource;
  day: string;
  overfull: boolean;
}

export interface YearTitle {
  key: string;
  kind: 'movie' | 'series';
  facts: TitleFacts | null;
  anime: boolean;
  plays: TimedPlay[];
  watchMs: number;
}

export interface TimedYear {
  plays: TimedPlay[];
  titles: YearTitle[];
  counts: { stored: number; built: number; held: number; missing: number; merged: number; overfullDays: number; sources: Record<RuntimeSource, number> };
}

function dayOf(timeZone: string): (at: number) => string {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: safeTimeZone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit' });
  return (at) => format.format(new Date(at));
}

function identities(facts: TitleFacts): string[] {
  const out = [`${facts.kind}:id:${facts.id}`];
  if (facts.ids.imdb) out.push(`${facts.kind}:imdb:${facts.ids.imdb}`);
  if (facts.ids.tmdb) out.push(`${facts.kind}:tmdb:${facts.ids.tmdb}`);
  return out;
}

function mergeTitles(keys: string[], facts: Map<string, TitleFacts>, weight: Map<string, number>): Map<string, string> {
  const owner = new Map<string, string>();
  const parent = new Map<string, string>(keys.map((key) => [key, key]));
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(key, root);
    return root;
  };
  for (const key of keys) {
    const held = facts.get(key);
    if (!held) continue;
    for (const identity of identities(held)) {
      const seen = owner.get(identity);
      if (!seen) owner.set(identity, key);
      else if (find(seen) !== find(key)) parent.set(find(seen), find(key));
    }
  }
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const members = groups.get(find(key));
    if (members) members.push(key);
    else groups.set(find(key), [key]);
  }
  const into = new Map<string, string>();
  for (const members of groups.values()) {
    const lead = [...members].sort((a, b) => Number(facts.has(b)) - Number(facts.has(a)) || Number(b.startsWith('tt')) - Number(a.startsWith('tt')) || (weight.get(b) ?? 0) - (weight.get(a) ?? 0) || a.localeCompare(b))[0];
    for (const member of members) into.set(member, lead);
  }
  return into;
}

function episodeRuntime(facts: TitleFacts | undefined, play: YearPlay): number {
  if (!facts || play.episode === null) return 0;
  return facts.episodeRuntimes[episodeKey(play.season, play.episode)]
    ?? (play.season === null ? facts.episodeRuntimes[episodeKey(1, play.episode)] : undefined)
    ?? 0;
}

function sameViewingMs(runtimeMs: number, linked: boolean): number {
  if (runtimeMs <= 0) return envInt('JELLYFIN_REWATCH_MIN_GAP_MINUTES', 10, 0) * 60_000;
  return linked ? runtimeMs / 2 : runtimeMs;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export async function timeYear(userUUID: string, historyKey: string, plays: YearPlay[], timeZone: string): Promise<TimedYear> {
  const requests = factsRequests(plays);
  const { facts, stored, built, held, missing } = await titleFacts(userUUID, requests);

  const played = new Map<string, number>();
  for (const row of await database.listPlayedForProfile(userUUID, historyKey)) {
    const runtime = Number(row.runtime_ms) || 0;
    if (runtime > 0) played.set(String(row.video_id), runtime);
  }

  const day = dayOf(timeZone);
  const timed: TimedPlay[] = plays.map((play) => {
    const ownFacts = facts.get(play.titleKey);
    const fromPlaystate = play.spellings.map((id) => played.get(id) ?? 0).find((runtime) => runtime > 0) ?? 0;
    const fromEpisode = episodeRuntime(ownFacts, play);
    const fromTitle = ownFacts?.runtimeMs ?? 0;
    const [runtimeMs, runtimeSource]: [number, RuntimeSource] = fromPlaystate > 0 ? [fromPlaystate, 'played']
      : fromEpisode > 0 ? [fromEpisode, 'episode']
        : fromTitle > 0 ? [fromTitle, 'title']
          : [0, 'average'];
    return { ...play, runtimeMs, runtimeSource, day: day(play.at), overfull: false };
  });

  const knownByTitle = new Map<string, number[]>();
  for (const play of timed) {
    if (play.runtimeMs <= 0) continue;
    const known = knownByTitle.get(play.titleKey);
    if (known) known.push(play.runtimeMs);
    else knownByTitle.set(play.titleKey, [play.runtimeMs]);
  }
  const fallback = {
    movie: median(timed.filter((play) => play.kind === 'movie' && play.runtimeMs > 0).map((play) => play.runtimeMs)),
    episode: median(timed.filter((play) => play.kind === 'episode' && play.runtimeMs > 0).map((play) => play.runtimeMs)),
  };
  for (const play of timed) {
    if (play.runtimeMs > 0) continue;
    const average = median(knownByTitle.get(play.titleKey) ?? []);
    if (average > 0) play.runtimeMs = average;
    else {
      play.runtimeMs = fallback[play.kind];
      play.runtimeSource = 'estimate';
    }
  }

  const weight = new Map(requests.map((request) => [request.titleKey, request.weight]));
  const into = mergeTitles(requests.map((request) => request.titleKey), facts, weight);
  const anime = spelledAsAnime(plays);
  const titles = new Map<string, YearTitle>();
  const lastAt = new Map<string, TimedPlay>();
  const kept: TimedPlay[] = [];
  for (const play of timed) {
    const key = into.get(play.titleKey) ?? play.titleKey;
    const title = titles.get(key) ?? { key, kind: play.kind === 'movie' ? 'movie' as const : 'series' as const, facts: facts.get(key) ?? null, anime: false, plays: [], watchMs: 0 };
    title.anime ||= anime.has(play.titleKey) || !!facts.get(play.titleKey)?.anime;
    titles.set(key, title);
    play.titleKey = key;
    const viewing = `${key}|${play.episode === null ? '' : episodeKey(play.season, play.episode)}`;
    const previous = lastAt.get(viewing);
    const linked = !!previous && previous.spellings.some((id) => play.spellings.includes(id));
    if (previous && play.at - previous.at < sameViewingMs(play.runtimeMs, linked)) continue;
    lastAt.set(viewing, play);
    title.plays.push(play);
    title.watchMs += play.runtimeMs;
    kept.push(play);
  }

  const dayTotals = new Map<string, number>();
  for (const play of kept) dayTotals.set(play.day, (dayTotals.get(play.day) ?? 0) + play.runtimeMs);
  const overfull = new Set([...dayTotals].filter(([, total]) => total > DAY_MS).map(([key]) => key));
  for (const play of kept) play.overfull = overfull.has(play.day);

  const sources = { played: 0, episode: 0, title: 0, average: 0, estimate: 0 };
  for (const play of kept) sources[play.runtimeSource] += 1;
  return {
    plays: kept,
    titles: [...titles.values()].sort((a, b) => b.watchMs - a.watchMs),
    counts: { stored, built, held, missing, merged: requests.length - titles.size, overfullDays: overfull.size, sources },
  };
}
