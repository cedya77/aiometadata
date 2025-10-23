import React, { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react';
import { CatalogConfig } from './config';

interface SelectionState {
  selectedIds: Set<string>;
  lastSelectedId: string | null;
}

interface SelectionContextType {
  selectedIds: Set<string>;
  toggleSelection: (id: string) => void;
  selectAll: () => void;
  deselectAll: () => void;
  selectBySource: (source: string) => void;
  deselectBySource: (source: string) => void;
  invertSelection: () => void;
  isSelected: (id: string) => boolean;
  selectionCount: number;
}

const SelectionContext = createContext<SelectionContextType | undefined>(undefined);

interface SelectionProviderProps {
  children: React.ReactNode;
  catalogs: CatalogConfig[];
}

export function SelectionProvider({ children, catalogs }: SelectionProviderProps) {
  const [state, setState] = useState<SelectionState>({
    selectedIds: new Set(),
    lastSelectedId: null,
  });

  // Clear selection when component unmounts
  useEffect(() => {
    return () => {
      setState({
        selectedIds: new Set(),
        lastSelectedId: null,
      });
    };
  }, []);

  // Helper to create unique catalog ID
  const getCatalogKey = useCallback((catalog: CatalogConfig) => {
    return `${catalog.id}-${catalog.type}`;
  }, []);

  // Toggle selection for a single catalog
  const toggleSelection = useCallback((id: string) => {
    setState(prev => {
      const newSelectedIds = new Set(prev.selectedIds);
      if (newSelectedIds.has(id)) {
        newSelectedIds.delete(id);
      } else {
        newSelectedIds.add(id);
      }
      return {
        selectedIds: newSelectedIds,
        lastSelectedId: id,
      };
    });
  }, []);

  // Select all visible catalogs (maintains existing selection for hidden items)
  const selectAll = useCallback(() => {
    setState(prev => {
      const newSelectedIds = new Set(prev.selectedIds);
      const allIds = catalogs.map(getCatalogKey);
      allIds.forEach(id => newSelectedIds.add(id));
      return {
        selectedIds: newSelectedIds,
        lastSelectedId: allIds[allIds.length - 1] || prev.lastSelectedId,
      };
    });
  }, [catalogs, getCatalogKey]);

  // Deselect all catalogs
  const deselectAll = useCallback(() => {
    setState({
      selectedIds: new Set(),
      lastSelectedId: null,
    });
  }, []);

  // Select all catalogs from a specific source (only visible catalogs, maintains existing selection)
  const selectBySource = useCallback((source: string) => {
    setState(prev => {
      const newSelectedIds = new Set(prev.selectedIds);
      catalogs
        .filter(catalog => catalog.source === source)
        .forEach(catalog => {
          newSelectedIds.add(getCatalogKey(catalog));
        });
      return {
        selectedIds: newSelectedIds,
        lastSelectedId: prev.lastSelectedId,
      };
    });
  }, [catalogs, getCatalogKey]);

  // Deselect all catalogs from a specific source (only visible catalogs, maintains selection for hidden items)
  const deselectBySource = useCallback((source: string) => {
    setState(prev => {
      const newSelectedIds = new Set(prev.selectedIds);
      catalogs
        .filter(catalog => catalog.source === source)
        .forEach(catalog => {
          newSelectedIds.delete(getCatalogKey(catalog));
        });
      return {
        selectedIds: newSelectedIds,
        lastSelectedId: prev.lastSelectedId,
      };
    });
  }, [catalogs, getCatalogKey]);

  // Invert selection (select unselected visible, deselect selected visible, maintain hidden)
  const invertSelection = useCallback(() => {
    setState(prev => {
      const newSelectedIds = new Set(prev.selectedIds);
      const visibleCatalogKeys = new Set(catalogs.map(getCatalogKey));
      
      // For visible catalogs, invert their selection
      catalogs.forEach(catalog => {
        const key = getCatalogKey(catalog);
        if (prev.selectedIds.has(key)) {
          newSelectedIds.delete(key);
        } else {
          newSelectedIds.add(key);
        }
      });
      
      // Maintain selection for hidden items (those in prev.selectedIds but not in visibleCatalogKeys)
      prev.selectedIds.forEach(id => {
        if (!visibleCatalogKeys.has(id)) {
          newSelectedIds.add(id);
        }
      });
      
      return {
        selectedIds: newSelectedIds,
        lastSelectedId: prev.lastSelectedId,
      };
    });
  }, [catalogs, getCatalogKey]);

  // Check if a catalog is selected
  const isSelected = useCallback((id: string) => {
    return state.selectedIds.has(id);
  }, [state.selectedIds]);

  // Get selection count
  const selectionCount = useMemo(() => {
    return state.selectedIds.size;
  }, [state.selectedIds]);

  const value = useMemo(() => ({
    selectedIds: state.selectedIds,
    toggleSelection,
    selectAll,
    deselectAll,
    selectBySource,
    deselectBySource,
    invertSelection,
    isSelected,
    selectionCount,
  }), [
    state.selectedIds,
    toggleSelection,
    selectAll,
    deselectAll,
    selectBySource,
    deselectBySource,
    invertSelection,
    isSelected,
    selectionCount,
  ]);

  return (
    <SelectionContext.Provider value={value}>
      {children}
    </SelectionContext.Provider>
  );
}

export function useSelection() {
  const context = useContext(SelectionContext);
  if (context === undefined) {
    throw new Error('useSelection must be used within a SelectionProvider');
  }
  return context;
}
