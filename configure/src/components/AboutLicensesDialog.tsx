// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ExternalLink } from 'lucide-react';

interface AboutLicensesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version: string;
}

const LICENSE_LINKS: Array<{ file: string; label: string }> = [
  { file: 'LICENSING.md', label: 'Which license covers what' },
  { file: 'LICENSE', label: 'GNU AGPL-3.0 (the core)' },
  { file: 'LICENSE-FSL.md', label: 'Functional Source License 1.1 (v4 feature modules)' },
  { file: 'NOTICE', label: 'Notices for earlier and bundled work' },
  { file: 'THIRD_PARTY_NOTICES.txt', label: 'Third-party package licenses' },
  { file: 'TRADEMARKS.md', label: 'Name and logo' },
];

/** What this instance is, where its source is, and the notices its licenses and providers require. */
export function AboutLicensesDialog({ open, onOpenChange, version }: AboutLicensesDialogProps) {
  const [sourceCodeUrl, setSourceCodeUrl] = useState('');

  useEffect(() => {
    if (!open || sourceCodeUrl) return;
    fetch('/api/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (typeof data?.sourceCodeUrl === 'string') setSourceCodeUrl(data.sourceCodeUrl);
      })
      .catch(() => undefined);
  }, [open, sourceCodeUrl]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>About AIOMetadata</DialogTitle>
          <DialogDescription>Version {version.trim() || 'unknown'}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 text-sm">
          <section className="space-y-2">
            <h3 className="font-medium">Source code</h3>
            <p className="text-muted-foreground">
              AIOMetadata is source-available. Its core is under the GNU AGPL-3.0, and the v4 feature modules
              are under the Functional Source License, each release becoming Apache-2.0 two years after it ships.
            </p>
            {sourceCodeUrl ? (
              <a
                href={sourceCodeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 underline break-all"
              >
                Source code of this instance <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            ) : null}
          </section>

          <section className="space-y-2">
            <h3 className="font-medium">Licenses and notices</h3>
            <ul className="space-y-1">
              {LICENSE_LINKS.map(({ file, label }) => (
                <li key={file}>
                  <a href={`/licenses/${file}`} target="_blank" rel="noopener noreferrer" className="underline">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-2">
            <h3 className="font-medium">Data</h3>
            <div className="flex items-start gap-3">
              <img src="/tmdb_icon.png" alt="TMDB" className="h-8 w-auto shrink-0" />
              <p className="text-muted-foreground">
                This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.
              </p>
            </div>
            <p className="text-muted-foreground">
              Other metadata, images and ratings come from the providers this instance is set up with, under their
              own terms.
            </p>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
