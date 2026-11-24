// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { AddonDeps, Manifest } from '../addonReader';
import { liveCatalogs, pickedCatalogs, type LiveCatalog } from './catalogs';

export interface GateDeps {
  enabled(): boolean;
  capped(config: any): boolean;
  baseFor(config: any): string | null;
  addon: AddonDeps;
}

export interface LiveTv {
  base: string;
  /** What lists show. */
  catalogs: LiveCatalog[];
  /** What can be searched, opened and played. */
  reach: LiveCatalog[];
  manifest: Manifest;
}

export function liveTvEnabled(): boolean {
  const value = require('../../settingsService').getSetting('JELLYFIN_LIVETV_ENABLED');
  return String(value).trim().toLowerCase() === 'true';
}

interface Access {
  base: string;
  rated: boolean;
  picked?: { groups: Set<string>; only: boolean };
}

function accessOf(deps: Omit<GateDeps, 'addon'>, config: any): Access | null {
  if (!config || !deps.enabled()) return null;
  const base = deps.baseFor(config);
  if (!base) return null;
  const rated = deps.capped(config);
  const pick = config.jellyfinLiveTv;
  const counts = Array.isArray(pick?.groups) && pick.groups.length > 0 && deps.baseFor({ jellyfinStreamUrl: pick.addon }) === base;
  if (!counts) return rated ? null : { base, rated };
  // A choice made with or without a rating counts only while that still holds.
  const only = pick.only?.rated === rated ? pick.only.on === true : rated;
  return { base, rated, picked: { groups: new Set<string>(pick.groups), only } };
}

function withCatalogs({ base, rated, picked }: Access, manifest: Manifest | null | undefined): LiveTv | null {
  if (!manifest) return null;
  const all = liveCatalogs(manifest);
  if (!all.length) return null;
  if (!picked) return { base, catalogs: all, reach: all, manifest };
  const catalogs = pickedCatalogs(all, picked.groups);
  if (!catalogs.length) return rated || picked.only ? null : { base, catalogs: all, reach: all, manifest };
  return { base, catalogs, reach: picked.only ? catalogs : all, manifest };
}

export async function liveTvRecall(deps: GateDeps, config: any): Promise<void> {
  const access = accessOf(deps, config);
  if (access) await deps.addon.recall(access.base);
}

export function liveTvFor(deps: GateDeps, config: any): LiveTv | null {
  const access = accessOf(deps, config);
  return access ? withCatalogs(access, deps.addon.peek(access.base)) : null;
}

export async function liveTvReady(deps: GateDeps, config: any): Promise<LiveTv | null> {
  const access = accessOf(deps, config);
  return access ? withCatalogs(access, await deps.addon.manifest(access.base)) : null;
}
