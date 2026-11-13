// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useMemo, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Callout } from '@/components/settings/Callout';
import { useConfig } from '@/contexts/ConfigContext';
import { exportConfigFile } from '@/lib/exportConfigFile';
import type { CatalogConfig } from '@/contexts/config';

const SOURCE_LABELS: Record<string, string> = {
  tmdb: 'TMDB',
  tvdb: 'TVDB',
  mal: 'MyAnimeList',
  tvmaze: 'TVmaze',
  mdblist: 'MDBList',
  streaming: 'Streaming services',
  trakt: 'Trakt',
  anilist: 'AniList',
  simkl: 'Simkl',
  custom: 'Custom',
};

export function ApplyPreviewDialog({
  open,
  onOpenChange,
  catalogs,
  replacingCount,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalogs: CatalogConfig[];
  replacingCount: number;
  busy?: boolean;
  onConfirm: (disabledKeys: Set<string>) => void;
}) {
  const { config, addonVersion } = useConfig();
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  const groups = useMemo(() => {
    const bySource = new Map<string, CatalogConfig[]>();
    for (const catalog of catalogs) {
      if (!catalog.enabled) continue;
      const list = bySource.get(catalog.source) ?? [];
      list.push(catalog);
      bySource.set(catalog.source, list);
    }
    return [...bySource.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [catalogs]);

  const enabledTotal = catalogs.filter(c => c.enabled).length;
  const keptTotal = enabledTotal - disabled.size;

  const keyFor = (catalog: CatalogConfig) => `${catalog.id}:${catalog.type}`;

  const toggle = (catalog: CatalogConfig) => {
    const key = keyFor(catalog);
    setDisabled(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const exportBackup = () => {
    setExporting(true);
    try {
      exportConfigFile(config, { addonVersion, excludeApiKeys: false });
      toast.success('Backup downloaded', {
        description: 'Your current configuration, API keys included.',
      });
    } catch (error) {
      console.error('Failed to export configuration backup:', error);
      toast.error('Could not export the backup', { description: 'Nothing was applied.' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Here is what you will get</DialogTitle>
          <DialogDescription>
            {keptTotal} catalogs across {groups.length} sources. Switch off anything you do not want.
          </DialogDescription>
        </DialogHeader>

        {replacingCount > 0 && (
          <Callout variant="warn">
            This replaces your current lineup of {replacingCount} catalogs. Download a backup first
            if you want to be able to go back.
            <Button
              variant="outline"
              size="sm"
              className="mt-2 flex"
              disabled={exporting}
              onClick={exportBackup}
            >
              {exporting
                ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                : <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
              Download backup
            </Button>
          </Callout>
        )}

        <div className="space-y-5">
          {groups.map(([source, items]) => (
            <div key={source} className="space-y-2">
              <div className="flex items-baseline gap-2">
                <h3 className="text-sm font-medium">{SOURCE_LABELS[source] ?? source}</h3>
                <span className="text-xs text-muted-foreground">{items.length}</span>
              </div>
              <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                {items.map(catalog => {
                  const key = keyFor(catalog);
                  const on = !disabled.has(key);
                  return (
                    <label
                      key={key}
                      className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-white/[0.03]"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {catalog.name}
                        <span className="ml-1.5 text-xs text-muted-foreground">{catalog.type}</span>
                      </span>
                      <Switch checked={on} onCheckedChange={() => toggle(catalog)} />
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Back</Button>
          <Button disabled={busy || keptTotal === 0} onClick={() => onConfirm(disabled)}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Apply {keptTotal} catalogs
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
