import { useState } from 'react';
import { Check, Trash2, Pencil, X } from 'lucide-react';
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
import { useCatalogTags } from '@/hooks/useCatalogTags';
import { TAG_COLORS, TAG_COLOR_KEYS } from '@/lib/tagColors';
import { TagChip } from '@/components/TagChip';
import type { TagColorKey } from '@/contexts/config';

interface TagManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TagManagerDialog({ open, onOpenChange }: TagManagerDialogProps) {
  const { tags, tagCounts, renameTag, recolorTag, deleteTag } = useCatalogTags();
  const [editing, setEditing] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const startEdit = (name: string) => {
    setEditing(name);
    setDraftName(name);
  };

  const commitEdit = (name: string) => {
    if (draftName.trim() && draftName.trim() !== name) renameTag(name, draftName.trim());
    setEditing(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Manage tags</DialogTitle>
          <DialogDescription>Rename, recolor, or delete tags. Changes apply to every catalog.</DialogDescription>
        </DialogHeader>

        {tags.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No tags yet. Select catalogs and use the Tag action to create one.
          </p>
        ) : (
          <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
            {tags.map((t) => (
              <div key={t.name} className="rounded-lg border p-2.5">
                <div className="flex items-center justify-between gap-2">
                  {editing === t.name ? (
                    <div className="flex flex-1 items-center gap-1">
                      <Input
                        value={draftName}
                        autoFocus
                        onChange={(e) => setDraftName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEdit(t.name);
                          if (e.key === 'Escape') setEditing(null);
                        }}
                        className="h-8"
                      />
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => commitEdit(t.name)}>
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditing(null)}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <TagChip name={t.name} color={t.color} />
                        <span className="text-xs text-muted-foreground">{tagCounts[t.name] || 0} catalogs</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => startEdit(t.name)} aria-label={`Rename ${t.name}`}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          onClick={() => deleteTag(t.name)}
                          aria-label={`Delete ${t.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {TAG_COLOR_KEYS.map((key: TagColorKey) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => recolorTag(t.name, key)}
                      aria-label={`Set ${t.name} color ${key}`}
                      className={cn(
                        'h-5 w-5 rounded-full border transition-transform',
                        TAG_COLORS[key].swatch,
                        t.color === key
                          ? 'ring-2 ring-offset-2 ring-offset-background ring-foreground scale-110'
                          : 'border-transparent hover:scale-110',
                      )}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
