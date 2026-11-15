// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useEffect, useId, useRef } from 'react';
import { Plus, Rows3 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { TagDef } from '@/contexts/config';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { ManifestCatalog } from '@/lib/collectionBuilder/manifestSources';
import { TERMS, type Target } from '@/lib/collectionBuilder/terms';
import type { ClassicRowDraft, SourceDraft } from '@shared/types';

import { SourceRow } from './SourceRow';
import { UserTagsField } from './UserTagsField';

export function ClassicRowEditor({
  entry,
  catalogs,
  pendingKeys,
  target,
  onChange,
  onAddSource,
  onRenameCatalog,
  userTags = [],
  focusTitle,
  onTitleFocused,
}: {
  entry: ClassicRowDraft;
  catalogs: ManifestCatalog[];
  pendingKeys?: Set<string>;
  target: Target;
  onChange: (next: ClassicRowDraft) => void;
  onAddSource: () => void;
  /** Renames the catalog itself, everywhere it appears. */
  onRenameCatalog?: (source: SourceDraft, name: string) => void;
  userTags?: TagDef[];
  focusTitle?: boolean;
  onTitleFocused?: () => void;
}) {
  const terms = TERMS[target];
  const update = (patch: Partial<ClassicRowDraft>) => onChange({ ...entry, ...patch });
  const uid = useId();
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focusTitle) return;
    titleRef.current?.focus();
    titleRef.current?.select();
    onTitleFocused?.();
  }, [focusTitle, onTitleFocused]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg border border-purple-400/20 bg-purple-500/10 px-3 py-2 text-xs text-purple-300">
        <Rows3 className="h-4 w-4 shrink-0" />
        Rows are for Jellyfin clients only. Nuvio has no equivalent, so this row is left out of the Nuvio export.
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-title`} className="text-sm font-medium">{terms.entryTitle}</Label>
        <Input
          id={`${uid}-title`}
          ref={titleRef}
          value={entry.title}
          placeholder={entry.source?.name || undefined}
          onChange={event => update({ title: event.target.value })}
          className="h-9"
        />
        <p className="text-xs text-muted-foreground">Left blank, the row takes the catalog's name.</p>
      </div>

      <UserTagsField tags={userTags} value={entry.tags} onChange={next => update({ tags: next })} />

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Catalog</Label>
          <Button variant="outline" size="sm" className="h-8" onClick={onAddSource}>
            <Plus className="mr-1 h-3.5 w-3.5" /> {entry.source ? 'Change' : 'Pick catalog'}
          </Button>
        </div>
        {entry.source ? (
          <SourceRow
            source={entry.source}
            catalogs={catalogs}
            pendingKeys={pendingKeys}
            onChange={next => update({ source: next })}
            onRemove={() => update({ source: null })}
            onReplace={onAddSource}
            onRename={
              onRenameCatalog && entry.source
                ? name => {
                    onRenameCatalog(entry.source as SourceDraft, name);
                    update({ source: { ...(entry.source as SourceDraft), name } });
                  }
                : undefined
            }
          />
        ) : (
          <button
            type="button"
            onClick={onAddSource}
            className="w-full rounded-xl border border-dashed border-white/[0.08] px-2 py-3 text-center text-xs text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground active:bg-white/[0.06]"
          >
            No catalog selected. A row without one is left out.
            <span className="mt-0.5 block font-medium">Pick one</span>
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          <Switch
            id={`${uid}-numbered`}
            checked={Boolean(entry.numbered)}
            onCheckedChange={value => update({ numbered: value })}
          />
          <Label htmlFor={`${uid}-numbered`} className="text-sm font-medium">Numbered ranking</Label>
          <span className="text-xs text-muted-foreground">1, 2, 3 … over each card</span>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={`${uid}-row-hide-title`}
            checked={Boolean(entry.hideTitle)}
            onCheckedChange={value => update({ hideTitle: value })}
          />
          <Label htmlFor={`${uid}-row-hide-title`} className="text-sm font-medium">Hide title</Label>
        </div>
      </div>
    </div>
  );
}
