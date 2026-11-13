// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function StickyApplyBar({
  summary,
  blockers,
  busy,
  onApply,
  className,
}: {
  summary: string;
  blockers: string[];
  busy?: boolean;
  onApply: () => void;
  className?: string;
}) {
  const blocked = blockers.length > 0;

  return (
    <div
      className={cn(
        'mt-2 border-t border-white/[0.08] bg-background/85 py-3 backdrop-blur-xl',
        'md:sticky md:bottom-0 md:z-20',
        className
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="truncate text-sm">{summary}</p>
          {blocked && (
            <p className="flex items-center gap-1.5 text-xs text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {blockers.join(' · ')}
            </p>
          )}
        </div>

        <Button onClick={onApply} disabled={blocked || busy} className="w-full shrink-0 sm:w-auto">
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          Preview and apply
        </Button>
      </div>
    </div>
  );
}
