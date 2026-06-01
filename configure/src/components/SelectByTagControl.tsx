import { Tag } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useCatalogTags } from '@/hooks/useCatalogTags';

interface SelectByTagControlProps {
  onSelect: (tag: string) => void;
  onDeselect: (tag: string) => void;
}

export function SelectByTagControl({ onSelect, onDeselect }: SelectByTagControlProps) {
  const { tags, tagCounts } = useCatalogTags();

  if (tags.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 md:h-8 gap-2 min-h-[44px] md:min-h-0"
          aria-label="Select catalogs by tag"
        >
          <Tag className="h-4 w-4" />
          <span className="hidden sm:inline">Select by Tag</span>
          <span className="sm:hidden">By Tag</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <div className="px-2 py-1.5 text-sm font-semibold text-muted-foreground">Select by Tag</div>
        <DropdownMenuSeparator />
        {tags.map((t) => (
          <DropdownMenuItem
            key={t.name}
            onClick={() => onSelect(t.name)}
            className="cursor-pointer flex items-center justify-between"
          >
            <span>{t.name}</span>
            <Badge variant="secondary" className="ml-2 text-xs">{tagCounts[t.name] || 0}</Badge>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-sm font-semibold text-muted-foreground">Deselect by Tag</div>
        {tags.map((t) => (
          <DropdownMenuItem
            key={`deselect-${t.name}`}
            onClick={() => onDeselect(t.name)}
            className="cursor-pointer flex items-center justify-between"
          >
            <span>{t.name}</span>
            <Badge variant="outline" className="ml-2 text-xs">{tagCounts[t.name] || 0}</Badge>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
