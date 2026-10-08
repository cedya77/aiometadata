import { useEffect, useId, useRef } from 'react';
import { Plus, Rows3 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { TagDef } from '@/contexts/config';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ManifestCatalog } from '@/lib/collectionBuilder/manifestSources';
import { TERMS, type Target } from '@/lib/collectionBuilder/terms';
import type { ClassicRowDraft, SourceDraft } from '@shared/types';

import { ImageUrlField } from './ImageUrlField';
import { SourceRow } from './SourceRow';
import { ASPECT_BY_SHAPE, SHAPE_LABELS, SHAPE_ORDER, SHAPE_PREVIEW } from './shared';
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
      <div className="flex items-center gap-2 rounded-lg border border-violet-400/20 bg-violet-500/10 px-3 py-2 text-xs text-violet-300">
        <Rows3 className="h-4 w-4 shrink-0" />
        Classic rows are Fusion and Jellyfin Clients only. Nuvio has no equivalent, so this row is left out of the Nuvio export.
      </div>

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
        <ImageUrlField
          label={terms.cover}
          value={entry.backgroundImageURL || ''}
          aspect={entry.aspectRatio === 'wide' ? 'wide' : entry.aspectRatio === 'square' ? 'square' : 'poster'}
          onChange={next => update({ backgroundImageURL: next })}
        />
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
            No catalog selected. Fusion drops rows without one.
            <span className="mt-0.5 block font-medium">Pick one</span>
          </button>
        )}
      </div>

      <div className="grid gap-4 @2xl:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-limit`} className="text-sm font-medium">Items shown</Label>
          <Input
            id={`${uid}-limit`}
            type="number"
            min={1}
            value={entry.limit}
            onChange={event => update({ limit: Math.max(1, parseInt(event.target.value, 10) || 1) })}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-ttl`} className="text-sm font-medium">Cache TTL (seconds)</Label>
          <Input
            id={`${uid}-ttl`}
            type="number"
            min={0}
            value={entry.cacheTTL}
            onChange={event => update({ cacheTTL: Math.max(0, parseInt(event.target.value, 10) || 0) })}
            className="h-9"
          />
        </div>
        <div className="space-y-2 @2xl:col-span-2">
          <Label id={`${uid}-aspect`} className="text-sm font-medium">Aspect ratio</Label>
          <div role="group" aria-labelledby={`${uid}-aspect`} className="flex gap-1 rounded-xl bg-white/[0.03] p-1">
            {SHAPE_ORDER.map(shape => {
              const value = ASPECT_BY_SHAPE[shape];
              const active = entry.aspectRatio === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => update({ aspectRatio: value })}
                  className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors ${
                    active ? 'bg-primary/15 text-foreground ring-1 ring-primary/50' : 'text-muted-foreground hover:bg-accent/50'
                  }`}
                >
                  <span
                    className={`shrink-0 rounded-[2px] border ${SHAPE_PREVIEW[shape]} ${
                      active ? 'border-primary bg-primary/40' : 'border-muted-foreground/50'
                    }`}
                  />
                  <span className="truncate">{SHAPE_LABELS[shape]}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-card-size`} className="text-sm font-medium">Card size</Label>
          <Select
            value={entry.cardStyle}
            onValueChange={(value: ClassicRowDraft['cardStyle']) => update({ cardStyle: value })}
          >
            <SelectTrigger id={`${uid}-card-size`} className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="small">Small</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="large">Large</SelectItem>
            </SelectContent>
          </Select>
        </div>
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
        <div className="flex items-center gap-2">
          <Switch
            id={`${uid}-provider-badges`}
            checked={entry.badges.providers}
            onCheckedChange={value => update({ badges: { ...entry.badges, providers: value } })}
          />
          <Label htmlFor={`${uid}-provider-badges`} className="text-sm font-medium">Provider badges</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={`${uid}-rating-badges`}
            checked={entry.badges.ratings}
            onCheckedChange={value => update({ badges: { ...entry.badges, ratings: value } })}
          />
          <Label htmlFor={`${uid}-rating-badges`} className="text-sm font-medium">Rating badges</Label>
        </div>
      </div>
    </div>
  );
}
