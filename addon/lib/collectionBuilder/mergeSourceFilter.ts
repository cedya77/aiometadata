// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE

/**
 * A merge can offer its sources in its one filter, in place of genres: picking a
 * source serves that source alone, and None serves the whole merge. Shared by the
 * manifest, the catalog handler and the configure page, so all three name the
 * sources the same way.
 */

export interface MergeSourceRef {
  catalogId: string;
  catalogType: string;
  /** Shown in place of the source catalog's own name. */
  label?: string;
}

export interface SourceFilterOption {
  label: string;
  catalogId: string;
  catalogType: string;
}

interface NamedCatalog {
  id: string;
  type: string;
  name?: string;
  displayType?: string;
}

const MAX_LABEL_LENGTH = 80;
const TYPE_NAMES: Record<string, string> = { movie: 'Movies', series: 'Series', anime: 'Anime', tv: 'TV', channel: 'Channels', all: 'All' };

function typeName(type: string): string {
  const trimmed = type.trim();
  return TYPE_NAMES[trimmed.toLowerCase()] ?? (trimmed.charAt(0).toUpperCase() + trimmed.slice(1));
}

/**
 * Each source by its label or its catalog's name. Names that read alike are told
 * apart by type when their types differ, and by number when they do not; None
 * stays the whole merge.
 */
export function sourceFilterOptions(sources: MergeSourceRef[] | undefined, catalogs: NamedCatalog[] | undefined): SourceFilterOption[] {
  const named: Array<{ source: MergeSourceRef; base: string; type: string }> = [];
  for (const source of sources ?? []) {
    if (!source?.catalogId || source.catalogId.startsWith('merged.')) continue;
    const catalog = (catalogs ?? []).find((c) => c.id === source.catalogId && c.type === source.catalogType);
    if (!catalog) continue;
    const base = (source.label?.trim() || catalog.name?.trim() || source.catalogId).slice(0, MAX_LABEL_LENGTH);
    named.push({ source, base, type: catalog.displayType?.trim() || source.catalogType });
  }

  const typesByName = new Map<string, Set<string>>();
  for (const { base, type } of named) {
    const key = base.toLowerCase();
    typesByName.set(key, (typesByName.get(key) ?? new Set()).add(type.toLowerCase()));
  }

  const used = new Set<string>(['none']);
  return named.map(({ source, base, type }) => {
    const key = base.toLowerCase();
    // A source called None would read as the whole merge, so it is always named with its type.
    const byType = key === 'none' || (typesByName.get(key)?.size ?? 0) > 1;
    const preferred = byType ? `${base} (${typeName(type)})` : base;
    let label = preferred;
    for (let n = 2; used.has(label.toLowerCase()); n++) label = `${preferred} (${n})`;
    used.add(label.toLowerCase());
    return { label, catalogId: source.catalogId, catalogType: source.catalogType };
  });
}

/** The source a filter value names, or null for None, nothing, or a value that names no source. */
export function sourceForFilter(options: SourceFilterOption[], value: string | null | undefined): SourceFilterOption | null {
  const wanted = String(value ?? '').trim().toLowerCase();
  if (!wanted || wanted === 'none') return null;
  return options.find((option) => option.label.toLowerCase() === wanted) ?? null;
}
