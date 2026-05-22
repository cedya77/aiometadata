import React, { useMemo, useState } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Check, Plus, Minus, ChevronDown } from 'lucide-react';
import { toast } from "sonner";
import { baseCatalogs, animeCatalogs, CatalogDefinition } from '@/data/catalogs';
import { cn } from '@/lib/utils';

interface AIOMetadataIntegrationProps {
  isOpen: boolean;
  onClose: () => void;
}

const SOURCE_GROUPS = [
  {
    source: 'tmdb',
    label: 'TMDB',
    description: 'Popular, trending, top rated, and browsing catalogs',
    icon: '/tmdb_icon.png',
    gradient: 'from-blue-500/10 via-card/80 to-card/80',
    border: 'border-blue-400/20',
    accent: 'bg-blue-500/15 ring-blue-400/20',
    badgeActive: 'bg-blue-500/20 text-blue-300 border-blue-400/30',
  },
  {
    source: 'tvdb',
    label: 'TheTVDB',
    description: 'Trending, genre-based, and collection catalogs',
    icon: '/tmdb_icon.png',
    lucideLabel: 'TV',
    gradient: 'from-green-500/10 via-card/80 to-card/80',
    border: 'border-green-400/20',
    accent: 'bg-green-500/15 ring-green-400/20',
    badgeActive: 'bg-green-500/20 text-green-300 border-green-400/30',
  },
  {
    source: 'mal',
    label: 'MyAnimeList',
    description: 'Airing, seasonal, decade-based, and ranking catalogs',
    icon: '/tmdb_icon.png',
    lucideLabel: 'MAL',
    gradient: 'from-indigo-500/10 via-card/80 to-card/80',
    border: 'border-indigo-400/20',
    accent: 'bg-indigo-500/15 ring-indigo-400/20',
    badgeActive: 'bg-indigo-500/20 text-indigo-300 border-indigo-400/30',
  },
  {
    source: 'tvmaze',
    label: 'TVmaze',
    description: 'Daily airing schedule',
    icon: '/tmdb_icon.png',
    lucideLabel: 'TVM',
    gradient: 'from-orange-500/10 via-card/80 to-card/80',
    border: 'border-orange-400/20',
    accent: 'bg-orange-500/15 ring-orange-400/20',
    badgeActive: 'bg-orange-500/20 text-orange-300 border-orange-400/30',
  },
] as const;

const allBuiltInCatalogs: CatalogDefinition[] = [...baseCatalogs, ...animeCatalogs];

const typeLabel = (type: string) => {
  if (type === 'movie') return 'Movies';
  if (type === 'series') return 'Series';
  if (type === 'anime') return 'Anime';
  return type;
};

export function AIOMetadataIntegration({ isOpen, onClose }: AIOMetadataIntegrationProps) {
  const { config, setConfig } = useConfig();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const addedSet = useMemo(() => {
    const set = new Set<string>();
    for (const c of config.catalogs) {
      set.add(`${c.id}::${c.type}`);
    }
    return set;
  }, [config.catalogs]);

  const groups = useMemo(() => {
    return SOURCE_GROUPS
      .map(sg => ({
        ...sg,
        catalogs: allBuiltInCatalogs.filter(c => c.source === sg.source),
      }))
      .filter(g => g.catalogs.length > 0);
  }, []);

  const isAdded = (catalog: CatalogDefinition) => addedSet.has(`${catalog.id}::${catalog.type}`);

  const toggleCollapse = (source: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  };

  const handleToggle = (catalog: CatalogDefinition) => {
    const added = isAdded(catalog);
    if (added) {
      setConfig(prev => ({
        ...prev,
        catalogs: prev.catalogs.filter(
          c => !(c.id === catalog.id && c.type === catalog.type)
        ),
      }));
      toast.success(`Removed ${catalog.name} (${typeLabel(catalog.type)})`);
    } else {
      setConfig(prev => ({
        ...prev,
        catalogs: [
          ...prev.catalogs,
          {
            id: catalog.id,
            name: catalog.name,
            type: catalog.type,
            source: catalog.source,
            enabled: true,
            showInHome: catalog.showOnHomeByDefault || false,
            enableRatingPosters: true,
            randomizePerPage: false,
          },
        ],
      }));
      toast.success(`Added ${catalog.name} (${typeLabel(catalog.type)})`);
    }
  };

  const handleAddAllInGroup = (catalogs: CatalogDefinition[]) => {
    const toAdd = catalogs.filter(c => !isAdded(c));
    if (toAdd.length === 0) {
      toast.info("All catalogs in this group are already added.");
      return;
    }
    setConfig(prev => ({
      ...prev,
      catalogs: [
        ...prev.catalogs,
        ...toAdd.map(c => ({
          id: c.id,
          name: c.name,
          type: c.type,
          source: c.source,
          enabled: true,
          showInHome: c.showOnHomeByDefault || false,
          enableRatingPosters: true,
          randomizePerPage: false,
        })),
      ],
    }));
    toast.success(`Added ${toAdd.length} catalog${toAdd.length !== 1 ? 's' : ''}`);
  };

  const handleRemoveAllInGroup = (catalogs: CatalogDefinition[]) => {
    const toRemove = catalogs.filter(c => isAdded(c));
    if (toRemove.length === 0) {
      toast.info("No catalogs from this group in your list.");
      return;
    }
    const removeKeys = new Set(toRemove.map(c => `${c.id}::${c.type}`));
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.filter(c => !removeKeys.has(`${c.id}::${c.type}`)),
    }));
    toast.success(`Removed ${toRemove.length} catalog${toRemove.length !== 1 ? 's' : ''}`);
  };

  const totalAdded = allBuiltInCatalogs.filter(c => isAdded(c)).length;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="AIOMetadata" className="h-8 w-8" />
            <div>
              <DialogTitle>AIOMetadata Catalogs</DialogTitle>
              <DialogDescription>
                Add or remove built-in catalogs from your list
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex items-center justify-between px-1 py-2 shrink-0">
          <span className="text-sm text-muted-foreground">
            {totalAdded} of {allBuiltInCatalogs.length} catalogs in your list
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleAddAllInGroup(allBuiltInCatalogs)}
              disabled={totalAdded === allBuiltInCatalogs.length}
              className="h-7 text-xs"
            >
              <Plus className="h-3 w-3 mr-1" />
              Add All
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleRemoveAllInGroup(allBuiltInCatalogs)}
              disabled={totalAdded === 0}
              className="h-7 text-xs"
            >
              <Minus className="h-3 w-3 mr-1" />
              Remove All
            </Button>
          </div>
        </div>

        <div className="space-y-4 overflow-y-auto flex-1 min-h-0 pr-2">
          {groups.map(group => {
            const addedCount = group.catalogs.filter(c => isAdded(c)).length;
            const isCollapsed = collapsedGroups.has(group.source);

            return (
              <Card key={group.source} className={cn('bg-gradient-to-br', group.gradient, group.border)}>
                <CardHeader
                  className="cursor-pointer p-4 sm:p-5"
                  onClick={() => toggleCollapse(group.source)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className={cn(
                        'shrink-0 h-10 w-10 rounded-lg flex items-center justify-center ring-1',
                        group.accent
                      )}>
                        {group.lucideLabel ? (
                          <span className="text-xs font-bold opacity-80">{group.lucideLabel}</span>
                        ) : (
                          <img src={group.icon} alt={group.label} className="h-5 w-5 object-contain" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <CardTitle className="text-base">{group.label}</CardTitle>
                          <Badge variant="outline" className="text-xs tabular-nums">
                            {addedCount}/{group.catalogs.length}
                          </Badge>
                        </div>
                        <CardDescription className="text-xs mt-0.5">
                          {group.description}
                        </CardDescription>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={(e) => { e.stopPropagation(); handleAddAllInGroup(group.catalogs); }}
                        disabled={addedCount === group.catalogs.length}
                      >
                        <Plus className="h-3 w-3 mr-1" />
                        All
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={(e) => { e.stopPropagation(); handleRemoveAllInGroup(group.catalogs); }}
                        disabled={addedCount === 0}
                      >
                        <Minus className="h-3 w-3 mr-1" />
                        All
                      </Button>
                      <ChevronDown className={cn(
                        'h-4 w-4 text-muted-foreground transition-transform',
                        isCollapsed && '-rotate-90'
                      )} />
                    </div>
                  </div>
                </CardHeader>
                {!isCollapsed && (
                  <CardContent className="pt-0 pb-4 px-4 sm:px-5">
                    <div className="space-y-1.5">
                      {group.catalogs.map((catalog) => {
                        const added = isAdded(catalog);
                        const key = `${catalog.id}-${catalog.type}`;
                        return (
                          <button
                            key={key}
                            onClick={() => handleToggle(catalog)}
                            className={cn(
                              'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all duration-150',
                              added
                                ? 'bg-primary/8 hover:bg-primary/12'
                                : 'hover:bg-muted/40'
                            )}
                          >
                            <div className={cn(
                              'shrink-0 h-5 w-5 rounded-md border flex items-center justify-center transition-all duration-150',
                              added
                                ? 'bg-primary border-primary text-primary-foreground'
                                : 'border-muted-foreground/30'
                            )}>
                              {added && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                            </div>
                            <span className={cn(
                              'flex-1 text-sm',
                              added ? 'font-medium' : 'text-muted-foreground'
                            )}>
                              {catalog.name}
                            </span>
                            <Badge
                              variant="outline"
                              className={cn(
                                'text-[10px] px-1.5 py-0 h-5 shrink-0 font-normal',
                                added && group.badgeActive
                              )}
                            >
                              {typeLabel(catalog.type)}
                            </Badge>
                          </button>
                        );
                      })}
                    </div>
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>

        <DialogFooter className="shrink-0 pt-2">
          <DialogClose asChild>
            <Button variant="ghost">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
