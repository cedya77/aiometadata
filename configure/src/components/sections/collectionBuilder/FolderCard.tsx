import { useEffect, useId, useRef, useState } from 'react';
import { ChevronLeft, FolderPlus, Plus, Tags, Trash2, Tv } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getTagColor } from '@/lib/tagColors';
import { catalogKey, type ManifestCatalog } from '@/lib/collectionBuilder/manifestSources';
import { TERMS, type Target } from '@/lib/collectionBuilder/terms';
import { folderSources, hasNuvioFolderArt, subFolders, type FolderDraft, type SourceDraft } from '@shared/types';
import { FOLDER_MERGE_MODE, mergeModeOf } from '@shared/mergeModes';
import { MergeModePicker } from '@/components/MergeModePicker';

import { ImageUrlField } from './ImageUrlField';
import { ScopeChip } from './ScopeChip';
import { SortableSourceRow } from './SourceRow';
import { ASPECT_BY_TILE, SHAPE_LABELS, SHAPE_ORDER, SHAPE_PREVIEW, type TagOption } from './shared';

export function FolderCard({
  folder,
  catalogs,
  pendingKeys,
  target,
  onChange,
  onUndoableChange,
  onRemove,
  onAddSource,
  onReplaceSource,
  onRenameCatalog,
  tagOptions,
  onAddByTag,
  focusTitle,
  onTitleFocused,
  parent,
  onOpenFolder,
  onAddSubFolder,
}: {
  folder: FolderDraft;
  catalogs: ManifestCatalog[];
  pendingKeys?: Set<string>;
  target: Target;
  onChange: (next: FolderDraft) => void;
  /** Same as onChange, but the caller offers an Undo that replays the inverse. */
  onUndoableChange?: (
    label: string,
    apply: (folder: FolderDraft) => FolderDraft,
    undo: (folder: FolderDraft) => FolderDraft
  ) => void;
  onRemove: () => void;
  onAddSource: () => void;
  onReplaceSource: (index: number) => void;
  /** Renames the catalog itself, everywhere it appears. */
  onRenameCatalog?: (source: SourceDraft, name: string) => void;
  tagOptions: TagOption[];
  onAddByTag: (tag: string) => void;
  focusTitle?: boolean;
  onTitleFocused?: () => void;
  parent?: FolderDraft | null;
  onOpenFolder?: (folderId: string) => void;
  onAddSubFolder?: () => void;
}) {
  const terms = TERMS[target];
  const children = subFolders(folder);
  const canNest = Boolean(onAddSubFolder) && !parent;
  const [showExtras, setShowExtras] = useState(false);
  const nuvioArtVisible = target === 'nuvio' || hasNuvioFolderArt(folder);

  const update = (patch: Partial<FolderDraft>) => onChange({ ...folder, ...patch });
  const uid = useId();
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focusTitle) return;
    titleRef.current?.focus();
    titleRef.current?.select();
    onTitleFocused?.();
  }, [focusTitle, onTitleFocused]);

  const sourceSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const sourceDndId = (index: number) => `source-${index}`;

  const moveSource = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= folder.sources.length) return;
    update({ sources: arrayMove(folder.sources, index, to) });
  };

  const handleSourceDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = folder.sources.findIndex((_, index) => sourceDndId(index) === active.id);
    const to = folder.sources.findIndex((_, index) => sourceDndId(index) === over.id);
    if (from < 0 || to < 0) return;
    update({ sources: arrayMove(folder.sources, from, to) });
  };

  return (
    <div className="@container space-y-5 rounded-xl border border-white/[0.06] bg-card/80 p-4">
      {parent && onOpenFolder && (
        <button
          type="button"
          onClick={() => onOpenFolder(parent.id)}
          className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" /> Inside {parent.title || terms.child}
        </button>
      )}
      <div className="flex items-center gap-2">
        <Label htmlFor={`${uid}-title`} className="sr-only">{terms.childTitle}</Label>
        <Input
          id={`${uid}-title`}
          ref={titleRef}
          value={folder.title}
          onChange={event => update({ title: event.target.value })}
          placeholder={terms.childTitle}
          className="h-9 min-w-0 flex-1"
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          onClick={onRemove}
          aria-label={`Delete ${folder.title || terms.child.toLowerCase()}`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid gap-4 @2xl:grid-cols-2">
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <Label id={`${uid}-shape`} className="text-sm font-medium">{terms.shape}</Label>
          </div>
          <div role="group" aria-labelledby={`${uid}-shape`} className="flex gap-1 rounded-xl bg-white/[0.03] p-1">
            {SHAPE_ORDER.map(shape => {
              const active = folder.shape === shape;
              return (
                <button
                  key={shape}
                  type="button"
                  onClick={() => update({ shape })}
                  className={`flex h-9 min-w-0 flex-1 items-center justify-center gap-2 rounded-md px-3 text-sm transition-colors ${
                    active ? 'bg-primary/15 text-foreground ring-1 ring-primary/50' : 'text-muted-foreground hover:bg-accent/50'
                  }`}
                >
                  <span
                    className={`shrink-0 rounded-[2px] border ${SHAPE_PREVIEW[shape]} ${
                      active ? 'border-primary bg-primary/40' : 'border-muted-foreground/50'
                    }`}
                  />
                  {SHAPE_LABELS[shape]}
                </button>
              );
            })}
          </div>
        </div>

        <ImageUrlField
          label={terms.cover}
          value={folder.coverImageUrl || ''}
          aspect={ASPECT_BY_TILE[folder.shape]}
          hint="preview follows the tile shape above"
          onChange={next => update({ coverImageUrl: next })}
        />
        {target === 'jellyfin' && (
          <>
            <ImageUrlField
              label="Hero backdrop URL"
              value={folder.heroBackdropUrl || ''}
              aspect="wide"
              onChange={next => update({ heroBackdropUrl: next })}
            />
            <ImageUrlField
              label="Title logo URL"
              value={folder.titleLogoUrl || ''}
              aspect="logo"
              onChange={next => update({ titleLogoUrl: next })}
            />
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id={`${uid}-hide-title`}
          checked={Boolean(folder.hideTitle)}
          onCheckedChange={value => update({ hideTitle: value })}
        />
        <Label htmlFor={`${uid}-hide-title`} className="text-sm font-medium">
          Hide title on the {terms.child.toLowerCase()}
        </Label>
      </div>

      {(canNest || children.length > 0) && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Label className="text-sm font-medium">Folders inside</Label>
              <ScopeChip scope="jellyfin" />
            </div>
            {canNest && (
              <Button variant="outline" size="sm" className="h-8" onClick={onAddSubFolder}>
                <FolderPlus className="mr-1 h-3.5 w-3.5" /> Add folder inside
              </Button>
            )}
          </div>
          {children.length > 0 && (
            <div className="grid gap-1.5 @2xl:grid-cols-2">
              {children.map(child => (
                <button
                  key={child.id}
                  type="button"
                  onClick={() => onOpenFolder?.(child.id)}
                  className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left text-sm transition-colors hover:bg-white/[0.05]"
                >
                  <span className="truncate">{child.title || 'Untitled folder'}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {folderSources(child).length} catalog{folderSources(child).length === 1 ? '' : 's'}
                  </span>
                </button>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Jellyfin clients open these as folders within this one. Nuvio has no nested folders, so there the catalogs inside them are exported as this folder's own.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="text-sm font-medium">{terms.sources}</Label>
          <div className="flex flex-wrap items-center gap-1.5">
            {tagOptions.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8">
                    <Tags className="mr-1 h-3.5 w-3.5" /> Add by tag
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {tagOptions.map(tag => (
                    <DropdownMenuItem key={tag.name} onClick={() => onAddByTag(tag.name)}>
                      <span className={`mr-2 h-2.5 w-2.5 shrink-0 rounded-full ${getTagColor(tag.color).swatch}`} />
                      <span className="flex-1 truncate">{tag.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{tag.count}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button variant="outline" size="sm" className="h-8" onClick={onAddSource}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Add catalog
            </Button>
          </div>
        </div>
        {folder.sources.length === 0 && children.length === 0 && (
          <button
            type="button"
            onClick={onAddSource}
            className="w-full rounded-xl border border-dashed border-white/[0.08] px-2 py-3 text-center text-xs text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground active:bg-white/[0.06]"
          >
            No catalogs yet. The tile still exports, with its artwork, and comes up empty.
            <span className="mt-0.5 block font-medium">Add one</span>
          </button>
        )}
        <DndContext sensors={sourceSensors} collisionDetection={closestCenter} onDragEnd={handleSourceDragEnd}>
          <SortableContext
            items={folder.sources.map((_, index) => sourceDndId(index))}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-2">
              {folder.sources.map((source, index) => (
                <SortableSourceRow
                  key={`${catalogKey(source)}-${index}`}
                  id={sourceDndId(index)}
                  label={source.name || source.catalogId}
                  canMoveUp={index > 0}
                  canMoveDown={index < folder.sources.length - 1}
                  onMove={delta => moveSource(index, delta)}
                  source={source}
                  catalogs={catalogs}
                  pendingKeys={pendingKeys}
                  onChange={next => update({ sources: folder.sources.map((s, i) => (i === index ? next : s)) })}
                  onRemove={() => {
                    const apply = (current: FolderDraft): FolderDraft => ({
                      ...current,
                      sources: current.sources.filter((_, i) => i !== index),
                    });
                    const undo = (current: FolderDraft): FolderDraft => ({
                      ...current,
                      sources: [...current.sources.slice(0, index), source, ...current.sources.slice(index)],
                    });
                    const label = `Removed ${source.name || source.catalogId}`;
                    if (onUndoableChange) onUndoableChange(label, apply, undo);
                    else onChange(apply(folder));
                  }}
                  onReplace={() => onReplaceSource(index)}
                  onRename={
                    onRenameCatalog
                      ? name => {
                          onRenameCatalog(source, name);
                          update({
                            sources: folder.sources.map((s, i) => (i === index ? { ...s, name } : s)),
                          });
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        {folder.sources.length > 1 && (
          <div className="space-y-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Label id={`${uid}-merge`} className="text-sm font-medium">Combine these catalogs</Label>
              <ScopeChip scope="jellyfin" />
            </div>
            <MergeModePicker
              value={mergeModeOf(folder.mergeMode, FOLDER_MERGE_MODE)}
              onChange={mergeMode => update({ mergeMode })}
              labelledBy={`${uid}-merge`}
              className="flex flex-col gap-2 @md:flex-row"
            />
            <div className="flex items-center gap-2">
              <Switch
                id={`${uid}-randomize`}
                checked={Boolean(folder.randomizePerPage)}
                onCheckedChange={value => update({ randomizePerPage: value })}
              />
              <Label htmlFor={`${uid}-randomize`} className="text-sm font-medium">Randomize order</Label>
            </div>
            <p className="text-xs text-muted-foreground">
              A title in two catalogs shows once. Nuvio and Fusion get the catalogs as a list and combine them their own way.
            </p>
          </div>
        )}
      </div>

      {nuvioArtVisible && (
        <button
          type="button"
          onClick={() => setShowExtras(!showExtras)}
          className="flex items-center gap-1.5 text-xs text-cyan-400 underline-offset-2 hover:underline"
        >
          <Tv className="h-3.5 w-3.5" />
          {showExtras ? 'Hide' : 'Show'} Nuvio artwork
          {target === 'jellyfin' && <ScopeChip scope="nuvio" />}
        </button>
      )}
      {nuvioArtVisible && showExtras && (
        <div className="grid gap-4 rounded-xl border border-cyan-400/20 bg-cyan-500/10 p-4 @2xl:grid-cols-2 @4xl:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-emoji`} className="text-sm font-medium">Cover emoji</Label>
            <Input
              id={`${uid}-emoji`}
              value={folder.coverEmoji || ''}
              onChange={event => update({ coverEmoji: event.target.value })}
              className="h-9"
            />
          </div>
          <ImageUrlField
            label="Focus GIF URL"
            value={folder.focusGifUrl || ''}
            aspect={ASPECT_BY_TILE[folder.shape]}
            onChange={next => update({ focusGifUrl: next })}
          />
          {target === 'nuvio' && (
            <ImageUrlField
              label="Hero backdrop URL"
              value={folder.heroBackdropUrl || ''}
              aspect="wide"
              onChange={next => update({ heroBackdropUrl: next })}
            />
          )}
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-hero-video`} className="text-sm font-medium">Hero video URL</Label>
            <Input
              id={`${uid}-hero-video`}
              value={folder.heroVideoUrl || ''}
              onChange={event => update({ heroVideoUrl: event.target.value })}
              placeholder="https://..."
              className="h-9"
            />
          </div>
          {target === 'nuvio' && (
            <ImageUrlField
              label="Title logo URL"
              value={folder.titleLogoUrl || ''}
              aspect="logo"
              onChange={next => update({ titleLogoUrl: next })}
            />
          )}
          <div className="flex items-center gap-2 pt-6">
            <Switch
              id={`${uid}-focus-gif`}
              checked={folder.focusGifEnabled !== false}
              onCheckedChange={value => update({ focusGifEnabled: value })}
            />
            <Label htmlFor={`${uid}-focus-gif`} className="text-sm font-medium">Play focus GIF</Label>
          </div>
        </div>
      )}
    </div>
  );
}
