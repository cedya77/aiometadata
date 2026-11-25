// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE

const MAX_PICKED = 1000;

export interface LiveTvPick {
  /** The playback addon the groups were picked from. */
  addon: string;
  groups: string[];
  /** Whether nothing else can be reached, and whether the user had a rating when that was chosen. */
  only?: { on: boolean; rated: boolean };
}

export function liveTvPickOf(value: any): LiveTvPick | undefined {
  if (typeof value?.addon !== 'string' || !value.addon.trim() || !Array.isArray(value.groups)) return undefined;
  const groups = [...new Set<string>(value.groups.filter((g: unknown) => typeof g === 'string' && g.length > 0))].slice(0, MAX_PICKED);
  if (!groups.length) return undefined;
  const { on, rated } = value.only ?? {};
  return { addon: value.addon.trim(), groups, ...(typeof on === 'boolean' && typeof rated === 'boolean' ? { only: { on, rated } } : {}) };
}
