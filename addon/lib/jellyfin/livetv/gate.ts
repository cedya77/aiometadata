// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { AddonDeps, Manifest } from '../addonReader';
import { liveCatalogs, type LiveCatalog } from './catalogs';

export interface GateDeps {
  enabled(): boolean;
  capped(config: any): boolean;
  baseFor(config: any): string | null;
  addon: AddonDeps;
}

export interface LiveTv {
  base: string;
  catalogs: LiveCatalog[];
  manifest: Manifest;
}

export function liveTvEnabled(): boolean {
  const value = require('../../settingsService').getSetting('JELLYFIN_LIVETV_ENABLED');
  return String(value).trim().toLowerCase() === 'true';
}

function baseOf(deps: Omit<GateDeps, 'addon'>, config: any): string | null {
  if (!config || !deps.enabled() || deps.capped(config)) return null;
  return deps.baseFor(config) || null;
}

function withCatalogs(base: string, manifest: Manifest | null | undefined): LiveTv | null {
  if (!manifest) return null;
  const catalogs = liveCatalogs(manifest);
  return catalogs.length ? { base, catalogs, manifest } : null;
}

export async function liveTvRecall(deps: GateDeps, config: any): Promise<void> {
  const base = baseOf(deps, config);
  if (base) await deps.addon.recall(base);
}

export function liveTvFor(deps: GateDeps, config: any): LiveTv | null {
  const base = baseOf(deps, config);
  return base ? withCatalogs(base, deps.addon.peek(base)) : null;
}

export async function liveTvReady(deps: GateDeps, config: any): Promise<LiveTv | null> {
  const base = baseOf(deps, config);
  return base ? withCatalogs(base, await deps.addon.manifest(base)) : null;
}
