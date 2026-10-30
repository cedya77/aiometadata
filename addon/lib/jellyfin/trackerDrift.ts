import { envInt } from '../../utils/envNumber';
import { parseStremioId } from './idsCodec';
import { groupBySpelling, getPlaystatesAcross, upsertPlaystateEverywhere, videoIdAliases } from './aliases';
import { scopeConfigToProfile } from './profiles';
import { credentialFor, type Capable } from './trackerSource';
import { isAnimeList, trackerOf } from '../trackers';
import { trackerConfig } from '../accounts';

const database: any = require('../database');
const idMappings: any = require('../id-mappings');

const DAY_MS = 24 * 60 * 60 * 1000;
const OWN_ORIGINS = new Set(['server', 'play']);
const WATCH_OPS = new Set(['scrobble', 'credit', 'catchUp', 'catchUps', 'anime', 'episodes']);
const batched = (service: string) => Boolean(trackerOf(service)?.writeWatches);
const rewatchOf = (service: string) => trackerOf(service)?.rewatch;

export interface DriftSource {
  service: Capable;
  credential: string;
  keys: Set<string>;
  scoped: any;
}

export interface Viewing {
  profile: string;
  at: number;
  ids: string[];
  kind: 'movie' | 'episode';
  metaId: string;
  season: number | null;
  episode: number | null;
  theirs?: number;
  origin?: string;
}

export interface Drift {
  behind: Viewing[];
  imported: Viewing[];
  leftOut: Record<string, number>;
  ahead: Viewing[];
  rewatched: Viewing[];
  unread: number;
  since: number;
  readAt: number | null;
}

export const driftWindowDays = (): number => envInt('JELLYFIN_TRACKER_DRIFT_DAYS', 30, 1);

export function viewingOf(profile: string, at: number, ids: string[]): Viewing | null {
  const parsed = ids.map((id) => ({ id, parsed: parseStremioId(id) })).find((entry) => entry.parsed);
  if (!parsed?.parsed) return null;
  const episode = parsed.parsed.episode ?? null;
  const seasoned = ids.map((id) => parseStremioId(id)).find((p) => p && p.season !== null && p.season !== undefined);
  return {
    profile,
    at,
    ids,
    kind: episode === null ? 'movie' : 'episode',
    metaId: episode === null ? parsed.id : parsed.parsed.base,
    season: seasoned?.season ?? null,
    episode,
  };
}

export function spellingsFor(service: string, ids: string[]): string[] {
  const order = isAnimeList(service) ? ['kitsu:', 'mal:', 'anilist:', 'tt', 'tvdb:', 'tmdb:'] : ['kitsu:', 'mal:', 'tt', 'tvdb:', 'tmdb:'];
  const ranked = order.flatMap((prefix) => ids.filter((id) => id.startsWith(prefix)));
  return ranked.length ? ranked : ids.slice(0, 1);
}

export function spellingFor(service: string, ids: string[]): string {
  return spellingsFor(service, ids)[0];
}

// An anime list keeps one entry per anime id, so the furthest viewing is kept per entry, in the numbering it is sent in.
export function furthestPerEntry(service: string, viewings: Viewing[], scope: (v: Viewing) => string = () => ''): Viewing[] {
  const furthest = new Map<string, { viewing: Viewing; reach: number }>();
  for (const viewing of viewings) {
    const sent = parseStremioId(spellingFor(service, viewing.ids));
    const key = `${scope(viewing)}|${sent?.base ?? viewing.metaId}`;
    const reach = sent?.episode ?? viewing.episode ?? 0;
    const held = furthest.get(key);
    if (!held || reach > held.reach) furthest.set(key, { viewing, reach });
  }
  return [...furthest.values()].map(({ viewing }) => viewing);
}

async function ownViewings(userUUID: string, profiles: Set<string>): Promise<Viewing[]> {
  const rows = (await database.listWatchesByOrigin(userUUID, [...OWN_ORIGINS])).filter((row: any) => profiles.has(row.profile));
  const byMoment = new Map<string, any[]>();
  for (const row of rows) {
    const key = `${row.profile}|${row.watched_at}`;
    if (!byMoment.has(key)) byMoment.set(key, []);
    byMoment.get(key)!.push({ video_id: row.video_id, last_played_at: row.watched_at, origin: 'server', profile: row.profile });
  }
  const out: Viewing[] = [];
  for (const moment of byMoment.values()) {
    for (const group of await groupBySpelling(moment)) {
      const viewing = viewingOf(group[0].profile, group[0].last_played_at, group.map((row: any) => String(row.video_id)));
      if (viewing) out.push(viewing);
    }
  }
  return out;
}

const coordinateOf = (id: string): string => {
  const parsed = parseStremioId(id);
  return parsed && parsed.episode !== null && parsed.episode !== undefined ? `${parsed.season ?? ''}:${parsed.episode}` : 'title';
};

// The title an id names, by its own base and the ids the mapping tables give it: a film's IMDb and TMDB ids share no alias.
function titlesOf(id: string): string[] {
  const parsed = parseStremioId(id);
  if (!parsed) return [id];
  const type = parsed.episode === null || parsed.episode === undefined ? 'movie' : 'series';
  const number = parsed.base.split(':')[1];
  try {
    const found = parsed.idType === 'imdb' ? idMappings.getByImdbId(parsed.base, type)
      : parsed.idType === 'tmdb' ? idMappings.getByTmdbId(number, type)
      : parsed.idType === 'tvdb' ? idMappings.getByTvdbId(number, type)
      : null;
    return [...new Set([parsed.base, found?.imdbId, found?.tmdbId && `tmdb:${found.tmdbId}`, found?.tvdbId && `tvdb:${found.tvdbId}`].filter(Boolean) as string[])];
  } catch {
    return [parsed.base];
  }
}

// An import writes every spelling of a title at one moment, but so does a list for every title of that day, and two
// titles each known by one id look the same as one known by two; spellings join only by alias or the mapping tables.
async function groupImported<T extends { video_id: any; last_played_at: number }>(rows: T[]): Promise<T[][]> {
  const groups = await groupBySpelling(rows.map((row) => ({ ...row, origin: null })));
  // What each id names, by itself and by its aliases, each at its own coordinate.
  const named = new Map<string, Array<{ coordinate: string; title: string }>>();
  for (const id of new Set(rows.map((row) => String(row.video_id)))) {
    const spellings = [id, ...(await videoIdAliases(id).catch(() => [] as string[]))];
    named.set(id, spellings.flatMap((spelling) => titlesOf(spelling).map((title) => ({ coordinate: coordinateOf(spelling), title }))));
  }
  const parent = groups.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const claimed = new Map<string, number>();
  groups.forEach((group, i) => {
    for (const row of group) {
      for (const { coordinate, title } of named.get(String(row.video_id)) ?? []) {
        const key = `${coordinate}|${title}`;
        const first = claimed.get(key);
        if (first === undefined) claimed.set(key, i);
        else parent[find(i)] = find(first);
      }
    }
  });
  const joined = new Map<number, T[]>();
  groups.forEach((group, i) => joined.set(find(i), [...(joined.get(find(i)) ?? []), ...group]));
  return [...joined.values()];
}

async function importedViewings(userUUID: string, profiles: Set<string>, origins: string[]): Promise<Viewing[]> {
  if (!origins.length) return [];
  const moments = new Map<string, any[]>();
  const add = (key: string, row: any) => {
    if (!moments.has(key)) moments.set(key, []);
    moments.get(key)!.push(row);
  };
  for (const row of await database.listWatchesByOrigin(userUUID, origins)) {
    if (profiles.has(row.profile)) add(`w|${row.profile}|${row.watched_at}|${row.origin}`, { video_id: row.video_id, last_played_at: row.watched_at, profile: row.profile, from: row.origin });
  }
  for (const row of await database.listUndatedPlaysByOrigin(userUUID, origins)) {
    // A mark keeps the date its source knew it was finished on; a position under way dates the resume instead.
    const at = row.position_ms > 0 ? 0 : row.last_played_at ?? 0;
    if (profiles.has(row.profile)) add(`m|${row.profile}|${at}|${row.origin}`, { video_id: row.video_id, last_played_at: at, profile: row.profile, from: row.origin, mark: true });
  }
  const watched: Viewing[] = [];
  const marked: Viewing[] = [];
  for (const moment of moments.values()) {
    for (const group of await groupImported(moment)) {
      const viewing = viewingOf(group[0].profile, group[0].last_played_at, group.map((row: any) => String(row.video_id)));
      if (viewing) (group[0].mark ? marked : watched).push({ ...viewing, origin: group[0].from });
    }
  }
  const seen = new Set(watched.flatMap((v) => v.ids.map((id) => `${v.profile}|${id}`)));
  return [...watched, ...marked.filter((v) => !v.ids.some((id) => seen.has(`${v.profile}|${id}`)))];
}

export function asListed(service: string, viewing: Viewing): Viewing {
  if (!isAnimeList(service) || viewing.kind !== 'movie') return viewing;
  const imdb = viewing.ids.find((id) => id.startsWith('tt'));
  const film = imdb ? require('../id-mapper').filmMappingFor({ imdbId: imdb }) : null;
  const listed = [film?.mal_id && `mal:${film.mal_id}`, film?.anilist_id && `anilist:${film.anilist_id}`, film?.kitsu_id && `kitsu:${film.kitsu_id}`].filter(Boolean) as string[];
  return listed.length ? { ...viewing, ids: [...new Set([...viewing.ids, ...listed])] } : viewing;
}

export function belongsOn(service: string, viewing: Viewing, config: any): boolean {
  const { shouldTrackServiceMediaType } = require('../watchTracking');
  if (!shouldTrackServiceMediaType(config, service, viewing.kind === 'movie' ? 'movie' : 'series')) return false;
  return !isAnimeList(service) || viewing.ids.some((id) => /^(kitsu|mal|anilist):/.test(id));
}

export async function driftFor(userUUID: string, source: DriftSource): Promise<Drift> {
  const { indexedSnapshot, watchedAmong, seriesCountsAmong } = require('./watched');
  const { pendingWatches } = require('../trackerOutbox');
  const { sourceKeyFor } = require('./trackerMirror');
  const sourceKey = sourceKeyFor(source.service, source.credential);
  const since = Date.now() - driftWindowDays() * DAY_MS;
  const state = await database.getTrackerSync(sourceKey).catch(() => null);
  const readAt = Number(state?.synced_at) || null;
  const empty: Drift = { behind: [], imported: [], leftOut: {}, ahead: [], rewatched: [], unread: 0, since, readAt };
  if (!readAt || !(Number(state?.version) > 0)) return empty;

  const snapshot = await indexedSnapshot(source.service, source.credential, source.scoped);
  if (!snapshot.source) return empty;
  const pending = await pendingWatches(source.service, source.credential).catch(() => []);
  const waiting = new Set<string>(pending.filter((p: any) => p.played).map((p: any) => String(p.videoId)));
  const unmarking = new Set<string>(pending.filter((p: any) => !p.played).map((p: any) => String(p.videoId)));
  const settled = readAt - envInt('JELLYFIN_TRACKER_DRIFT_SETTLE_MINUTES', 15, 0) * 60 * 1000;

  const mine = (await ownViewings(userUUID, source.keys)).map((v) => asListed(source.service, v)).filter((v) => belongsOn(source.service, v, source.scoped));
  const sent = new Map<string, number>();
  for (const row of (await database.listTrackerActivity([sourceKey], settled, 2000).catch(() => [])) as any[]) {
    if (row.kind !== 'sent' || !row.video || !WATCH_OPS.has(String(row.op))) continue;
    if (row.op === 'scrobble' && !String(row.detail ?? '').includes('"verb":"Watched"')) continue;
    let listed: string[] = [];
    if (row.op === 'catchUps' || row.op === 'episodes') {
      try {
        listed = JSON.parse(row.detail ?? '{}').videos ?? [];
      } catch {}
    }
    for (const video of [String(row.video), ...listed]) {
      const parsed = parseStremioId(video);
      const reach = isAnimeList(source.service) && parsed?.episode != null ? parsed.episode : Infinity;
      const key = isAnimeList(source.service) && parsed?.episode != null ? parsed.base : video;
      sent.set(key, Math.max(sent.get(key) ?? 0, reach));
    }
  }
  if (isAnimeList(source.service)) {
    for (const id of waiting) {
      const parsed = parseStremioId(id);
      if (parsed?.episode != null) sent.set(parsed.base, Math.max(sent.get(parsed.base) ?? 0, parsed.episode));
    }
  }
  const wasSent = (id: string) => {
    if (sent.has(id)) return true;
    const parsed = parseStremioId(id);
    return parsed?.episode != null && (sent.get(parsed.base) ?? 0) >= parsed.episode && sent.get(parsed.base) !== Infinity;
  };
  const { theirSpellings, unsentAmong } = require('./trackerMatch');
  const missingFrom = async (viewings: Viewing[]) => {
    const unsent: Set<string> = await unsentAmong(userUUID, source.service, [...new Set(viewings.flatMap((v) => v.ids))]).catch(() => new Set<string>());
    const judged = viewings.filter((v) => v.at <= settled && !v.ids.some(wasSent) && !v.ids.some((id) => unsent.has(id)));
    const ours = [...new Set(judged.flatMap((v) => v.ids))];
    const matched: Map<string, string[]> = await theirSpellings(userUUID, source.service, ours).catch(() => new Map());
    const held = await watchedAmong(snapshot, [...ours, ...[...matched.values()].flat()]);
    const missing = judged.filter((v) => !v.ids.some((id) => held.has(id) || waiting.has(id) || (matched.get(id) ?? []).some((theirs) => held.has(theirs))));
    const spelled = new Map<string, string[]>();
    for (const id of new Set(missing.flatMap((v) => v.ids))) spelled.set(id, await videoIdAliases(id).catch(() => [] as string[]));
    const heldElsewhere = await watchedAmong(snapshot, [...new Set([...spelled.values()].flat())]);
    const unspelled = missing.filter((v) => !v.ids.some((id) => (spelled.get(id) ?? []).some((alias) => heldElsewhere.has(alias) || waiting.has(alias))));
    const sentAs = await sendSpellings(userUUID, source, unspelled);
    const heldAsSent = await watchedAmong(snapshot, [...new Set([...sentAs.values()].flat())]);
    return { judged, matched, held, spelled, heldElsewhere, sentAs, heldAsSent, missing: unspelled.filter((v) => !(sentAs.get(v) ?? []).some((id) => heldAsSent.has(id))) };
  };
  const stillPlayed = async (viewings: Viewing[]) => {
    if (isAnimeList(source.service)) {
      const counts = await seriesCountsAmong(snapshot, [...new Set(viewings.flatMap((v) => v.ids.map((id) => parseStremioId(id)?.base ?? id)))]);
      viewings = viewings.filter((v) => !v.ids.some((id) => {
        const count = counts.get(parseStremioId(id)?.base ?? id);
        return v.at ? (count?.at ?? 0) > v.at : (count?.watched ?? 0) >= (v.episode ?? 1);
      }));
    }
    const states = await statesFor(userUUID, viewings);
    return viewings.filter((v) => v.ids.some((id) => Number(states.get(`${v.profile}|${id}`)?.played) === 1));
  };
  const own = await missingFrom(mine);
  const { judged, matched, held, spelled, heldElsewhere, sentAs, heldAsSent } = own;
  let behind = own.missing;
  let rewatched: Viewing[] = [];
  const rewatch = rewatchOf(source.service);
  if (rewatch) {
    const gap = envInt('JELLYFIN_TRACKER_REWATCH_GAP_HOURS', 48, 48) * 60 * 60 * 1000;
    // When each title was last sent, so a send stands only for the viewings made before it.
    const sentAt = new Map<string, number>();
    const noteSent = (video: string, at: number) => sentAt.set(video, Math.max(sentAt.get(video) ?? 0, at));
    for (const row of (await database.listTrackerActivity([sourceKey], since, 2000).catch(() => [])) as any[]) {
      if (row.kind !== 'sent' || !row.video || !WATCH_OPS.has(String(row.op))) continue;
      let detail: any = {};
      try {
        detail = JSON.parse(row.detail ?? '{}') ?? {};
      } catch {}
      if (rewatch.separate && detail.rewatch !== true) continue;
      if (row.op === 'scrobble' && detail.verb !== 'Watched') continue;
      noteSent(String(row.video), Number(row.at) || 0);
      if (row.op === 'catchUps' || row.op === 'episodes') for (const video of detail.videos ?? []) noteSent(String(video), Number(row.at) || 0);
    }
    const missing = new Set(behind);
    const heldAt = (v: Viewing) => Math.max(0, ...(sentAs.get(v) ?? []).map((id) => heldAsSent.get(id) ?? 0), ...v.ids.flatMap((id) => [
      held.get(id) ?? 0,
      ...(matched.get(id) ?? []).map((theirs) => held.get(theirs) ?? 0),
      ...(spelled.get(id) ?? []).map((alias) => heldElsewhere.get(alias) ?? 0),
    ]));
    rewatched = judged.filter((v) => {
      if (missing.has(v) || v.ids.some((id) => waiting.has(id) || (sentAt.get(id) ?? 0) >= v.at)) return false;
      const at = heldAt(v);
      return at > 0 && v.at - at > gap;
    }).map((v) => ({ ...v, theirs: heldAt(v) }));
    const again = await statesFor(userUUID, rewatched);
    rewatched = rewatched.filter((v) => v.ids.some((id) => Number(again.get(`${v.profile}|${id}`)?.played) === 1));
  }
  behind = await stillPlayed(behind);

  const origins = [...require('./historyTransfer').importedOrigins().keys()] as string[];
  const left = new Set<string>(((await database.listLeftOut(userUUID, sourceKey).catch(() => [])) as any[]).map((row) => `${row.profile}|${row.origin}|${row.video_id}`));
  const leftOut: Record<string, number> = {};
  const brought = (await importedViewings(userUUID, source.keys, origins)).map((v) => asListed(source.service, v)).filter((v) => {
    if (!belongsOn(source.service, v, source.scoped)) return false;
    if (!v.ids.some((id) => left.has(`${v.profile}|${v.origin}|${id}`))) return true;
    leftOut[v.origin!] = (leftOut[v.origin!] ?? 0) + 1;
    return false;
  });
  const ownMissing = new Set(behind.flatMap((v) => v.ids.map((id) => `${v.profile}|${id}`)));
  const imported = brought.length
    ? (await stillPlayed((await missingFrom(brought)).missing)).filter((v) => !v.ids.some((id) => ownMissing.has(`${v.profile}|${id}`)))
    : [];

  const ahead = isAnimeList(source.service) ? [] : await aheadOf(userUUID, source, sourceKey, since, unmarking);
  return { behind, imported, leftOut, ahead, rewatched, unread: mine.filter((v) => v.at > settled).length, since, readAt };
}

async function sendSpellings(userUUID: string, source: DriftSource, viewings: Viewing[]): Promise<Map<Viewing, string[]>> {
  const out = new Map<Viewing, string[]>();
  if (!viewings.length || isAnimeList(source.service)) return out;
  const { parseMediaId, historyTarget } = require('../subtitleHandler');
  const { mapWithConcurrency } = require('../../utils/concurrency');
  const config = { ...trackerConfig(source.scoped, source.service), userUUID };
  await mapWithConcurrency(viewings, 4, async (v: Viewing) => {
    const media = parseMediaId(spellingFor(source.service, v.ids));
    const target = media ? await historyTarget(media, config, source.service).catch(() => null) : null;
    if (target) out.set(v, targetSpellings(target, v.kind));
  });
  return out;
}

function targetSpellings(target: { ids: Record<string, any>; season?: number; episode?: number }, kind: Viewing['kind']): string[] {
  const { imdb, tmdb, tvdb } = target.ids;
  const bases = [/^tt\d+$/.test(String(imdb ?? '')) ? String(imdb) : null, tmdb ? `tmdb:${tmdb}` : null, tvdb ? `tvdb:${tvdb}` : null].filter((base): base is string => Boolean(base));
  if (kind === 'movie') return bases;
  return target.season != null && target.episode != null ? bases.map((base) => `${base}:${target.season}:${target.episode}`) : [];
}

async function statesFor(userUUID: string, viewings: Viewing[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const byProfile = new Map<string, string[]>();
  for (const v of viewings) byProfile.set(v.profile, [...(byProfile.get(v.profile) ?? []), ...v.ids]);
  for (const [profile, ids] of byProfile) {
    const rows: Map<string, any> = await getPlaystatesAcross(userUUID, [...new Set(ids)], profile);
    for (const [id, row] of rows) out.set(`${profile}|${id}`, row);
  }
  return out;
}

async function aheadOf(userUUID: string, source: DriftSource, sourceKey: string, since: number, unmarking: Set<string>): Promise<Viewing[]> {
  const rows: any[] = await database.watchIndexSince(sourceKey, since);
  const { ourSpellings } = require('./trackerMatch');
  const candidates: Viewing[] = [];
  for (const row of rows) {
    const ours: string[] = await ourSpellings(userUUID, source.service, String(row.video_id)).catch(() => []);
    const ids = [...ours, String(row.video_id), ...(await videoIdAliases(String(row.video_id)).catch(() => [] as string[]))];
    if (ids.some((id) => unmarking.has(id))) continue;
    const viewing = viewingOf('', row.at, ids);
    if (viewing) candidates.push(viewing);
  }
  if (!candidates.length) return [];
  const spellings = [...new Set(candidates.flatMap((v) => v.ids))];
  const out: Viewing[] = [];
  const seen = new Map<string, Set<string>>();
  const states = new Map<string, Map<string, any>>();
  for (const profile of source.keys) {
    seen.set(profile, new Set((await database.listWatchesFor(userUUID, profile, spellings)).map((w: any) => String(w.video_id))));
    states.set(profile, await getPlaystatesAcross(userUUID, spellings, profile));
  }
  for (const viewing of candidates) {
    const here = [...source.keys].some((profile) => viewing.ids.some((id) => {
      const row = states.get(profile)?.get(id);
      return seen.get(profile)?.has(id) || Number(row?.played) === 1 || (row && Number(row.updated_at) > viewing.at);
    }));
    if (!here) out.push(viewing);
  }
  return out;
}

const pushing = new Map<string, Promise<unknown>>();

// A send from the dashboard and the resend after a read can each work out the same viewings, so one account's pushes
// run in turn and leave out what the one before already queued.
export function pushDrift(userUUID: string, config: any, source: DriftSource, viewings: Viewing[], again: Viewing[] = []): Promise<number> {
  const key = `${source.service}|${source.credential}`;
  const run = (pushing.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const { pendingWatches } = require('../trackerOutbox');
    const queued = new Set<string>((await pendingWatches(source.service, source.credential).catch(() => [])).filter((p: any) => p.played).map((p: any) => String(p.videoId)));
    const fresh = (v: Viewing) => !v.ids.some((id) => queued.has(id));
    return queueDrift(userUUID, config, source, viewings.filter(fresh), again.filter(fresh));
  });
  pushing.set(key, run);
  run.finally(() => {
    if (pushing.get(key) === run) pushing.delete(key);
  }).catch(() => undefined);
  return run;
}

async function queueDrift(userUUID: string, config: any, source: DriftSource, viewings: Viewing[], again: Viewing[]): Promise<number> {
  const { enqueueTrackerWrites } = require('../trackerOutbox');
  const byProfile = new Map<string, Viewing[]>();
  if (isAnimeList(source.service)) viewings = furthestPerEntry(source.service, viewings, (v) => v.profile);
  for (const v of viewings) byProfile.set(v.profile, [...(byProfile.get(v.profile) ?? []), v]);
  const rewatches = new Map<string, Viewing[]>();
  if (batched(source.service)) {
    for (const v of again) {
      byProfile.set(v.profile, byProfile.get(v.profile) ?? []);
      rewatches.set(v.profile, [...(rewatches.get(v.profile) ?? []), v]);
    }
  }
  let queued = 0;
  for (const [profile, list] of byProfile) {
    const scoped = scopeConfigToProfile(config, userUUID, profile || null);
    if (!credentialFor(scoped, source.service)) continue;
    if (batched(source.service)) {
      const size = envInt('JELLYFIN_COPY_BATCH_SIZE', 100, 1);
      const sets: Array<{ list: Viewing[]; rewatch: boolean }> = [];
      const repeat = rewatches.get(profile) ?? [];
      if (rewatchOf(source.service)?.separate) {
        sets.push({ list, rewatch: false });
        const byShow = new Map<string, Viewing[]>();
        for (const v of repeat) byShow.set(v.metaId, [...(byShow.get(v.metaId) ?? []), v]);
        for (const show of byShow.values()) sets.push({ list: show, rewatch: true });
      } else {
        sets.push({ list: [...list, ...repeat], rewatch: false });
      }
      const jobs = [];
      for (const set of sets) {
        const ordered = [...set.list].sort((a, b) => a.at - b.at);
        for (let i = 0; i < ordered.length; i += size) {
          const chunk = ordered.slice(i, i + size);
          jobs.push({
            service: source.service,
            op: 'catchUps' as const,
            item: 'catch-up',
            coalesce: `catchUps:${set.rewatch ? 'again:' : ''}${spellingFor(source.service, chunk[0].ids)}:${chunk[0].at}:${chunk.length}`,
            payload: {
              items: chunk.map((v) => ({ ids: spellingsFor(source.service, v.ids), kind: v.kind, metaId: v.metaId, season: v.season, episode: v.episode, at: v.at })),
              ...(set.rewatch ? { rewatch: true } : {}),
            },
          });
        }
      }
      await enqueueTrackerWrites(userUUID, scoped, jobs);
      queued += list.length + repeat.length;
      continue;
    }
    await enqueueTrackerWrites(userUUID, scoped, list.map((v) => {
      const id = spellingFor(source.service, v.ids);
      return {
        service: source.service,
        op: 'catchUp',
        item: v.metaId,
        coalesce: `catchUp:${id}:${v.at}`,
        payload: { type: v.kind === 'movie' ? 'movie' : 'series', id, at: v.at },
      };
    }));
    queued += list.length;
  }
  return queued;
}

export async function pullDrift(userUUID: string, source: DriftSource, viewings: Viewing[]): Promise<number> {
  let added = 0;
  for (const viewing of viewings) {
    const video = spellingFor(source.service, viewing.ids);
    for (const profile of source.keys) {
      const row = (await getPlaystatesAcross(userUUID, [video], profile)).get(video);
      if (row && Number(row.played) === 1) {
        for (const id of viewing.ids) await database.logWatch(userUUID, profile, id, { at: viewing.at, kind: 'dated' }, true, source.service);
      } else {
        await upsertPlaystateEverywhere(userUUID, video, { positionMs: 0, played: true, lastPlayedAt: viewing.at, origin: source.service, watch: { at: viewing.at, kind: 'dated' } }, profile, viewing.ids);
      }
      added += 1;
    }
  }
  return added;
}

function passing(detail: any): boolean {
  const status = Number(detail?.status);
  return !Number.isFinite(status) || detail?.status === null || status === 0 || status === 429 || status >= 500 || /disabled|did not answer/i.test(String(detail?.reason ?? ''));
}

/** Whether the account keeps a second viewing of a title it already holds. */
export async function keepsRewatches(source: { service: string; credential: string }): Promise<boolean> {
  const kept = rewatchOf(source.service)?.kept;
  return kept ? kept(source.credential) : true;
}

const recovering = new Map<string, number>();

export async function recoverFailed(sourceKey: string, service: Capable): Promise<number> {
  const now = Date.now();
  if (now - (recovering.get(sourceKey) ?? 0) < envInt('JELLYFIN_TRACKER_RECOVER_MINUTES', 10, 1) * 60 * 1000) return 0;
  recovering.set(sourceKey, now);
  const { readGlobalCache, writeGlobalCache } = require('../getCache');
  const since = now - driftWindowDays() * DAY_MS;
  const failed = ((await database.listTrackerActivity([sourceKey], since, 2000)) as any[]).filter((row) => {
    if (row.kind !== 'failed' || !row.video || !row.user_uuid || !WATCH_OPS.has(String(row.op))) return false;
    try {
      return passing(JSON.parse(row.detail ?? '{}'));
    } catch {
      return false;
    }
  });
  let queued = 0;
  const byOwner = new Map<string, any[]>();
  for (const row of failed) {
    if (await readGlobalCache(`tracker_recovered:${row.id}`)) continue;
    const owner = `${row.user_uuid}|${row.profile ?? ''}`;
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), row]);
  }
  for (const [owner, rows] of byOwner) {
    const [userUUID, profile] = owner.split('|');
    const config = await database.getUserConfig(userUUID).catch(() => null);
    if (!config) continue;
    const scoped = { ...scopeConfigToProfile(config, userUUID, profile || null), userUUID };
    const credential = credentialFor(scoped, service);
    const { sourceKeyFor } = require('./trackerMirror');
    if (!credential || sourceKeyFor(service, credential) !== sourceKey) continue;
    const source: DriftSource = { service, credential, keys: new Set([profile]), scoped };
    const drift = await driftFor(userUUID, source);
    // A failed batch names its first title in the row and every title in its detail.
    const videosOf = (row: any): string[] => {
      let detail: any = {};
      try {
        detail = JSON.parse(row.detail ?? '{}') ?? {};
      } catch {}
      return [String(row.video), ...(Array.isArray(detail.videos) ? detail.videos.map(String) : [])];
    };
    const reaches = (videos: string[]) => (v: Viewing) => v.ids.some((id) => videos.some((video) => {
      if (video === id) return true;
      const a = parseStremioId(video);
      const b = parseStremioId(id);
      return isAnimeList(service) && a?.episode != null && b?.episode != null && a.base === b.base && b.episode <= a.episode;
    }));
    const wanted = reaches(rows.flatMap(videosOf));
    const rewatches = drift.rewatched.filter(wanted);
    const again = rewatches.length && await keepsRewatches(source) ? rewatches : [];
    queued += await pushDrift(userUUID, config, source, [...drift.behind, ...drift.imported].filter(wanted), again);
    // A rewatch the tracker will not keep is left for a later read rather than marked recovered.
    const unsent = again.length ? [] : rewatches;
    for (const row of rows) {
      if (unsent.some(reaches(videosOf(row)))) continue;
      await writeGlobalCache(`tracker_recovered:${row.id}`, { at: now }, driftWindowDays() * 24 * 60 * 60);
    }
  }
  return queued;
}
