import { useState } from 'react';
import { Check, Trash2, Pencil, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useCatalogTags } from '@/hooks/useCatalogTags';
import { TAG_COLORS, TAG_COLOR_KEYS } from '@/lib/tagColors';
import { TagChip } from '@/components/TagChip';
import { MAX_TAG_NAME_LENGTH, type TagColorKey } from '@/contexts/config';

interface TagManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TagManagerDialog({ open, onOpenChange }: TagManagerDialogProps) {
  const { tags, tagCounts, renameTag, recolorTag, deleteTag } = useCatalogTags();
  const [editing, setEditing] = useState<string | null>(null);
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const startEdit = (name: string) => {
    setEditing(name);
    setColorPickerFor(name);
    setDraftName(name);
  };

  const commitEdit = (name: string) => {
    const nextName = draftName.trim();
    if (nextName && nextName.length <= MAX_TAG_NAME_LENGTH && nextName !== name) renameTag(name, nextName);
    setEditing(null);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setEditing(null);
      setColorPickerFor(null);
      setPendingDelete(null);
    }
    onOpenChange(nextOpen);
  };

  const handleConfirmDelete = () => {
    if (!pendingDelete) return;
    deleteTag(pendingDelete);
    setPendingDelete(null);
    if (editing === pendingDelete) setEditing(null);
    if (colorPickerFor === pendingDelete) setColorPickerFor(null);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <DialogTitle>Manage tags</DialogTitle>
              {tags.length > 0 && (
                <Badge variant="secondary" className="font-normal">
                  {tags.length} {tags.length === 1 ? 'tag' : 'tags'}
                </Badge>
              )}
            </div>
            <DialogDescription>
              Rename, recolor, or delete tags. Changes apply to every catalog.
            </DialogDescription>
          </DialogHeader>

          {tags.length === 0 ? (
            <div className="rounded-xl border border-dashed px-4 py-8 text-center">
              <p className="text-sm font-medium">No tags yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Select catalogs and use the Tag action to create one.
              </p>
            </div>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto rounded-xl border divide-y">
              {tags.map((t) => {
                const count = tagCounts[t.name] || 0;
                const showColors = colorPickerFor === t.name || editing === t.name;

                return (
                  <div key={t.name} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-2">
                        {editing === t.name ? (
                          <>
                            <Input
                              value={draftName}
                              autoFocus
                              onChange={(e) => setDraftName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitEdit(t.name);
                                if (e.key === 'Escape') setEditing(null);
                              }}
                              maxLength={MAX_TAG_NAME_LENGTH}
                              className="h-9"
                            />
                            <p className="text-xs text-muted-foreground">
                              {draftName.length}/{MAX_TAG_NAME_LENGTH} characters
                            </p>
                          </>
                        ) : (
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <TagChip name={t.name} color={t.color} />
                            <span className="text-xs text-muted-foreground">
                              {count} {count === 1 ? 'catalog' : 'catalogs'}
                            </span>
                          </div>
                        )}

                        <button
                          type="button"
                          onClick={() => setColorPickerFor(showColors ? null : t.name)}
                          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                          aria-expanded={showColors}
                        >
                          <span className={cn('h-3 w-3 rounded-full', TAG_COLORS[t.color].swatch)} />
                          Color
                        </button>
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        {editing === t.name ? (
                          <>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              onClick={() => commitEdit(t.name)}
                              disabled={!draftName.trim() || draftName.trim().length > MAX_TAG_NAME_LENGTH}
                              aria-label={`Save ${t.name}`}
                            >
                              <Check className="h-4 w-4" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditing(null)} aria-label={`Cancel renaming ${t.name}`}>
                              <X className="h-4 w-4" />
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => startEdit(t.name)} aria-label={`Rename ${t.name}`}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              onClick={() => setPendingDelete(t.name)}
                              aria-label={`Delete ${t.name}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>

                    {showColors && (
                      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-muted/30 p-2">
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
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!pendingDelete} onOpenChange={(nextOpen) => !nextOpen && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete tag?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes "{pendingDelete}" from every catalog. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleConfirmDelete}
            >
              Delete tag
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
