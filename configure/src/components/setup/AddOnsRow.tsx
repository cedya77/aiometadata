// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { LucideIcon } from 'lucide-react';
import { Check, Link2, Tv2 } from 'lucide-react';
import { cn } from '@/lib/utils';

function AddOnCard({
  Icon,
  label,
  hint,
  count,
  disabled,
  disabledHint,
  onClick,
}: {
  Icon: LucideIcon;
  label: string;
  hint: string;
  count?: number;
  disabled?: boolean;
  disabledHint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? disabledHint : undefined}
      className={cn(
        'flex items-start gap-3 rounded-xl border p-4 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        disabled
          ? 'cursor-not-allowed border-white/[0.05] bg-white/[0.01] opacity-60'
          : 'border-white/[0.08] bg-white/[0.02] hover:border-white/20',
        !!count && 'border-primary/50 bg-primary/[0.06]'
      )}
    >
      <Icon
        className={cn('mt-0.5 h-4 w-4 shrink-0', count ? 'text-primary' : 'text-muted-foreground')}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-medium">
          {label}
          {!!count && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary px-1.5 py-0.5 text-[11px] text-primary-foreground">
              <Check className="h-2.5 w-2.5" aria-hidden="true" />
              {count}
            </span>
          )}
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
          {disabled ? (disabledHint ?? hint) : hint}
        </span>
      </span>
    </button>
  );
}

export function AddOnsRow({
  streamingCount,
  onOpenStreaming,
  onOpenImport,
}: {
  streamingCount: number;
  onOpenStreaming: () => void;
  onOpenImport: () => void;
}) {
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-medium tracking-tight">Add more, in any order</h2>
        <p className="text-sm text-muted-foreground">
          All optional. Skip the lot and you still get a working setup.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <AddOnCard
          Icon={Tv2}
          label="Streaming rows"
          hint="A movies row and a series row for each service you subscribe to."
          count={streamingCount}
          onClick={onOpenStreaming}
        />
        <AddOnCard
          Icon={Link2}
          label="Import a setup"
          hint="Paste a link someone shared and start from their configuration."
          onClick={onOpenImport}
        />
      </div>
    </section>
  );
}
