import { useMemo, useState } from 'react';
import { Check, Minus, Plus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useConfig } from '@/contexts/ConfigContext';
import { useCatalogTags } from '@/hooks/useCatalogTags';
import { TAG_COLORS, TAG_COLOR_KEYS, nextTagColor } from '@/lib/tagColors';
import { TagChip } from '@/components/TagChip';
import type { TagColorKey } from '@/contexts/config';

interface TagEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetKeys: Set<string>;
  title?: string;
}

export function TagEditorDialog({ open, onOpenChange, targetKeys, title }: TagEditorDialogProps) {
  const { config } = useConfig();
  const { tags, addTagToCatalogs, removeTagFromCatalogs } = useCatalogTags();

  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<TagColorKey | null>(null);

  const targetCount = targetKeys.size;

  // How many target catalogs carry each tag → tri-state (all / some / none).
  const tagState = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of config.catalogs) {
      if (!targetKeys.has(`${c.id}-${c.type}`)) continue;
      for (const t of c.tags ?? []) counts[t] = (counts[t] || 0) + 1;
    }
    return counts;
  }, [config.catalogs, targetKeys]);

  const toggleTag = (name: string) => {
    const count = tagState[name] || 0;
    if (count >= targetCount) removeTagFromCatalogs(targetKeys, name);
    else addTagToCatalogs(targetKeys, name);
  };

  const handleCreate = () => {
    const clean = newName.trim();
    if (!clean) return;
    addTagToCatalogs(targetKeys, clean);
    setNewName('');
    setNewColor(null);
  };

  const resolvedNewColor = newColor ?? nextTagColor(tags.map(t => t.color));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title || 'Tags'}</DialogTitle>
          <DialogDescription>
            {targetCount === 1
              ? 'Apply or remove tags for this catalog.'
              : `Apply or remove tags for ${targetCount} selected catalogs.`}
          </DialogDescription>
        </DialogHeader>

        {tags.length > 0 && (
          <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
            {tags.map((t) => {
              const count = tagState[t.name] || 0;
              const all = count >= targetCount && count > 0;
              const some = count > 0 && count < targetCount;
              return (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => toggleTag(t.name)}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 hover:bg-muted/60"
                >
                  <TagChip name={t.name} color={t.color} />
                  <span
                    className={cn(
                      'flex h-5 w-5 items-center justify-center rounded border',
                      all
                        ? 'border-primary bg-primary text-primary-foreground'
                        : some
                          ? 'border-primary/60 text-primary'
                          : 'border-muted-foreground/40 text-transparent',
                    )}
                  >
                    {all ? <Check className="h-3.5 w-3.5" /> : some ? <Minus className="h-3.5 w-3.5" /> : null}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="space-y-2 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground">Create a new tag</p>
          <div className="flex items-center gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
              placeholder="Tag name"
              className="h-9"
            />
            <Button size="sm" onClick={handleCreate} disabled={!newName.trim()} className="shrink-0">
              <Plus className="mr-1 h-4 w-4" /> Add
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {TAG_COLOR_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setNewColor(key)}
                aria-label={`Color ${key}`}
                className={cn(
                  'h-6 w-6 rounded-full border transition-transform',
                  TAG_COLORS[key].swatch,
                  (newColor ?? resolvedNewColor) === key
                    ? 'ring-2 ring-offset-2 ring-offset-background ring-foreground scale-110'
                    : 'border-transparent hover:scale-110',
                )}
              />
            ))}
          </div>
          {newName.trim() && (
            <div className="pt-1">
              <span className="text-xs text-muted-foreground">Preview: </span>
              <TagChip name={newName.trim()} color={newColor ?? resolvedNewColor} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
