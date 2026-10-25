import { useMemo, useCallback } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { MAX_TAG_NAME_LENGTH, type CatalogConfig, type TagDef, type TagColorKey } from '@/contexts/config';
import { nextTagColor } from '@/lib/tagColors';

const catalogKey = (c: CatalogConfig) => `${c.id}-${c.type}`;

const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const mapSearchTags = (
  bySearch: Record<string, string[]> | undefined,
  fn: (list: string[]) => string[]
): Record<string, string[]> | undefined => {
  if (!bySearch) return undefined;
  const out: Record<string, string[]> = {};
  for (const [id, list] of Object.entries(bySearch)) {
    const next = fn(list);
    if (next.length) out[id] = next;
  }
  return Object.keys(out).length ? out : undefined;
};

type TagFilters = Partial<Pick<TagDef, 'ageRating' | 'allowUnratedContent'>>;

/** Drops 'None' and the undefined half so a tag without a limit stores no filter keys. */
const cleanFilters = (filters?: TagFilters): TagFilters => {
  if (!filters?.ageRating || filters.ageRating === 'None') return {};
  return filters.allowUnratedContent === false
    ? { ageRating: filters.ageRating, allowUnratedContent: false }
    : { ageRating: filters.ageRating };
};

export function useCatalogTags() {
  const { config, setConfig } = useConfig();

  const tags = useMemo<TagDef[]>(() => config.tags ?? [], [config.tags]);

  const tagCounts = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const c of config.catalogs) {
      for (const t of c.tags ?? []) counts[t] = (counts[t] || 0) + 1;
    }
    return counts;
  }, [config.catalogs]);

  const createTag = useCallback((name: string, color?: TagColorKey, filters?: TagFilters) => {
    const clean = name.trim();
    if (!clean || clean.length > MAX_TAG_NAME_LENGTH) return;
    setConfig(prev => {
      const registry = prev.tags ?? [];
      if (registry.some(t => t.name.toLowerCase() === clean.toLowerCase())) return prev;
      const chosen = color ?? nextTagColor(registry.map(t => t.color));
      return { ...prev, tags: [...registry, { name: clean, color: chosen, ...cleanFilters(filters) }] };
    });
  }, [setConfig]);

  const renameTag = useCallback((oldName: string, nextName: string) => {
    const clean = nextName.trim();
    if (!clean || clean.length > MAX_TAG_NAME_LENGTH || clean === oldName) return;
    setConfig(prev => {
      const registry = prev.tags ?? [];
      if (registry.some(t => !sameTag(t.name, oldName) && sameTag(t.name, clean))) return prev;
      return {
        ...prev,
        tags: registry.map(t => (sameTag(t.name, oldName) ? { ...t, name: clean } : t)),
        catalogs: prev.catalogs.map(c =>
          c.tags?.some(t => sameTag(t, oldName))
            ? { ...c, tags: c.tags.map(t => (sameTag(t, oldName) ? clean : t)) }
            : c
        ),
        search: { ...prev.search, tags: mapSearchTags(prev.search?.tags, list => list.map(t => (sameTag(t, oldName) ? clean : t))) },
      };
    });
  }, [setConfig]);

  const recolorTag = useCallback((name: string, color: TagColorKey) => {
    setConfig(prev => ({
      ...prev,
      tags: (prev.tags ?? []).map(t => (sameTag(t.name, name) ? { ...t, color } : t)),
    }));
  }, [setConfig]);

  const setTagFilters = useCallback((name: string, patch: TagFilters) => {
    setConfig(prev => ({
      ...prev,
      tags: (prev.tags ?? []).map(t => (sameTag(t.name, name) ? { ...t, ...patch } : t)),
    }));
  }, [setConfig]);

  const setTagRules = useCallback((name: string, patch: Partial<Pick<TagDef, 'viewingHours' | 'allowDownloads' | 'hideKeywords' | 'hideWords' | 'hideGenres'>>) => {
    setConfig(prev => ({
      ...prev,
      tags: (prev.tags ?? []).map(t => (sameTag(t.name, name) ? { ...t, ...patch } : t)),
    }));
  }, [setConfig]);

  const deleteTag = useCallback((name: string) => {
    setConfig(prev => ({
      ...prev,
      tags: (prev.tags ?? []).filter(t => !sameTag(t.name, name)),
      catalogs: prev.catalogs.map(c =>
        c.tags?.some(t => sameTag(t, name)) ? { ...c, tags: c.tags.filter(t => !sameTag(t, name)) } : c
      ),
      search: { ...prev.search, tags: mapSearchTags(prev.search?.tags, list => list.filter(t => !sameTag(t, name))) },
    }));
  }, [setConfig]);

  const addTagToCatalogs = useCallback((keys: Set<string>, name: string, color?: TagColorKey, filters?: TagFilters) => {
    const clean = name.trim();
    if (!clean || clean.length > MAX_TAG_NAME_LENGTH) return;
    setConfig(prev => {
      const registry = prev.tags ?? [];
      const existing = registry.find(t => t.name.toLowerCase() === clean.toLowerCase());
      const canonical = existing ? existing.name : clean;
      const tagsUpdate = existing
        ? registry
        : [...registry, { name: clean, color: color ?? nextTagColor(registry.map(t => t.color)), ...cleanFilters(filters) }];
      return {
        ...prev,
        tags: tagsUpdate,
        catalogs: prev.catalogs.map(c => {
          if (!keys.has(catalogKey(c))) return c;
          const current = c.tags ?? [];
          return current.some(t => sameTag(t, canonical)) ? c : { ...c, tags: [...current, canonical] };
        }),
      };
    });
  }, [setConfig]);

  const removeTagFromCatalogs = useCallback((keys: Set<string>, name: string) => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(c => {
        if (!keys.has(catalogKey(c)) || !c.tags?.some(t => sameTag(t, name))) return c;
        return { ...c, tags: c.tags.filter(t => !sameTag(t, name)) };
      }),
    }));
  }, [setConfig]);

  const setSearchTag = useCallback((searchId: string, name: string, applied: boolean) => {
    setConfig(prev => {
      const registry = prev.tags ?? [];
      const canonical = registry.find(t => sameTag(t.name, name))?.name;
      if (!canonical) return prev;
      const current = prev.search?.tags?.[searchId] ?? [];
      const next = applied
        ? current.some(t => sameTag(t, canonical)) ? current : [...current, canonical]
        : current.filter(t => !sameTag(t, canonical));
      const tagsBySearch = { ...(prev.search?.tags ?? {}) };
      if (next.length) tagsBySearch[searchId] = next;
      else delete tagsBySearch[searchId];
      return { ...prev, search: { ...prev.search, tags: Object.keys(tagsBySearch).length ? tagsBySearch : undefined } };
    });
  }, [setConfig]);

  return {
    tags,
    tagCounts,
    setSearchTag,
    createTag,
    renameTag,
    recolorTag,
    setTagFilters,
    setTagRules,
    deleteTag,
    addTagToCatalogs,
    removeTagFromCatalogs,
  };
}
