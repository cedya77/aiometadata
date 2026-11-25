// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { timeOf } from './query';

export interface Programme {
  id: string;
  title: string;
  start: number;
  end: number;
  overview?: string;
  image?: string;
  background?: string;
  genres?: string[];
  cast?: string[];
  directors?: string[];
  season?: number;
  episode?: number;
  imdbId?: string;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];

function wholeNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export function programmesOf(entry: any): Programme[] {
  const parsed: Programme[] = [];
  for (const video of Array.isArray(entry?.videos) ? entry.videos : []) {
    const id = text(video?.id);
    const start = timeOf(video?.startTime);
    const end = timeOf(video?.endTime);
    if (!id || start === null || end === null || end <= start) continue;
    const programme: Programme = { id, title: text(video.title) ?? text(video.name) ?? '', start, end };
    const overview = text(video.description) ?? text(video.overview);
    if (overview) programme.overview = overview;
    const image = text(video.thumbnail);
    const background = text(video.background);
    if (image) programme.image = image;
    if (background) programme.background = background;
    for (const key of ['genres', 'cast', 'directors'] as const) {
      const list = strings(video[key]);
      if (list.length) programme[key] = list;
    }
    const season = wholeNumber(video.season);
    const episode = wholeNumber(video.episode);
    if (season !== undefined) programme.season = season;
    if (episode !== undefined) programme.episode = episode;
    const imdbId = text(video.imdbId);
    if (imdbId) programme.imdbId = imdbId;
    parsed.push(programme);
  }
  parsed.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Programme[] = [];
  for (const programme of parsed) {
    const last = kept[kept.length - 1];
    if (last && last.start === programme.start) continue;
    if (last && last.end > programme.start) last.end = programme.start;
    kept.push(programme);
  }
  return kept;
}

export function airingAt(programmes: Programme[] | undefined, atMs: number): Programme | undefined {
  return programmes?.find((p) => p.start <= atMs && atMs < p.end);
}

export function pageSize(programmes: Map<string, Programme[]>): number {
  let size = 1;
  for (const list of programmes.values()) {
    for (const programme of list) {
      size += 200;
      for (const value of Object.values(programme)) {
        if (typeof value === 'string') size += value.length;
        else if (Array.isArray(value)) for (const part of value) size += part.length + 16;
      }
    }
  }
  return size;
}
