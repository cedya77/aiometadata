import { useState } from 'react';
import { Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCatalogTags } from '@/hooks/useCatalogTags';
import { TagChip } from '@/components/TagChip';
import { TagManagerDialog } from '@/components/TagManagerDialog';

interface TagFilterBarProps {
  tagFilters: string[];
  onToggle: (name: string) => void;
  onClear: () => void;
}

export function TagFilterBar({ tagFilters, onToggle, onClear }: TagFilterBarProps) {
  const { tags, tagCounts } = useCatalogTags();
  const [managerOpen, setManagerOpen] = useState(false);

  if (tags.length === 0) return null;

  const hasFilter = tagFilters.length > 0;

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-muted/30 px-2.5 py-2">
      <span className="mr-1 text-xs font-medium text-muted-foreground">Tags:</span>
      {tags.map((t) => {
        const active = tagFilters.includes(t.name);
        return (
          <TagChip
            key={t.name}
            name={`${t.name} (${tagCounts[t.name] || 0})`}
            color={t.color}
            onClick={() => onToggle(t.name)}
            dimmed={hasFilter && !active}
          />
        );
      })}
      {hasFilter && (
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onClear}>
          Clear
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="ml-auto h-7 w-7 text-muted-foreground"
        onClick={() => setManagerOpen(true)}
        aria-label="Manage tags"
      >
        <Settings2 className="h-4 w-4" />
      </Button>
      <TagManagerDialog open={managerOpen} onOpenChange={setManagerOpen} />
    </div>
  );
}
