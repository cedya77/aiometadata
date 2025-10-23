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

interface SelectBySourceControlProps {
  catalogs: CatalogConfig[];
  onSelectBySource: (source: string) => void;
  onDeselectBySource: (source: string) => void;
}

export function SelectBySourceControl({
  catalogs,
  onSelectBySource,
  onDeselectBySource,
}: SelectBySourceControlProps) {
  // Get unique sources with counts
  const sourceCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    catalogs.forEach(catalog => {
      const source = catalog.source || 'custom';
      counts[source] = (counts[source] || 0) + 1;
    });
    return counts;
  }, [catalogs]);

  // Sort sources alphabetically
  const sortedSources = useMemo(() => {
    return Object.keys(sourceCounts).sort();
  }, [sourceCounts]);

  if (sortedSources.length === 0) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 md:h-8 gap-2 min-h-[44px] md:min-h-0"
          aria-label="Select catalogs by source"
        >
          <Filter className="h-4 w-4" />
          <span className="hidden sm:inline">Select by Source</span>
          <span className="sm:hidden">By Source</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <div className="px-2 py-1.5 text-sm font-semibold text-muted-foreground">
          Select by Source
        </div>
        <DropdownMenuSeparator />
        {sortedSources.map(source => (
          <div key={source}>
            <DropdownMenuItem
              onClick={() => onSelectBySource(source)}
              className="cursor-pointer flex items-center justify-between"
            >
              <span className="capitalize">{source}</span>
              <Badge variant="secondary" className="ml-2 text-xs">
                {sourceCounts[source]}
              </Badge>
            </DropdownMenuItem>
          </div>
        ))}
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-sm font-semibold text-muted-foreground">
          Deselect by Source
        </div>
        {sortedSources.map(source => (
          <div key={`deselect-${source}`}>
            <DropdownMenuItem
              onClick={() => onDeselectBySource(source)}
              className="cursor-pointer flex items-center justify-between"
            >
              <span className="capitalize">{source}</span>
              <Badge variant="outline" className="ml-2 text-xs">
                {sourceCounts[source]}
              </Badge>
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
