import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useState, useEffect } from "react";
import { useConfig } from "@/contexts/ConfigContext";
import { DialogClose } from "@/components/ui/dialog";
import { regions, streamingServices } from "@/data/streamings";

export default function Streaming() {
  const [selectedCountry, setSelectedCountry] = useState("Brazil");
  const { config, setConfig } = useConfig();
  const [tempSelectedServices, setTempSelectedServices] = useState<string[]>([]);

  useEffect(() => {
    setTempSelectedServices(config.streaming);
  }, [config.streaming]);

  const toggleService = (serviceId: string) => {
    setTempSelectedServices(prev => 
      prev.includes(serviceId) 
        ? prev.filter(id => id !== serviceId)
        : [...prev, serviceId]
    );
  };

  const showProvider = (serviceId: string) => {
    return regions[selectedCountry as keyof typeof regions]?.includes(serviceId);
  };

  const handleSave = () => {
    setConfig((prev) => ({ ...prev, streaming: tempSelectedServices }));
  };

  const handleCancel = () => {
    setTempSelectedServices(config.streaming);
  };

  return (
    
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">
        Based on <a href="https://github.com/rleroi/Stremio-Streaming-Catalogs-Addon" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">rleroi/Stremio-Streaming-Catalogs-Addon</a>
      </p>
      <div>
        <div className="space-y-6">
          <div>
            <p className="text-sm text-muted-foreground mb-2">Filter providers by country:</p>
            <Select value={selectedCountry} onValueChange={setSelectedCountry}>
              <SelectTrigger className="bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-background border shadow-md">
                {Object.keys(regions).map((country) => (
                  <SelectItem 
                    key={country} 
                    value={country}
                    className="cursor-pointer hover:bg-accent hover:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                  >
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
                    tempSelectedServices.includes(service.id)
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
              <Button variant="outline" type="button" onClick={handleCancel}>
                Cancel
              </Button>
            </DialogClose>
            <DialogClose asChild>
              <Button type="button" onClick={handleSave}>
                Save Changes
              </Button>
            </DialogClose>
          </div>
        </div>
      </div>
    </div>
  );
}
