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
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useConfig } from '@/contexts/ConfigContext';
import { useCatalogTags } from '@/hooks/useCatalogTags';
import { TAG_COLORS, TAG_COLOR_KEYS, nextTagColor } from '@/lib/tagColors';
import { TagChip } from '@/components/TagChip';
import { MAX_TAG_NAME_LENGTH, type TagColorKey } from '@/contexts/config';

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

  const resolvedNewColor = newColor ?? nextTagColor(tags.map(t => t.color));

  const handleCreate = () => {
    const clean = newName.trim();
    if (!clean || clean.length > MAX_TAG_NAME_LENGTH) return;
    addTagToCatalogs(targetKeys, clean, resolvedNewColor);
    setNewName('');
    setNewColor(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <div className="flex min-w-0 items-center gap-2">
            <DialogTitle className="truncate">{title || 'Tags'}</DialogTitle>
            <Badge variant="secondary" className="shrink-0 font-normal">
              {targetCount === 1 ? '1 catalog' : `${targetCount} catalogs`}
            </Badge>
          </div>
          <DialogDescription>
            {targetCount === 1
              ? 'Apply or remove tags for this catalog.'
              : `Apply or remove tags for ${targetCount} selected catalogs.`}
          </DialogDescription>
        </DialogHeader>

        {tags.length > 0 ? (
          <div className="max-h-[42vh] overflow-y-auto rounded-xl border divide-y">
            {tags.map((t) => {
              const count = tagState[t.name] || 0;
              const all = count >= targetCount && count > 0;
              const some = count > 0 && count < targetCount;
              const statusLabel = targetCount === 1
                ? all ? 'Applied' : 'Not applied'
                : all
                  ? 'Applied to all'
                  : some
                    ? `Applied to ${count} of ${targetCount}`
                    : 'Not applied';

              return (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => toggleTag(t.name)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
                >
                  <div className="min-w-0 space-y-1">
                    <TagChip name={t.name} color={t.color} />
                    <p className="text-xs text-muted-foreground">{statusLabel}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {targetCount > 1 && some && (
                      <span className="text-xs text-muted-foreground">
                        {count}/{targetCount}
                      </span>
                    )}
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
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed px-4 py-6 text-center">
            <p className="text-sm font-medium">No tags yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Create your first tag below and it will be applied immediately.
            </p>
          </div>
        )}

        <div className="space-y-3 rounded-xl border bg-muted/20 p-3">
          <div>
            <p className="text-sm font-medium">Create a new tag</p>
            <p className="text-xs text-muted-foreground">New tags are applied to the current selection.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
              placeholder="Tag name"
              maxLength={MAX_TAG_NAME_LENGTH}
              className="h-9"
            />
            <Button size="sm" onClick={handleCreate} disabled={!newName.trim() || newName.trim().length > MAX_TAG_NAME_LENGTH} className="shrink-0 sm:w-auto">
              <Plus className="mr-1 h-4 w-4" /> Add
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {newName.length}/{MAX_TAG_NAME_LENGTH} characters
          </p>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Color</p>
            <div className="flex flex-wrap items-center gap-2">
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
          </div>

          {newName.trim() && (
            <div className="rounded-lg bg-background/60 px-2.5 py-2">
              <span className="text-xs text-muted-foreground">Preview: </span>
              <TagChip name={newName.trim()} color={newColor ?? resolvedNewColor} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
