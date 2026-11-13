// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { envInt } from '../../utils/envNumber';
import type { FinishedAnime, NextUpRow, UpcomingRow, WatchedSnapshot } from './watched';

const idMapper: any = require('../id-mapper');

const DAY_MS = 24 * 60 * 60 * 1000;
const SERIES_TYPES = new Set(['TV', 'ONA', 'OVA']);

export interface Sequels {
  nextUp: NextUpRow[];
  upcoming: UpcomingRow[];
}

const NONE: Sequels = { nextUp: [], upcoming: [] };

function mappingOf(ids: FinishedAnime['ids']): any {
  return (ids.mal && idMapper.getMappingByMalId(ids.mal))
    || (ids.simkl && idMapper.getMappingBySimklId(ids.simkl))
    || (ids.anilist && idMapper.getMappingByAnilistId(ids.anilist))
    || (ids.kitsu && idMapper.getMappingByKitsuId(ids.kitsu))
    || (ids.anidb && idMapper.getMappingByAnidbId(ids.anidb))
    || null;
}

const tvdbSeason = (mapping: any): number => Number(mapping?.season?.tvdb);

/** The entry after this one in its show: the next part of its TVDB season, or the next season. */
export function successorOf(mapping: any): any | null {
  const season = tvdbSeason(mapping);
  if (!mapping?.tvdb_id || !Number.isInteger(season) || season < 1) return null;
  // Parts of one season are ordered by MAL id.
  const parts = (idMapper.getSiblingsByTvdbId(mapping.tvdb_id) as any[])
    .filter((m) => SERIES_TYPES.has(String(m?.type).toUpperCase()) && Number.isInteger(tvdbSeason(m)) && tvdbSeason(m) >= 1 && (m.kitsu_id || m.mal_id))
    .sort((a, b) => tvdbSeason(a) - tvdbSeason(b) || (Number(a.mal_id) || Infinity) - (Number(b.mal_id) || Infinity));
  const at = parts.findIndex((m) => m === mapping || (mapping.mal_id && m.mal_id === mapping.mal_id));
  return at >= 0 ? parts[at + 1] ?? null : null;
}

/** When each anime entry's first episode airs, from Simkl's calendar for the months between `from` and `to`. */
async function firstEpisodes(from: number, to: number): Promise<Map<string, number>> {
  const { fetchSimklCalendarMonth } = require('../../utils/simklUtils');
  const months: Array<[number, number]> = [];
  const cursor = new Date(from);
  cursor.setUTCDate(1);
  while (cursor.getTime() <= to) {
    months.push([cursor.getUTCFullYear(), cursor.getUTCMonth() + 1]);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const firsts = new Map<string, number>();
  for (const entries of await Promise.all(months.map(([year, month]) => fetchSimklCalendarMonth('anime', year, month)))) {
    for (const entry of entries) {
      if (Number(entry?.episode?.episode) !== 1) continue;
      const at = Date.parse(entry?.date ?? '');
      if (!Number.isFinite(at)) continue;
      for (const key of [entry?.ids?.mal ? `mal:${entry.ids.mal}` : null, entry?.ids?.simkl_id ? `simkl:${entry.ids.simkl_id}` : null]) {
        if (key && !firsts.has(key)) firsts.set(key, at);
      }
    }
  }
  return firsts;
}

/** The next season of each finished anime entry that is on none of the user's lists. */
export async function animeSequels(snapshot: WatchedSnapshot): Promise<Sequels> {
  const finished = snapshot.finishedAnime ?? [];
  if (!finished.length) return NONE;
  const listed = snapshot.listedAnime ?? new Set<string>();
  const now = Date.now();
  const recent = now - envInt('JELLYFIN_NEXTUP_SEQUEL_DAYS', 120, 0) * DAY_MS;
  const horizon = now + envInt('JELLYFIN_UPCOMING_DAYS', 90, 1) * DAY_MS;

  const next = new Map<string, { mapping: any; after: number }>();
  for (const entry of finished) {
    const mapping = successorOf(mappingOf(entry.ids));
    if (!mapping) continue;
    if ((mapping.mal_id && listed.has(`mal:${mapping.mal_id}`)) || (mapping.simkl_id && listed.has(`simkl:${mapping.simkl_id}`))) continue;
    const metaId = mapping.kitsu_id ? `kitsu:${mapping.kitsu_id}` : `mal:${mapping.mal_id}`;
    if (snapshot.dropped.has(metaId)) continue;
    const held = next.get(metaId);
    if (!held || entry.at > held.after) next.set(metaId, { mapping, after: entry.at });
  }
  if (!next.size) return NONE;

  const firsts = await firstEpisodes(recent, horizon).catch(() => new Map<string, number>());
  const sequels: Sequels = { nextUp: [], upcoming: [] };
  for (const [metaId, { mapping, after }] of next) {
    const premiere = firsts.get(`mal:${mapping.mal_id}`) ?? firsts.get(`simkl:${mapping.simkl_id}`) ?? null;
    const row = { metaId, mediaType: 'anime' as const, videoId: metaId.startsWith('kitsu:') ? `${metaId}:1` : null, season: null, episode: 1 };
    if (premiere !== null && premiere > now) {
      if (premiere <= horizon) sequels.upcoming.push({ ...row, airsAt: premiere });
      continue;
    }
    if (after >= recent || (premiere !== null && premiere >= recent)) {
      sequels.nextUp.push({ ...row, lastWatchedAt: Math.max(after, premiere ?? 0), ...(premiere !== null ? { airsAt: premiere } : {}) });
    }
  }
  return sequels;
}
