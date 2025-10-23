import { useEffect, useRef } from 'react';
import { Check, Minus } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface SelectAllControlProps {
  totalVisible: number;
  selectedCount: number;
  onSelectAll: () => void;
  onDeselectAll: () => void;
}

export function SelectAllControl({
  totalVisible,
  selectedCount,
  onSelectAll,
  onDeselectAll,
}: SelectAllControlProps) {
  const checkboxRef = useRef<HTMLInputElement>(null);
  
  // Determine checkbox state
  const isAllSelected = selectedCount === totalVisible && totalVisible > 0;
  const isIndeterminate = selectedCount > 0 && selectedCount < totalVisible;

  // Update indeterminate state on the native checkbox element
  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = isIndeterminate;
    }
  }, [isIndeterminate]);

  // Handle click - toggle between select all and deselect all
  const handleClick = () => {
    if (isAllSelected || isIndeterminate) {
      onDeselectAll();
    } else {
      onSelectAll();
    }
  };

  const tooltipText = isAllSelected
    ? 'Deselect all catalogs'
    : isIndeterminate
    ? 'Select all catalogs'
    : 'Select all catalogs';

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2 py-2 min-h-[44px] md:min-h-0">
            {/* Custom styled checkbox */}
            <button
              type="button"
              role="checkbox"
              aria-checked={isAllSelected ? 'true' : isIndeterminate ? 'mixed' : 'false'}
              aria-label={`Select all ${totalVisible} catalogs`}
              onClick={handleClick}
              className={cn(
                'relative h-5 w-5 rounded border-2',
                // Smooth transitions for all properties
                'transition-all duration-200 ease-out',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                'disabled:cursor-not-allowed disabled:opacity-50',
                'flex items-center justify-center',
                // Hover scale effect
                totalVisible > 0 && 'hover:scale-110',
                isAllSelected || isIndeterminate
                  ? 'bg-primary border-primary text-primary-foreground'
                  : 'border-input bg-background hover:border-primary/50'
              )}
              disabled={totalVisible === 0}
            >
              {/* Hidden native checkbox for form compatibility */}
              <input
                ref={checkboxRef}
                type="checkbox"
                checked={isAllSelected}
                onChange={handleClick}
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
              />
              
              {/* Visual indicator with fade-in animation */}
              {isAllSelected && (
                <Check 
                  className="h-4 w-4 animate-fade-in" 
                  strokeWidth={3} 
                />
              )}
              {isIndeterminate && (
                <Minus 
                  className="h-4 w-4 animate-fade-in" 
                  strokeWidth={3} 
                />
              )}
            </button>

            {/* Label */}
            <label
              onClick={handleClick}
              className={cn(
                'text-sm font-medium cursor-pointer select-none',
                totalVisible === 0 && 'opacity-50 cursor-not-allowed'
              )}
            >
              Select All {totalVisible > 0 && `(${totalVisible} catalog${totalVisible === 1 ? '' : 's'})`}
            </label>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p>{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
