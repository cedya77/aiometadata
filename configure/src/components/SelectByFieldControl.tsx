import { useMemo } from 'react';
import { Filter } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CatalogConfig } from '@/contexts/ConfigContext';

interface SelectByFieldControlProps {
  catalogs: CatalogConfig[];
  field: 'source' | 'type';
  label: string;
  shortLabel: string;
  onSelect: (value: string) => void;
  onDeselect: (value: string) => void;
}

export function SelectByFieldControl({
  catalogs,
  field,
  label,
  shortLabel,
  onSelect,
  onDeselect,
}: SelectByFieldControlProps) {
  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    catalogs.forEach(catalog => {
      const value = (catalog[field] as string) || 'custom';
      result[value] = (result[value] || 0) + 1;
    });
    return result;
  }, [catalogs, field]);

  const sortedValues = useMemo(() => Object.keys(counts).sort(), [counts]);

  if (sortedValues.length === 0) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 md:h-8 gap-2 min-h-[44px] md:min-h-0"
          aria-label={`Select catalogs by ${field}`}
        >
          <Filter className="h-4 w-4" />
          <span className="hidden sm:inline">{label}</span>
          <span className="sm:hidden">{shortLabel}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <div className="px-2 py-1.5 text-sm font-semibold text-muted-foreground">
          {label}
        </div>
        <DropdownMenuSeparator />
        {sortedValues.map(value => (
          <DropdownMenuItem
            key={value}
            onClick={() => onSelect(value)}
            className="cursor-pointer flex items-center justify-between"
          >
            <span className="capitalize">{value}</span>
            <Badge variant="secondary" className="ml-2 text-xs">
              {counts[value]}
            </Badge>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-sm font-semibold text-muted-foreground">
          Deselect by {field === 'source' ? 'Source' : 'Type'}
        </div>
        {sortedValues.map(value => (
          <DropdownMenuItem
            key={`deselect-${value}`}
            onClick={() => onDeselect(value)}
            className="cursor-pointer flex items-center justify-between"
          >
            <span className="capitalize">{value}</span>
            <Badge variant="outline" className="ml-2 text-xs">
              {counts[value]}
            </Badge>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
