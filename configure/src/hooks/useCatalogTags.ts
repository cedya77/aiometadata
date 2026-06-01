import { useMemo, useCallback } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { MAX_TAG_NAME_LENGTH, type CatalogConfig, type TagDef, type TagColorKey } from '@/contexts/config';
import { nextTagColor } from '@/lib/tagColors';

const catalogKey = (c: CatalogConfig) => `${c.id}-${c.type}`;

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

  const createTag = useCallback((name: string, color?: TagColorKey) => {
    const clean = name.trim();
    if (!clean || clean.length > MAX_TAG_NAME_LENGTH) return;
    setConfig(prev => {
      const registry = prev.tags ?? [];
      if (registry.some(t => t.name === clean)) return prev;
      const chosen = color ?? nextTagColor(registry.map(t => t.color));
      return { ...prev, tags: [...registry, { name: clean, color: chosen }] };
    });
  }, [setConfig]);

  const renameTag = useCallback((oldName: string, nextName: string) => {
    const clean = nextName.trim();
    if (!clean || clean.length > MAX_TAG_NAME_LENGTH || clean === oldName) return;
    setConfig(prev => {
      const registry = prev.tags ?? [];
      if (registry.some(t => t.name === clean)) return prev;
      return {
        ...prev,
        tags: registry.map(t => (t.name === oldName ? { ...t, name: clean } : t)),
        catalogs: prev.catalogs.map(c =>
          c.tags?.includes(oldName)
            ? { ...c, tags: c.tags.map(t => (t === oldName ? clean : t)) }
            : c
        ),
      };
    });
  }, [setConfig]);

  const recolorTag = useCallback((name: string, color: TagColorKey) => {
    setConfig(prev => ({
      ...prev,
      tags: (prev.tags ?? []).map(t => (t.name === name ? { ...t, color } : t)),
    }));
  }, [setConfig]);

  const deleteTag = useCallback((name: string) => {
    setConfig(prev => ({
      ...prev,
      tags: (prev.tags ?? []).filter(t => t.name !== name),
      catalogs: prev.catalogs.map(c =>
        c.tags?.includes(name) ? { ...c, tags: c.tags.filter(t => t !== name) } : c
      ),
    }));
  }, [setConfig]);

  const addTagToCatalogs = useCallback((keys: Set<string>, name: string) => {
    const clean = name.trim();
    if (!clean || clean.length > MAX_TAG_NAME_LENGTH) return;
    setConfig(prev => {
      const registry = prev.tags ?? [];
      const tagsUpdate = registry.some(t => t.name === clean)
        ? registry
        : [...registry, { name: clean, color: nextTagColor(registry.map(t => t.color)) }];
      return {
        ...prev,
        tags: tagsUpdate,
        catalogs: prev.catalogs.map(c => {
          if (!keys.has(catalogKey(c))) return c;
          const current = c.tags ?? [];
          return current.includes(clean) ? c : { ...c, tags: [...current, clean] };
        }),
      };
    });
  }, [setConfig]);

  const removeTagFromCatalogs = useCallback((keys: Set<string>, name: string) => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(c => {
        if (!keys.has(catalogKey(c)) || !c.tags?.includes(name)) return c;
        return { ...c, tags: c.tags.filter(t => t !== name) };
      }),
    }));
  }, [setConfig]);

  return {
    tags,
    tagCounts,
    createTag,
    renameTag,
    recolorTag,
    deleteTag,
    addTagToCatalogs,
    removeTagFromCatalogs,
  };
}
