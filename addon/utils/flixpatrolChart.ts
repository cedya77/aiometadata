// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
export interface ChartVariant {
  id: string;
  label: string;
}

export interface CrawlerEntry {
  rank: number;
  title: string;
  tmdb: {
    id: number;
    media_type: 'movie' | 'tv';
    release_date: string;
  } | null;
}

export interface CrawlerChart {
  catalog_id: string;
  heading: string;
  category: string;
  platform: string;
  date: string;
  title_count: number;
  entries: CrawlerEntry[];
  variant?: ChartVariant;
}

export interface CrawlerData {
  source: string;
  region: string;
  date: string;
  scraped_at_utc: string;
  charts: CrawlerChart[];
}

export function categoryFor(mediaType: string): string {
  return mediaType === 'series' ? 'series' : mediaType === 'all' ? 'overall' : 'movies';
}

export function findChart(
  data: CrawlerData,
  service: string,
  mediaType: string,
  variantId?: string
): CrawlerChart | null {
  const category = categoryFor(mediaType);

  if (variantId) {
    return data.charts.find(c => c.catalog_id === `${service}.${category}-${variantId}`) || null;
  }

  let chart = data.charts.find(c => c.catalog_id === `${service}.${category}`) || null;

  if (!chart && mediaType !== 'all') {
    chart = data.charts.find(c => c.catalog_id === `${service}.overall`) || null;
  }

  return chart;
}

export function collectVariants(data: CrawlerData, service: string, category: string): ChartVariant[] {
  const prefix = `${service}.${category}-`;
  const seen = new Set<string>();
  const variants: ChartVariant[] = [];
  for (const c of data.charts) {
    if (!c.catalog_id.startsWith(prefix) || c.entries.length === 0) continue;
    const id = c.variant?.id || c.catalog_id.slice(prefix.length);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    variants.push({ id, label: c.variant?.label || id });
  }
  return variants;
}
