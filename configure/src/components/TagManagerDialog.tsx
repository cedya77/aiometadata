import { useMemo, useState } from 'react';
import { Ban, ChevronDown, Clock, DownloadCloud, ShieldCheck } from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useCatalogTags } from '@/hooks/useCatalogTags';
import { TAG_COLORS } from '@/lib/tagColors';
import { useConfig } from '@/contexts/ConfigContext';
import { TagRulesPanel } from '@/components/TagRulesPanel';
import type { TagDef } from '@/contexts/config';
import { hiddenCount } from '@/lib/tagRules';

interface TagManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function ruleChips(tag: TagDef): Array<{ icon: 'rating' | 'hidden' | 'hours' | 'downloads'; label: string }> {
  const hidden = hiddenCount(tag);
  return [
    ...(tag.ageRating && tag.ageRating !== 'None' ? [{ icon: 'rating' as const, label: `${tag.ageRating}${tag.allowUnratedContent === false ? ', rated only' : ''}` }] : []),
    ...(hidden ? [{ icon: 'hidden' as const, label: `${hidden} hidden` }] : []),
    ...(tag.viewingHours ? [{ icon: 'hours' as const, label: `${tag.viewingHours.start}-${tag.viewingHours.end}` }] : []),
    ...(tag.allowDownloads === false ? [{ icon: 'downloads' as const, label: 'No downloads' }] : []),
  ];
}

const CHIP_ICONS = { rating: ShieldCheck, hidden: Ban, hours: Clock, downloads: DownloadCloud };

export function TagManagerDialog({ open, onOpenChange }: TagManagerDialogProps) {
  const { tags, tagCounts, renameTag, recolorTag, setTagFilters, setTagRules, deleteTag } = useCatalogTags();
  const { config } = useConfig();
  const [openTag, setOpenTag] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const profilesByTag = useMemo(() => {
    const out = new Map<string, string[]>();
    const add = (name: string, held: string[] | undefined) => {
      for (const tag of held ?? []) {
        const key = tag.toLowerCase();
        out.set(key, [...(out.get(key) ?? []), name]);
      }
    };
    add(config.jellyfinUserName || config.addonName || 'You', config.jellyfinUserTags);
    for (const user of config.jellyfinUsers ?? []) add(user.name, user.tags);
    return out;
  }, [config.jellyfinUserName, config.addonName, config.jellyfinUserTags, config.jellyfinUsers]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) setPendingDelete(null);
    onOpenChange(nextOpen);
  };

  const handleConfirmDelete = () => {
    if (!pendingDelete) return;
    deleteTag(pendingDelete);
    if (openTag === pendingDelete) setOpenTag(null);
    setPendingDelete(null);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-2xl">
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
              A tag picks the catalogs a profile sees. Add rules and it becomes a kids or guest profile.
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
            <div className="max-h-[65vh] space-y-2 overflow-y-auto pr-1">
              {tags.map((t) => {
                const count = tagCounts[t.name] || 0;
                const profiles = profilesByTag.get(t.name.toLowerCase()) ?? [];
                const chips = ruleChips(t);
                const isOpen = openTag === t.name;
                return (
                  <div key={t.name} className={cn('overflow-hidden rounded-xl border transition-colors', isOpen ? 'bg-muted/20' : 'bg-card')}>
                    <button
                      type="button"
                      onClick={() => setOpenTag(isOpen ? null : t.name)}
                      aria-expanded={isOpen}
                      className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', TAG_COLORS[t.color].tint)}>
                        <span className={cn('h-3 w-3 rounded-full', TAG_COLORS[t.color].swatch)} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-semibold">{t.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {count} {count === 1 ? 'catalog' : 'catalogs'}{profiles.length ? ` · ${profiles.join(', ')}` : ''}
                        </span>
                      </span>
                      <span className="hidden flex-wrap justify-end gap-1.5 sm:flex">
                        {chips.length ? chips.map((chip) => {
                          const Icon = CHIP_ICONS[chip.icon];
                          return (
                            <span key={chip.icon} className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-foreground/90">
                              <Icon className="h-3 w-3" />
                              {chip.label}
                            </span>
                          );
                        }) : <span className="text-[11px] text-muted-foreground">No rules</span>}
                      </span>
                      <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
                    </button>
                    {isOpen && (
                      <TagRulesPanel
                        tag={t}
                        timezone={config.timezone || 'UTC'}
                        profiles={profiles}
                        onRename={(name) => {
                          renameTag(t.name, name);
                          setOpenTag(name);
                        }}
                        onRecolor={(color) => recolorTag(t.name, color)}
                        onFilters={(patch) => setTagFilters(t.name, patch)}
                        onRules={(patch) => setTagRules(t.name, patch)}
                        onDelete={() => setPendingDelete(t.name)}
                      />
                    )}
                  </div>
                );
              })}
              <p className="pt-1 text-xs text-muted-foreground">A profile with several tags gets the strictest of their rules.</p>
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
