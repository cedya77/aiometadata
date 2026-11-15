// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { seasonNumberingFor } from '../utils/episodeOrder';

const SEASON_EPISODE_ID = /^(tt\d+|tvdb:\d+):(\d+):(\d+)$/;

// Builds number year seasons 1, 2, 3… and keep TVDB's year on each renumbered
// video, so one cached episode list serves both numberings.
export function applySeasonNumberingProjection(meta: any, config: any): any {
  const videos = meta?.videos;
  if (!Array.isArray(videos) || !videos.some((video: any) => video?._tvdbSeason != null)) return meta;

  const years = seasonNumberingFor(config, meta._tvdbId) === 'years';
  const renamedIds = new Map<string, string>();
  const yearOf = new Map<number, number>();

  meta.videos = videos.map((video: any) => {
    if (video?._tvdbSeason == null) return video;
    const { _tvdbSeason, ...rest } = video;
    if (!years) return rest;
    yearOf.set(video.season, _tvdbSeason);
    const match = typeof video.id === 'string' ? video.id.match(SEASON_EPISODE_ID) : null;
    if (match && Number(match[2]) === video.season && Number(match[3]) === video.episode) {
      const id = `${match[1]}:${_tvdbSeason}:${video.episode}`;
      renamedIds.set(video.id, id);
      return { ...rest, season: _tvdbSeason, id };
    }
    return { ...rest, season: _tvdbSeason };
  });

  const defaultVideoId = meta.behaviorHints?.defaultVideoId;
  if (renamedIds.has(defaultVideoId)) {
    meta.behaviorHints = { ...meta.behaviorHints, defaultVideoId: renamedIds.get(defaultVideoId) };
  }

  const posters = meta.app_extras?.seasonPosters;
  if (yearOf.size > 0 && posters && typeof posters === 'object' && !Array.isArray(posters)) {
    const rekeyed: Record<string, any> = {};
    for (const [key, value] of Object.entries(posters)) {
      const year = yearOf.get(Number(key));
      rekeyed[year != null ? String(year) : key] = value;
    }
    meta.app_extras = { ...meta.app_extras, seasonPosters: rekeyed };
  }

  return meta;
}

export function predatesSeasonNumbering(basic: any, videosData: any, config: any): boolean {
  return !!videosData
    && !videosData._seasonNumbering
    && basic?._metaProvider === 'tvdb'
    && seasonNumberingFor(config, basic._tvdbId) === 'years';
}
