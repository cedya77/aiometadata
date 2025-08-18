import React, { useState, useMemo } from 'react';
import { MDBListIntegration } from './MDBListIntegration'; // Ensure this path is correct
import { useConfig, CatalogConfig } from '@/contexts/ConfigContext';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Eye, EyeOff, Home, GripVertical, RefreshCw } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { streamingServices, regions } from "@/data/streamings";
import { allCatalogDefinitions } from '@/data/catalogs';

// Move groupBySource to top-level so it's always defined before use
const groupBySource = (catalogs: CatalogConfig[]) => {
  return catalogs.reduce((acc, cat) => {
    const key = cat.source || 'Other';
    if (!acc[key]) acc[key] = [];
    acc[key].push(cat);
    return acc;
  }, {} as Record<string, CatalogConfig[]>);
};

const sourceBadgeStyles = {
  tmdb: "bg-blue-800/80 text-blue-200 border-blue-600/50 hover:bg-blue-800",
  tvdb: "bg-green-800/80 text-green-200 border-green-600/50 hover:bg-green-800",
  mal: "bg-indigo-800/80 text-indigo-200 border-indigo-600/50 hover:bg-indigo-800",
  mdblist: "bg-yellow-800/80 text-yellow-200 border-yellow-600/50 hover:bg-yellow-800",
};

const CollapsibleSection = ({ title, children }: { title: string, children: React.ReactNode }) => {
  const [open, setOpen] = useState(true);
  return (
    <div className="mb-4">
      <button onClick={() => setOpen((o) => !o)} className="font-bold text-lg mb-2">
        {open ? "▼" : "►"} {title}
      </button>
      {open && <div className="pl-4">{children}</div>}
    </div>
  );
};

const SortableCatalogItem = ({ catalog }: { catalog: CatalogConfig & { source?: string }; }) => {
  const { setConfig } = useConfig();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `${catalog.id}-${catalog.type}` });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : 'auto',
  };
  
  const badgeSource = catalog.source || 'custom';
  const badgeStyle = sourceBadgeStyles[badgeSource as keyof typeof sourceBadgeStyles] || "bg-gray-700";

  const handleToggleEnabled = () => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(c => {
        if (c.id === catalog.id && c.type === catalog.type) {
          const isNowEnabled = !c.enabled;
          return { ...c, enabled: isNowEnabled, showInHome: isNowEnabled ? c.showInHome : false };
        }
        return c;
      })
    }));
  };

  const handleToggleShowInHome = () => {
    if (!catalog.enabled) return;
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(c =>
        (c.id === catalog.id && c.type === catalog.type) ? { ...c, showInHome: !c.showInHome } : c
      )
    }));
  };

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={`flex items-center justify-between p-4 transition-all duration-200
        ${isDragging ? 'opacity-50 scale-105 shadow-lg' : ''}
        ${!catalog.enabled ? 'opacity-60' : ''}
      `}
    >
      <div className="flex items-center space-x-4">
        <button {...attributes} {...listeners} className="cursor-grab text-muted-foreground p-2 -ml-2 touch-none" aria-label="Drag to reorder">
          <GripVertical />
        </button>
        <div className="flex-shrink-0">
          <Badge variant="outline" className={`font-semibold ${badgeStyle}`}>
            {badgeSource.toUpperCase()}
          </Badge>
        </div>
        <div>
          <p className={`font-medium transition-colors ${catalog.enabled ? 'text-foreground' : 'text-muted-foreground'}`}>{catalog.name}</p>
          <p className={`text-sm transition-colors ${catalog.enabled ? 'text-muted-foreground' : 'text-muted-foreground/50'} capitalize`}>{catalog.type}</p>
        </div>
      </div>

      <div className="flex items-center space-x-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={handleToggleEnabled}>
                {catalog.enabled ? (
                  <Eye className="h-5 w-5 text-green-500 dark:text-green-400" />
                ) : (
                  <EyeOff className="h-5 w-5 text-muted-foreground" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent><p>{catalog.enabled ? 'Enabled (Visible)' : 'Disabled'}</p></TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleToggleShowInHome}
                disabled={!catalog.enabled}
                className="disabled:opacity-20 disabled:cursor-not-allowed"
              >
                <Home className={`h-5 w-5 transition-colors ${catalog.showInHome && catalog.enabled ? 'text-blue-500 dark:text-blue-400' : 'text-muted-foreground'}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent><p>{catalog.showInHome && catalog.enabled ? 'Featured on Home Board' : 'Not on Home Board'}</p></TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </Card>
  );
};

const StreamingProvidersSettings = ({ open, onClose, selectedProviders, setSelectedProviders }) => {
  const [selectedCountry, setSelectedCountry] = useState('Any');

  const showProvider = (serviceId: string) => {
    const countryList = regions[selectedCountry as keyof typeof regions];
    return Array.isArray(countryList) && countryList.includes(serviceId);
  };

  const toggleService = (serviceId: string) => {
    setSelectedProviders((prev: string[] = []) =>
      Array.isArray(prev) && prev.includes(serviceId)
        ? prev.filter(id => id !== serviceId)
        : [...(prev || []), serviceId]
    );
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Manage Streaming Providers</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground mb-2">Filter providers by country:</p>
            <Select value={selectedCountry} onValueChange={setSelectedCountry}>
              <SelectTrigger className="bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-background border shadow-md">
                {Object.keys(regions).map((country) => (
                  <SelectItem key={country} value={country} className="cursor-pointer">
                    {country}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-5 gap-4">
            {streamingServices.map((service) => (
              showProvider(service.id) && (
                <button
                  key={service.id}
                  onClick={() => toggleService(service.id)}
                  className={`w-12 h-12 sm:w-14 sm:h-14 rounded-xl border transition-opacity ${
                    Array.isArray(selectedProviders) && selectedProviders.includes(service.id)
                      ? "border-primary bg-primary/5"
                      : "border-border opacity-50 hover:opacity-100"
                  }`}
                  title={service.name}
                >
                  <img
                    src={service.icon}
                    alt={service.name}
                    className="w-full h-full rounded-lg object-cover"
                  />
                </button>
              )
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline" type="button" onClick={onClose}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" onClick={onClose}>
              Save Changes
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export function CatalogsSettings() {
  const { config, setConfig } = useConfig();
  const [isMdbListOpen, setIsMdbListOpen] = useState(false);
  const [streamingDialogOpen, setStreamingDialogOpen] = useState(false);
  const [tempSelectedProviders, setTempSelectedProviders] = useState<string[]>(config.streaming);
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  // Only show streaming catalogs for enabled providers
  const filteredCatalogs = useMemo(() =>
    config.catalogs.filter(cat => {
      if (cat.source !== "streaming") return true;
      const serviceId = cat.id.replace("streaming.", "").replace(/ .*/, "");
      return Array.isArray(config.streaming) && config.streaming.includes(serviceId);
    }),
    [config.catalogs, config.streaming]
  );
  const grouped = useMemo(() => groupBySource(filteredCatalogs), [filteredCatalogs]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setConfig(prev => {
        const oldIndex = prev.catalogs.findIndex(c => `${c.id}-${c.type}` === active.id);
        const newIndex = prev.catalogs.findIndex(c => `${c.id}-${c.type}` === over.id);
        return { ...prev, catalogs: arrayMove(prev.catalogs, oldIndex, newIndex) };
      });
    }
  };

  const catalogItemIds = filteredCatalogs.map(c => `${c.id}-${c.type}`);

  const handleOpenStreamingDialog = () => {
    setTempSelectedProviders(config.streaming);
    setStreamingDialogOpen(true);
  };

  const handleCloseStreamingDialog = () => {
    setConfig(prev => {
      // Add missing streaming catalogs for newly selected providers
      const newCatalogs = [...prev.catalogs];
      tempSelectedProviders.forEach(serviceId => {
        ['movie', 'series'].forEach(type => {
          const catalogId = `streaming.${serviceId}`;
          if (!newCatalogs.some(c => c.id === catalogId && c.type === type)) {
            // Find the catalog definition for this provider/type
            const def = allCatalogDefinitions.find(
              c => c.id === catalogId && c.type === type
            );
            if (def) {
              newCatalogs.push({
                id: def.id,
                name: def.name,
                type: def.type,
                source: def.source,
                enabled: false,
                showInHome: false,
              });
            }
          }
        });
      });
      return {
        ...prev,
        streaming: tempSelectedProviders,
        catalogs: newCatalogs,
      };
    });
    setStreamingDialogOpen(false);
  };

  const handleReloadCatalogs = () => {
    setConfig(prev => {
      const defaultCatalogs = allCatalogDefinitions.map(c => ({
        id: c.id,
        name: c.name,
        type: c.type,
        source: c.source,
        enabled: c.isEnabledByDefault || false,
        showInHome: c.showOnHomeByDefault || false,
      }));
      const userCatalogSettings = new Map(
        prev.catalogs.map(c => [`${c.id}-${c.type}`, { enabled: c.enabled, showInHome: c.showInHome }])
      );
      const userCatalogKeys = new Set(prev.catalogs.map(c => `${c.id}-${c.type}`));
      const missingCatalogs = defaultCatalogs.filter(def => !userCatalogKeys.has(`${def.id}-${def.type}`));
      // Append missing catalogs to the end of the list
      const mergedCatalogs = [
        ...prev.catalogs,
        ...missingCatalogs
      ];
      const hydratedCatalogs = mergedCatalogs.map(defaultCatalog => {
        const key = `${defaultCatalog.id}-${defaultCatalog.type}`;
        if (userCatalogSettings.has(key)) {
          return { ...defaultCatalog, ...userCatalogSettings.get(key) };
        }
        return defaultCatalog;
      });
      return {
        ...prev,
        catalogs: hydratedCatalogs,
      };
    });
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold">Catalog Management</h2>
          <p className="text-muted-foreground">
            Drag to reorder. Click icons to toggle visibility.
          </p>
          <div className="flex items-center space-x-4 pt-2 text-sm text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <Eye className="h-4 w-4 text-green-500 dark:text-green-400"/> Enabled
            </div>
            <div className="flex items-center gap-1.5">
              <Home className="h-4 w-4 text-blue-500 dark:text-blue-400"/> On Home Board
            </div>
          </div>
        </div>
        <div className="flex-shrink-0 flex gap-2">
          <Button onClick={handleOpenStreamingDialog}>Manage Streaming Providers</Button>
          <Button onClick={() => setIsMdbListOpen(true)}>Manage MDBList Integration</Button>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={handleReloadCatalogs} aria-label="Reload Catalogs">
                  <RefreshCw className="w-5 h-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh catalogs to look for updates</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={catalogItemIds} strategy={verticalListSortingStrategy}>
          <div className="space-y-4">
            {Object.entries(grouped).map(([source, groupCatalogs]) => (
              <CollapsibleSection key={source} title={source.toUpperCase()}>
                {groupCatalogs.map((catalog) => (
                  <SortableCatalogItem key={`${catalog.id}-${catalog.type}`} catalog={catalog} />
                ))}
              </CollapsibleSection>
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <StreamingProvidersSettings
        open={streamingDialogOpen}
        onClose={handleCloseStreamingDialog}
        selectedProviders={tempSelectedProviders}
        setSelectedProviders={setTempSelectedProviders}
      />
      <MDBListIntegration
        isOpen={isMdbListOpen}
        onClose={() => setIsMdbListOpen(false)}
      />
    </div>
  );
}