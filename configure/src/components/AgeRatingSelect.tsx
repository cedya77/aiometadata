import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ageRatings } from "@/data/ageRatings";
import { useConfig } from "@/contexts/ConfigContext";
import { Info } from "lucide-react";

export function AgeRatingSelect() {
  const { config, setConfig } = useConfig();
  const ageRating = config.ageRating;

  const selectedRating = ageRatings.find(rating => rating.id === ageRating);

  const handleChange = (value: string) => {
    setConfig((prev) => ({
      ...prev,
      ageRating: value === "NONE" ? "None" : value,
    }));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-semibold mb-1">Age Rating</label>
        <div className="flex items-center text-xs text-muted-foreground">
          <Info className="h-3 w-3 mr-1" />
          Not available for trending catalogs
        </div>
      </div>
      <Select
        value={!ageRating || ageRating === "None" ? "NONE" : ageRating}
        onValueChange={handleChange}
      >
        <SelectTrigger>
          <SelectValue>
            {selectedRating && (
              <div className="flex items-center gap-2">
                <Badge className={`${selectedRating.badge.color} text-white w-16 justify-center`}>
                  {selectedRating.badge.text}
                </Badge>
                <span>{selectedRating.name}</span>
              </div>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="bg-background border shadow-md">
          {ageRatings.map((rating) => (
            <SelectItem key={rating.id} value={rating.id}>
              <div className="flex items-center gap-2">
                <Badge className={`${rating.badge.color} text-white w-16 justify-center`}>
                  {rating.badge.text}
                </Badge>
                <div className="flex flex-col">
                  <span>{rating.name}</span>
                </div>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
} 
