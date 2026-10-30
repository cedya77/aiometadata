import { useEffect, useId, useState } from 'react';
import { Rows3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { CatalogConfig } from '@/contexts/config';
import type { CatalogRowOptions } from '@shared/types';

function cleaned(options: CatalogRowOptions): CatalogRowOptions | undefined {
  const title = options.title?.trim() ?? '';
  const next: CatalogRowOptions = {
    ...(title ? { title } : {}),
    ...(options.hideTitle ? { hideTitle: true } : {}),
    ...(options.numbered ? { numbered: true } : {}),
  };
  return Object.keys(next).length ? next : undefined;
}

export function rowSummary(row: CatalogRowOptions | undefined): string | null {
  if (!row) return null;
  const parts = [
    row.title ? `Row title: ${row.title}` : null,
    row.numbered ? 'Numbered' : null,
    row.hideTitle ? 'Title hidden' : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

export function RowOptionsDialog({
  catalog,
  open,
  onOpenChange,
  onSave,
}: {
  catalog: CatalogConfig;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (row: CatalogRowOptions | undefined) => void;
}) {
  const uid = useId();
  const [draft, setDraft] = useState<CatalogRowOptions>({});

  useEffect(() => {
    if (open) setDraft({ ...(catalog.row ?? {}) });
  }, [open, catalog.row]);

  const save = () => {
    onSave(cleaned(draft));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rows3 className="h-5 w-5 text-purple-400" />
            Row options
          </DialogTitle>
          <DialogDescription>
            How {catalog.name} draws as a home row on Jellyfin clients. The catalog keeps its name everywhere else.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-1">
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-title`}>Row title</Label>
            <Input
              id={`${uid}-title`}
              value={draft.title ?? ''}
              placeholder={catalog.name}
              onChange={event => setDraft(prev => ({ ...prev, title: event.target.value }))}
              onKeyDown={event => {
                if (event.key === 'Enter') save();
              }}
            />
            <p className="text-xs text-muted-foreground">Leave blank to use the catalog name.</p>
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-white/[0.06] pt-4">
            <div className="space-y-0.5">
              <Label htmlFor={`${uid}-hide`}>Hide title</Label>
              <p className="text-xs text-muted-foreground">The row shows its cards with no heading above them.</p>
            </div>
            <Switch
              id={`${uid}-hide`}
              checked={Boolean(draft.hideTitle)}
              onCheckedChange={value => setDraft(prev => ({ ...prev, hideTitle: value }))}
            />
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-white/[0.06] pt-4">
            <div className="space-y-0.5">
              <Label htmlFor={`${uid}-numbered`}>Numbered</Label>
              <p className="text-xs text-muted-foreground">Cards show their place, like a top ten.</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="flex gap-1" aria-hidden="true">
                {[1, 2, 3].map(n => (
                  <span
                    key={n}
                    className={`flex h-8 w-6 items-end rounded bg-white/[0.06] px-1 text-sm font-bold transition-opacity ${draft.numbered ? 'opacity-100' : 'opacity-30'}`}
                  >
                    {n}
                  </span>
                ))}
              </span>
              <Switch
                id={`${uid}-numbered`}
                checked={Boolean(draft.numbered)}
                onCheckedChange={value => setDraft(prev => ({ ...prev, numbered: value }))}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
