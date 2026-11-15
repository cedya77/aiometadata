// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useEffect, useId, useRef, useState } from 'react';
import { FolderPlus, Replace, Tv } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { TagDef } from '@/contexts/config';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { type ManifestCatalog } from '@/lib/collectionBuilder/manifestSources';
import { TERMS, type Target } from '@/lib/collectionBuilder/terms';
import { findFolder, hasNuvioCollectionSettings, mapFolder, parentFolderOf, type CollectionDraft, type FolderDraft, type SourceDraft } from '@shared/types';
import { isNativeSource } from '@shared/catalogReconstruction';

import { FolderCard } from './FolderCard';
import { UserTagsField } from './UserTagsField';
import { ImageUrlField } from './ImageUrlField';
import { ScopeChip } from './ScopeChip';
import { type TagOption } from './shared';

export function CollectionEditor({
  entry,
  catalogs,
  pendingKeys,
  target,
  onChange,
  onUndoableChange,
  onAddSource,
  onReplaceSource,
  onRenameCatalog,
  tagOptions,
  userTags = [],
  onAddByTag,
  nativeCount,
  onConvertNative,
  selectedFolderId,
  onAddFolder,
  onRemoveFolder,
  onAddSubFolder,
  onSelectFolder,
  focusFolderTitle,
  onFolderTitleFocused,
  focusTitle,
  onTitleFocused,
}: {
  entry: CollectionDraft;
  catalogs: ManifestCatalog[];
  pendingKeys?: Set<string>;
  target: Target;
  onChange: (next: CollectionDraft) => void;
  /** Same as onChange, but the caller offers an Undo that replays the inverse. */
  onUndoableChange?: (
    label: string,
    apply: (entry: CollectionDraft) => CollectionDraft,
    undo: (entry: CollectionDraft) => CollectionDraft
  ) => void;
  onAddSource: (folderId: string) => void;
  onReplaceSource: (folderId: string, index: number) => void;
  /** Renames the catalog itself, everywhere it appears. */
  onRenameCatalog?: (source: SourceDraft, name: string) => void;
  tagOptions: TagOption[];
  userTags?: TagDef[];
  onAddByTag: (folderId: string, tag: string) => void;
  /** Sources in this collection the app resolves itself and this addon could take over. */
  nativeCount: number;
  onConvertNative: (folderId?: string) => void;
  /** Owned by the dialog, because the rail tree selects folders too. */
  selectedFolderId: string | null;
  onAddFolder: () => void;
  onRemoveFolder: () => void;
  onAddSubFolder: (parentId: string) => void;
  onSelectFolder: (folderId: string) => void;
  focusFolderTitle?: boolean;
  onFolderTitleFocused?: () => void;
  focusTitle?: boolean;
  onTitleFocused?: () => void;
}) {
  const terms = TERMS[target];
  const [showNuvioBox, setShowNuvioBox] = useState(target === 'nuvio');
  const nuvioBoxVisible = target === 'nuvio' || hasNuvioCollectionSettings(entry);
  const uid = useId();
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focusTitle) return;
    titleRef.current?.focus();
    titleRef.current?.select();
    onTitleFocused?.();
  }, [focusTitle, onTitleFocused]);

  useEffect(() => {
    setShowNuvioBox(target === 'nuvio');
  }, [target]);

  const update = (patch: Partial<CollectionDraft>) => onChange({ ...entry, ...patch });

  const activeFolder = selectedFolderId ? findFolder(entry.folders, selectedFolderId) ?? null : null;
  const parentFolder = activeFolder ? parentFolderOf(entry.folders, activeFolder.id) ?? null : null;
  const folderNativeCount = activeFolder?.sources.filter(isNativeSource).length ?? 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 @2xl:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-title`} className="text-sm font-medium">{terms.entryTitle}</Label>
          <Input
            id={`${uid}-title`}
            ref={titleRef}
            value={entry.title}
            onChange={event => update({ title: event.target.value })}
            className="h-9"
          />
        </div>
        <div className="flex items-end gap-2 pb-2">
          <Switch
            id={`${uid}-hide-title`}
            checked={Boolean(entry.hideTitle)}
            onCheckedChange={value => update({ hideTitle: value })}
          />
          <Label htmlFor={`${uid}-hide-title`} className="text-sm font-medium">Hide title</Label>
          <ScopeChip scope="jellyfin" />
        </div>
      </div>

      <ImageUrlField
        label="Backdrop image URL"
        value={entry.backdropImageUrl || ''}
        aspect="wide"
        onChange={next => update({ backdropImageUrl: next })}
      />

      <UserTagsField tags={userTags} value={entry.tags} onChange={next => update({ tags: next })} />

      {nuvioBoxVisible && (
      <div className="space-y-3 rounded-xl border border-cyan-400/20 bg-cyan-500/10 p-3">
        <button
          type="button"
          onClick={() => setShowNuvioBox(!showNuvioBox)}
          className="flex w-full items-center gap-2 text-left"
        >
          <Tv className="h-4 w-4 shrink-0 text-cyan-400" />
          <Label className="cursor-pointer text-sm font-medium text-cyan-300">Nuvio presentation</Label>
          <span className="text-xs text-muted-foreground">
            {target === 'jellyfin' ? 'Set here, unused by Jellyfin' : 'Jellyfin ignores these'}
          </span>
          <span className="flex-1" />
          <span className="text-xs text-muted-foreground">{showNuvioBox ? 'Hide' : 'Show'}</span>
        </button>

        {showNuvioBox && (
        <>
        <div className="grid gap-4 @2xl:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-view-mode`} className="text-sm font-medium">Folder view mode</Label>
            <Select
              value={entry.viewMode || 'TABBED_GRID'}
              onValueChange={(value: CollectionDraft['viewMode']) => update({ viewMode: value })}
            >
              <SelectTrigger id={`${uid}-view-mode`} className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="TABBED_GRID">Tabbed grid</SelectItem>
                <SelectItem value="ROWS">Rows</SelectItem>
                <SelectItem value="FOLLOW_LAYOUT">Follow layout</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <div className="flex items-center gap-2">
            <Switch
              id={`${uid}-pin`}
              checked={Boolean(entry.pinToTop)}
              onCheckedChange={value => update({ pinToTop: value })}
            />
            <Label htmlFor={`${uid}-pin`} className="text-sm font-medium">Pin to top</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id={`${uid}-glow`}
              checked={entry.focusGlowEnabled !== false}
              onCheckedChange={value => update({ focusGlowEnabled: value })}
            />
            <Label htmlFor={`${uid}-glow`} className="text-sm font-medium">Focus glow</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id={`${uid}-all-tab`}
              checked={entry.showAllTab !== false}
              onCheckedChange={value => update({ showAllTab: value })}
            />
            <Label htmlFor={`${uid}-all-tab`} className="text-sm font-medium">Show &ldquo;All&rdquo; tab</Label>
          </div>
        </div>
        </>
        )}
      </div>
      )}

      {nativeCount > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 @2xl:flex-row @2xl:items-center @2xl:justify-between">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{nativeCount}</span> source
            {nativeCount === 1 ? '' : 's'} in this {terms.collection.toLowerCase()}{' '}
            {nativeCount === 1 ? 'is' : 'are'} fetched by the app straight from TMDB or Trakt. They cost this
            addon nothing. Routing them through it adds your artwork, ratings and filters, and a catalog to your
            setup for each.
          </p>
          <div className="flex shrink-0 flex-wrap gap-2">
            {folderNativeCount > 0 && activeFolder && (
              <Button variant="outline" size="sm" onClick={() => onConvertNative(activeFolder.id)}>
                <Replace className="mr-1.5 h-4 w-4" /> Route this {terms.child.toLowerCase()} ({folderNativeCount})
              </Button>
            )}
            <Button
              variant={folderNativeCount > 0 && activeFolder ? 'ghost' : 'outline'}
              size="sm"
              onClick={() => onConvertNative()}
            >
              Route all {nativeCount}
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-white/[0.06] pt-3">
        <Label className="text-sm font-medium">{terms.children}</Label>
        <Button variant="outline" size="sm" onClick={onAddFolder}>
          <FolderPlus className="mr-1.5 h-4 w-4" /> {terms.addChild}
        </Button>
      </div>

      {entry.folders.length === 0 ? (
        <button
          type="button"
          onClick={onAddFolder}
          className="w-full rounded-xl border border-dashed border-white/[0.08] px-3 py-8 text-center text-sm text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground active:bg-white/[0.06]"
        >
          Nothing here yet. Add a folder, then point it at one or more of your catalogs.
        </button>
      ) : activeFolder ? (
        <FolderCard
          key={activeFolder.id}
          folder={activeFolder}
          catalogs={catalogs}
          pendingKeys={pendingKeys}
          target={target}
          onChange={next => update({
            folders: mapFolder(entry.folders, activeFolder.id, () => next),
          })}
          onUndoableChange={onUndoableChange && ((label, apply, undo) => {
            const over = (fn: (folder: FolderDraft) => FolderDraft) =>
              (current: CollectionDraft): CollectionDraft => ({
                ...current,
                folders: mapFolder(current.folders, activeFolder.id, fn),
              });
            onUndoableChange(label, over(apply), over(undo));
          })}
          parent={parentFolder}
          onOpenFolder={onSelectFolder}
          onAddSubFolder={() => onAddSubFolder(activeFolder.id)}
          onRemove={onRemoveFolder}
          onAddSource={() => onAddSource(activeFolder.id)}
          onReplaceSource={index => onReplaceSource(activeFolder.id, index)}
          onRenameCatalog={onRenameCatalog}
          tagOptions={tagOptions}
          onAddByTag={tag => onAddByTag(activeFolder.id, tag)}
          focusTitle={focusFolderTitle}
          onTitleFocused={onFolderTitleFocused}
        />
      ) : (
        <p className="rounded-xl border border-dashed border-white/[0.08] px-3 py-8 text-center text-sm text-muted-foreground">
          Pick a {terms.child.toLowerCase()} <span className="@2xl/panes:hidden">in the Entries tab</span><span className="hidden @2xl/panes:inline">on the left</span> to edit it.
        </p>
      )}
    </div>
  );
}
