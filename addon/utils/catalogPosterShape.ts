// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
export function isLandscapeCatalogConfig(config: any, catalog: any): boolean {
  const shape = catalog?.metadata?.posterShape;
  if (shape) return shape === 'landscape';
  const sources: any[] = catalog?.metadata?.mergedSources || [];
  if (sources.length === 0) return false;
  const catalogs: any[] = Array.isArray(config?.catalogs) ? config.catalogs : [];
  const entries = sources
    .map((s) => catalogs.find((c) => c.id === s.catalogId && c.type === s.catalogType))
    .filter(Boolean);
  return entries.length > 0 && entries.every((c) => c.metadata?.posterShape === 'landscape');
}
