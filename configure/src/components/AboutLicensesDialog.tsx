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

interface DataSource {
  name: string;
  logo?: string;
  text: string;
  url: string;
  linkLabel: string;
  license?: { label: string; url: string };
}

// The attribution each provider's terms ask an app to show its users (see docs/provider-terms.md).
const DATA_SOURCES: DataSource[] = [
  {
    name: 'TMDB',
    logo: '/tmdb_icon.png',
    text: 'This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.',
    url: 'https://www.themoviedb.org',
    linkLabel: 'themoviedb.org',
  },
  {
    name: 'TheTVDB',
    logo: '/tvdb_icon.png',
    text: 'Metadata provided by TheTVDB. Please consider adding missing information or subscribing.',
    url: 'https://thetvdb.com',
    linkLabel: 'thetvdb.com',
  },
  {
    name: 'Trakt',
    logo: '/trakt_icon.png',
    text: 'This product uses the Trakt API but is not endorsed or certified by Trakt.',
    url: 'https://trakt.tv',
    linkLabel: 'trakt.tv',
  },
  {
    name: 'Simkl',
    text: 'Watch tracking, lists and catalogs from Simkl.',
    url: 'https://simkl.com',
    linkLabel: 'simkl.com',
  },
  {
    name: 'TVmaze',
    text: 'Schedules and episode data from TVmaze.',
    url: 'https://www.tvmaze.com',
    linkLabel: 'tvmaze.com',
    license: { label: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
  },
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
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
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

          <section className="space-y-3">
            <h3 className="font-medium">Data sources</h3>
            <ul className="space-y-3">
              {DATA_SOURCES.map((source) => (
                <li key={source.name} className="flex items-start gap-3">
                  {source.logo ? (
                    <img src={source.logo} alt={source.name} className="h-6 w-6 object-contain shrink-0 mt-0.5" />
                  ) : (
                    <span className="h-6 w-6 shrink-0" aria-hidden="true" />
                  )}
                  <p className="text-muted-foreground">
                    {source.text}{' '}
                    <a href={source.url} target="_blank" rel="noopener noreferrer" className="underline whitespace-nowrap">
                      {source.linkLabel}
                    </a>
                    {source.license ? (
                      <>
                        {' · '}
                        <a href={source.license.url} target="_blank" rel="noopener noreferrer" className="underline">
                          {source.license.label}
                        </a>
                      </>
                    ) : null}
                  </p>
                </li>
              ))}
            </ul>
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
