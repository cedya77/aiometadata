// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { parseRoute } from '@/lib/settingsRoute';

export function CollapsibleSettingCard({
  title,
  description,
  inUse,
  anchorIds,
  children,
}: {
  title: string;
  description?: ReactNode;
  inUse?: boolean;
  anchorIds?: string[];
  children: ReactNode;
}) {
  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  const targeted = (() => {
    if (!anchorIds?.length || typeof window === 'undefined') return false;
    const { anchor } = parseRoute(window.location.hash);
    return anchor !== null && anchorIds.includes(anchor);
  })();
  const open = Boolean(userOverride ?? (targeted || inUse));
  const contentId = `collapsible-${title.replace(/\W+/g, '-').toLowerCase()}`;

  return (
    <Card>
      <button
        type="button"
        onClick={() => setUserOverride(!open)}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex w-full items-center justify-between gap-3 p-6 text-left"
      >
        <div className="min-w-0">
          <span className="block font-semibold leading-none tracking-tight">{title}</span>
          {description ? (
            <p className="text-sm text-muted-foreground mt-1.5">{description}</p>
          ) : null}
        </div>
        <ChevronDown
          className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <CardContent id={contentId} className="pt-0">
          {children}
        </CardContent>
      ) : null}
    </Card>
  );
}
