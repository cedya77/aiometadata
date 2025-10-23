import { Button } from '@/components/ui/button';
import { CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SourceSelectionControlProps {
  source: string;
  catalogCount: number;
  selectedCount: number;
  onSelectAll: () => void;
  onDeselectAll: () => void;
}

export function SourceSelectionControl({
  source,
  catalogCount,
  selectedCount,
  onSelectAll,
  onDeselectAll,
}: SourceSelectionControlProps) {
  const allSelected = selectedCount === catalogCount && catalogCount > 0;
  const someSelected = selectedCount > 0 && selectedCount < catalogCount;

  return (
    <div className="flex items-center gap-2">
      {/* Visual indicator when all catalogs from source are selected */}
      {allSelected && (
        <CheckCircle2 
          className="h-5 w-5 md:h-4 md:w-4 text-green-500 dark:text-green-400 animate-fade-in" 
          aria-label="All catalogs from this source are selected"
        />
      )}
      
      {/* Select All button */}
      {!allSelected && (
        <Button
          size="sm"
          variant="ghost"
          onClick={onSelectAll}
          className={cn(
            "h-9 md:h-7 px-3 md:px-2 text-xs min-h-[44px] md:min-h-0",
            "transition-all duration-200 ease-out",
            someSelected && "text-blue-600 dark:text-blue-400"
          )}
          aria-label={`Select all ${source} catalogs`}
        >
          Select All
        </Button>
      )}
      
      {/* Deselect All button */}
      {(allSelected || someSelected) && (
        <Button
          size="sm"
          variant="ghost"
          onClick={onDeselectAll}
          className="h-9 md:h-7 px-3 md:px-2 text-xs min-h-[44px] md:min-h-0 transition-all duration-200 ease-out animate-fade-in"
          aria-label={`Deselect all ${source} catalogs`}
        >
          Deselect
        </Button>
      )}
    </div>
  );
}
