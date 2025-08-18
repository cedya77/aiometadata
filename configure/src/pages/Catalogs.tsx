import { useEffect } from "react";
import { useConfig } from "@/contexts/ConfigContext";
import { baseCatalogs, authCatalogs, streamingCatalogs } from "@/data/catalogs";
import { 
  DndContext, 
  DragEndEvent, 
  closestCenter,
  TouchSensor,
  MouseSensor,
  useSensor,
  useSensors 
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { SortableCatalogCard } from "@/components/SortableCatalogCard";
import { useState } from "react";
import { allCatalogDefinitions } from "@/data/catalogs";

const groupBySource = (catalogs) => {
  return catalogs.reduce((acc, cat) => {
    const key = cat.source || "Other";
    if (!acc[key]) acc[key] = [];
    acc[key].push(cat);
    return acc;
  }, {});
};

const CollapsibleSection = ({ title, children }) => {
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

const CatalogColumn = ({
  title,
  catalogs,
  catalogConfigs,
  onCatalogChange,
  onDragEnd,
  sensors
}) => (
  <div className="flex flex-col gap-6">
    <h2 className="text-lg font-semibold">{title}</h2>
    <DndContext 
      sensors={sensors}
      collisionDetection={closestCenter} 
      onDragEnd={onDragEnd}
    >
      <SortableContext
        items={catalogs.map((c) => `${c.id}-${c.type}`)}
        strategy={verticalListSortingStrategy}
      >
        {catalogs.map((catalog) => (
          <SortableCatalogCard
            key={`${catalog.id}-${catalog.type}`}
            id={`${catalog.id}-${catalog.type}`}
            catalog={catalog}
            name={catalog.name} 
            config={catalogConfigs[`${catalog.id}-${catalog.type}`]}
            onChange={(enabled, showInHome) => 
              onCatalogChange(catalog.id, catalog.type, enabled, showInHome)
            }
          />
        ))}
      </SortableContext>
    </DndContext>
  </div>
);

const Catalogs = () => {
  const { config, setConfig } = useConfig();
  const { sessionId, streaming = [], catalogs = [] } = config;

  const mouseSensor = useSensor(MouseSensor, {
    activationConstraint: {
      distance: 10,
    },
  });
  
  const touchSensor = useSensor(TouchSensor, {
    activationConstraint: {
      delay: 250,
      tolerance: 5,
    },
  });

  const sensors = useSensors(mouseSensor, touchSensor);

  useEffect(() => {
    const allCatalogs = [
      ...baseCatalogs,
      ...(sessionId ? authCatalogs : []),
      ...(streaming?.length
        ? streaming.flatMap((serviceId) => streamingCatalogs[serviceId] || [])
        : []),
    ];

    setConfig((prev) => {
      const existingIds = new Set(prev.catalogs.map((c) => `${c.id}-${c.type}`));
      const newCatalogs = allCatalogs.filter(
        (c) => !existingIds.has(`${c.id}-${c.type}`)
      );

      return {
        ...prev,
        catalogs: [
          ...prev.catalogs,
          ...newCatalogs.map((c) => ({ 
            id: c.id, 
            type: c.type, 
            name: c.name, 
            source: c.source,
            enabled: false,
            showInHome: false 
          })),
        ],
      };
    });
  }, [sessionId, streaming, setConfig]);

  const catalogConfigs = catalogs.reduce((acc, config) => {
    const key = `${config.id}-${config.type}`;
    acc[key] = {
      enabled: config.enabled,
      showInHome: config.showInHome,
    };
    return acc;
  }, {});

  const handleCatalogChange = (catalogId, type, enabled, showInHome) => {
    setConfig((prev) => ({
      ...prev,
      catalogs: prev.catalogs.map((c) =>
        c.id === catalogId && c.type === type
          ? { ...c, enabled: enabled === true, showInHome }
          : c
      ),
    }));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setConfig((prev) => {
      const oldIndex = prev.catalogs.findIndex((c) => `${c.id}-${c.type}` === active.id);
      const newIndex = prev.catalogs.findIndex((c) => `${c.id}-${c.type}` === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      const newCatalogs = arrayMove(prev.catalogs, oldIndex, newIndex);
      return { ...prev, catalogs: newCatalogs };
    });
  };

  // Only show streaming catalogs for enabled providers
  const filteredCatalogs = catalogs.filter(cat => {
    if (cat.source !== "streaming") return true;
    // Only show if the streaming provider is enabled in config
    const serviceId = cat.id.replace("streaming.", "").replace(/ .*/, "");
    return streaming.includes(serviceId);
  });
  const grouped = groupBySource(filteredCatalogs);

  return (
    <main className="md:p-12 px-2 py-12">
      <div className="flex flex-col mb-6">
        <h1 className="text-xl font-semibold mb-1">Catalogs</h1>
        <p className="text-gray-500 text-sm">Manage the catalogs available in the addon.</p>
      </div>
      {Object.entries(grouped).map(([source, groupCatalogs]) => (
        <CollapsibleSection key={source} title={source.toUpperCase()}>
          {Array.isArray(groupCatalogs) && groupCatalogs.map((catalog) => (
            <SortableCatalogCard
              key={`${catalog.id}-${catalog.type}`}
              id={`${catalog.id}-${catalog.type}`}
              catalog={catalog}
              name={catalog.name}
              config={catalogConfigs[`${catalog.id}-${catalog.type}`]}
              onChange={(enabled, showInHome) =>
                handleCatalogChange(catalog.id, catalog.type, enabled, showInHome)
              }
            />
          ))}
        </CollapsibleSection>
      ))}
    </main>
  );
};

export default Catalogs;