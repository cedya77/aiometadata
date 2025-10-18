import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { type Catalog } from "@/data/catalogs";
import { streamingServices } from "@/data/streamings";
import { integrations } from "@/data/integrations";
import { useConfig } from "@/contexts/ConfigContext";

interface SortableCatalogCardProps {
  catalog: Catalog;
  config?: { enabled: boolean; showInHome: boolean };
  onChange: (enabled: boolean, showInHome: boolean) => void;
  id: string;
  name: string;
}

const getIntegrationInfo = (catalogId: string) => {
  const [integrationId] = catalogId.split(".");
  const integration = integrations.find(i => i.id === integrationId);
  
  return integration || { 
    id: integrationId,
    name: integrationId.toUpperCase(),
    icon: "/default.svg",
    description: "Unknown integration"
  };
};

export function SortableCatalogCard({ catalog, config, onChange, id }: SortableCatalogCardProps) {
  const { config: appConfig, hasBuiltInTvdb } = useConfig();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const isEnabled = config?.enabled || false;
  const showInHome = config?.showInHome || false;
  let integration = getIntegrationInfo(catalog.id);

  // Check if this is a TVDB catalog and if TVDB key is available
  const isTvdbCatalog = catalog.source === 'tvdb';
  const hasTvdbKey = !!appConfig.apiKeys?.tvdb?.trim() || hasBuiltInTvdb;
  const isTvdbDisabled = isTvdbCatalog && !hasTvdbKey;

  if (integration.id === "streaming") {
    const streamindId = catalog.id.split(".")[1];
    const foundService = streamingServices.find(s => s.id === streamindId);
    integration = { ...integration, icon: foundService?.icon || integration.icon };
  }

  return (
    <div ref={setNodeRef} style={style}>
      <Card className="h-full">
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="space-y-1 flex items-center gap-2">
              <button
                className="cursor-grab active:cursor-grabbing p-1 hover:bg-gray-100 rounded"
                {...attributes}
                {...listeners}
              >
                <GripVertical className="h-5 w-5 text-gray-500" />
              </button>
              <div className="w-8 h-8 flex items-center justify-center bg-gray-50 rounded-md">
                <img 
                  src={integration.icon} 
                  alt={`${integration.name} logo`} 
                  className="w-full h-full object-contain rounded-md"
                />
              </div>
              <h1 className="font-semibold flex items-center gap-2">
                {catalog.name}
                <Badge variant="outline">
                  {catalog.type === "movie" ? "Movie" : "Series"}
                </Badge>
              </h1>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-muted-foreground">Enable</span>
              <Switch
                checked={isEnabled}
                onCheckedChange={(checked) => onChange(checked, checked ? showInHome : false)}
                disabled={isTvdbDisabled}
              />
              <span className={`text-sm ${!isEnabled ? "text-muted-foreground/50" : "text-muted-foreground"}`}>
                Home
              </span>
              <Switch
                checked={showInHome}
                onCheckedChange={(checked) => onChange(isEnabled, checked)}
                disabled={!isEnabled || isTvdbDisabled}
              />
              {isTvdbDisabled && (
                <span className="text-xs text-muted-foreground">
                  (TVDB API key required)
                </span>
              )}
            </div>
          </div>
        </CardHeader>
      </Card>
    </div>
  );
}