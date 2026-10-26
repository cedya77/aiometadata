import { envInt } from '../../utils/envNumber';
import { parseStremioId } from './idsCodec';
import { groupBySpelling, getPlaystatesAcross, upsertPlaystateEverywhere, videoIdAliases } from './aliases';
import { scopeConfigToProfile } from './profiles';
import { credentialFor, type Capable } from './trackerSource';

const database: any = require('../database');

const DAY_MS = 24 * 60 * 60 * 1000;
const ANIME_LISTS = new Set<string>(['anilist', 'mal']);
const OWN_ORIGINS = new Set(['server', 'play']);
const WATCH_OPS = new Set(['scrobble', 'credit', 'catchUp', 'catchUps', 'anime', 'episodes']);
const BATCHED = new Set<string>(['simkl', 'mdblist']);
const REWATCHABLE = new Set<string>(['simkl', 'mdblist']);

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
}

export interface Drift {
  behind: Viewing[];
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
  const order = ANIME_LISTS.has(service) ? ['kitsu:', 'mal:', 'anilist:', 'tt', 'tvdb:', 'tmdb:'] : ['kitsu:', 'mal:', 'tt', 'tvdb:', 'tmdb:'];
  const ranked = order.flatMap((prefix) => ids.filter((id) => id.startsWith(prefix)));
  return ranked.length ? ranked : ids.slice(0, 1);
}

export function spellingFor(service: string, ids: string[]): string {
  return spellingsFor(service, ids)[0];
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

export function asListed(service: string, viewing: Viewing): Viewing {
  if (!ANIME_LISTS.has(service) || viewing.kind !== 'movie') return viewing;
  const imdb = viewing.ids.find((id) => id.startsWith('tt'));
  const film = imdb ? require('../id-mapper').filmMappingFor({ imdbId: imdb }) : null;
  const listed = [film?.mal_id && `mal:${film.mal_id}`, film?.anilist_id && `anilist:${film.anilist_id}`, film?.kitsu_id && `kitsu:${film.kitsu_id}`].filter(Boolean) as string[];
  return listed.length ? { ...viewing, ids: [...new Set([...viewing.ids, ...listed])] } : viewing;
}

export function belongsOn(service: string, viewing: Viewing, config: any): boolean {
  const { shouldTrackServiceMediaType } = require('../watchTracking');
  if (!shouldTrackServiceMediaType(config, service, viewing.kind === 'movie' ? 'movie' : 'series')) return false;
  return !ANIME_LISTS.has(service) || viewing.ids.some((id) => /^(kitsu|mal|anilist):/.test(id));
}

export async function driftFor(userUUID: string, source: DriftSource): Promise<Drift> {
  const { indexedSnapshot, watchedAmong, seriesCountsAmong } = require('./watched');
  const { pendingWatches } = require('../trackerOutbox');
  const { sourceKeyFor } = require('./trackerMirror');
  const sourceKey = sourceKeyFor(source.service, source.credential);
  const since = Date.now() - driftWindowDays() * DAY_MS;
  const state = await database.getTrackerSync(sourceKey).catch(() => null);
  const readAt = Number(state?.synced_at) || null;
  const empty: Drift = { behind: [], ahead: [], rewatched: [], unread: 0, since, readAt };
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
    if (row.op === 'catchUps') {
      try {
        listed = JSON.parse(row.detail ?? '{}').videos ?? [];
      } catch {}
    }
    for (const video of [String(row.video), ...listed]) {
      const parsed = parseStremioId(video);
      const reach = ANIME_LISTS.has(source.service) && parsed?.episode != null ? parsed.episode : Infinity;
      const key = ANIME_LISTS.has(source.service) && parsed?.episode != null ? parsed.base : video;
      sent.set(key, Math.max(sent.get(key) ?? 0, reach));
    }
  }
  if (ANIME_LISTS.has(source.service)) {
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
  const judged = mine.filter((v) => v.at <= settled && !v.ids.some(wasSent));
  const ours = [...new Set(judged.flatMap((v) => v.ids))];
  const { theirSpellings } = require('./trackerMatch');
  const matched: Map<string, string[]> = await theirSpellings(userUUID, source.service, ours).catch(() => new Map());
  const held = await watchedAmong(snapshot, [...ours, ...[...matched.values()].flat()]);
  let behind = judged.filter((v) => !v.ids.some((id) => held.has(id) || waiting.has(id) || (matched.get(id) ?? []).some((theirs) => held.has(theirs))));
  const spelled = new Map<string, string[]>();
  for (const id of new Set(behind.flatMap((v) => v.ids))) spelled.set(id, await videoIdAliases(id).catch(() => [] as string[]));
  const heldElsewhere = await watchedAmong(snapshot, [...new Set([...spelled.values()].flat())]);
  behind = behind.filter((v) => !v.ids.some((id) => (spelled.get(id) ?? []).some((alias) => heldElsewhere.has(alias) || waiting.has(alias))));
  let rewatched: Viewing[] = [];
  if (REWATCHABLE.has(source.service)) {
    const gap = envInt('JELLYFIN_TRACKER_REWATCH_GAP_HOURS', 48, 48) * 60 * 60 * 1000;
    const everSent = new Set<string>();
    for (const row of (await database.listTrackerActivity([sourceKey], since, 2000).catch(() => [])) as any[]) {
      if (row.kind !== 'sent' || !row.video || !WATCH_OPS.has(String(row.op))) continue;
      everSent.add(String(row.video));
      if (row.op !== 'catchUps') continue;
      try {
        for (const video of JSON.parse(row.detail ?? '{}').videos ?? []) everSent.add(String(video));
      } catch {}
    }
    const missing = new Set(behind);
    const heldAt = (v: Viewing) => Math.max(0, ...v.ids.flatMap((id) => [
      held.get(id) ?? 0,
      ...(matched.get(id) ?? []).map((theirs) => held.get(theirs) ?? 0),
      ...(spelled.get(id) ?? []).map((alias) => heldElsewhere.get(alias) ?? 0),
    ]));
    rewatched = judged.filter((v) => {
      if (missing.has(v) || v.ids.some((id) => waiting.has(id) || everSent.has(id))) return false;
      const at = heldAt(v);
      return at > 0 && v.at - at > gap;
    });
    const again = await statesFor(userUUID, rewatched);
    rewatched = rewatched.filter((v) => v.ids.some((id) => Number(again.get(`${v.profile}|${id}`)?.played) === 1));
  }
  if (ANIME_LISTS.has(source.service)) {
    const counts = await seriesCountsAmong(snapshot, [...new Set(behind.flatMap((v) => v.ids.map((id) => parseStremioId(id)?.base ?? id)))]);
    behind = behind.filter((v) => !v.ids.some((id) => (counts.get(parseStremioId(id)?.base ?? id)?.at ?? 0) > v.at));
  }
  const states = await statesFor(userUUID, behind);
  behind = behind.filter((v) => v.ids.some((id) => Number(states.get(`${v.profile}|${id}`)?.played) === 1));

  const ahead = ANIME_LISTS.has(source.service) ? [] : await aheadOf(userUUID, source, sourceKey, since, unmarking);
  return { behind, ahead, rewatched, unread: mine.filter((v) => v.at > settled).length, since, readAt };
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

export async function pushDrift(userUUID: string, config: any, source: DriftSource, viewings: Viewing[], again: Viewing[] = []): Promise<number> {
  const { enqueueTrackerWrites } = require('../trackerOutbox');
  const byProfile = new Map<string, Viewing[]>();
  if (ANIME_LISTS.has(source.service)) {
    const furthest = new Map<string, Viewing>();
    for (const v of viewings) {
      const key = `${v.profile}|${v.metaId}`;
      const held = furthest.get(key);
      if (!held || (v.episode ?? 0) > (held.episode ?? 0)) furthest.set(key, v);
    }
    viewings = [...furthest.values()];
  }
  for (const v of viewings) byProfile.set(v.profile, [...(byProfile.get(v.profile) ?? []), v]);
  const rewatches = new Map<string, Viewing[]>();
  if (BATCHED.has(source.service)) {
    for (const v of again) {
      byProfile.set(v.profile, byProfile.get(v.profile) ?? []);
      rewatches.set(v.profile, [...(rewatches.get(v.profile) ?? []), v]);
    }
  }
  let queued = 0;
  for (const [profile, list] of byProfile) {
    const scoped = scopeConfigToProfile(config, userUUID, profile || null);
    if (!credentialFor(scoped, source.service)) continue;
    if (BATCHED.has(source.service)) {
      const size = envInt('JELLYFIN_COPY_BATCH_SIZE', 100, 1);
      const sets: Array<{ list: Viewing[]; rewatch: boolean }> = [];
      const repeat = rewatches.get(profile) ?? [];
      if (source.service === 'simkl') {
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
    const scoped = scopeConfigToProfile(config, userUUID, profile || null);
    const credential = credentialFor(scoped, service);
    const { sourceKeyFor } = require('./trackerMirror');
    if (!credential || sourceKeyFor(service, credential) !== sourceKey) continue;
    const source: DriftSource = { service, credential, keys: new Set([profile]), scoped };
    const drift = await driftFor(userUUID, source);
    const videos = rows.map((row) => String(row.video));
    const reaches = (v: Viewing) => v.ids.some((id) => videos.some((video) => {
      if (video === id) return true;
      const a = parseStremioId(video);
      const b = parseStremioId(id);
      return ANIME_LISTS.has(service) && a?.episode != null && b?.episode != null && a.base === b.base && b.episode <= a.episode;
    }));
    queued += await pushDrift(userUUID, config, source, drift.behind.filter(reaches));
    for (const row of rows) await writeGlobalCache(`tracker_recovered:${row.id}`, { at: now }, driftWindowDays() * 24 * 60 * 60);
  }
  return queued;
}
