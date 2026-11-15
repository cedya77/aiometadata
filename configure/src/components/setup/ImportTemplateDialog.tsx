// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useRef, useState } from 'react';
import { Download, Loader2, Upload } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { useConfig } from '@/contexts/ConfigContext';
import {
  buildTemplateFromConfig,
  downloadTemplate,
  fetchTemplate,
  parseTemplate,
} from '@/lib/setup/templateShare';
import type { ConfigTemplate } from '@/lib/setup/types';

export function ImportTemplateDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (template: ConfigTemplate) => void;
}) {
  const { config } = useConfig();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [exportName, setExportName] = useState(config.addonName || 'My setup');
  const fileInput = useRef<HTMLInputElement>(null);

  const accept = (template: ConfigTemplate) => {
    onImported(template);
    onOpenChange(false);
    toast.success(`Loaded "${template.name}"`, {
      description: 'Review it below, then preview and apply.',
    });
  };

  const importFromUrl = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      accept(await fetchTemplate(url.trim()));
    } catch (error) {
      toast.error('Could not load that setup', {
        description: error instanceof Error ? error.message : 'Unknown error.',
      });
    } finally {
      setBusy(false);
    }
  };

  const importFromFile = async (file: File) => {
    setBusy(true);
    try {
      accept(parseTemplate(await file.text()));
    } catch (error) {
      toast.error('Could not read that file', {
        description: error instanceof Error ? error.message : 'Unknown error.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share a setup</DialogTitle>
          <DialogDescription>
            A setup carries catalogs and provider settings. It never carries your API keys,
            private lists, or anything tied to your accounts.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <p className="text-sm font-medium">Load one</p>
            <div className="flex gap-2">
              <Input
                value={url}
                onChange={event => setUrl(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') void importFromUrl(); }}
                placeholder="https://example.com/setup.json"
                className="h-9"
              />
              <Button size="sm" variant="outline" disabled={!url.trim() || busy} onClick={() => void importFromUrl()}>
                {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                Load
              </Button>
            </div>
            <Button size="sm" variant="ghost" onClick={() => fileInput.current?.click()} disabled={busy}>
              <Upload className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Or pick a file
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={event => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void importFromFile(file);
              }}
            />
          </div>

          <div className="space-y-2 border-t border-white/[0.06] pt-4">
            <p className="text-sm font-medium">Share yours</p>
            <div className="flex gap-2">
              <Input
                value={exportName}
                onChange={event => setExportName(event.target.value)}
                placeholder="Name this setup"
                className="h-9"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!exportName.trim()}
                onClick={() => downloadTemplate(buildTemplateFromConfig(config, exportName.trim()))}
              >
                <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                Download
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Exports what you have configured right now, not what is selected on this page.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
