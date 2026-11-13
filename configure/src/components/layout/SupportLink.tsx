// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { Coffee } from 'lucide-react';
import { cn } from '@/lib/utils';

export function SupportLink({ className }: { className?: string }) {
  return (
    <a
      href="https://buymeacoffee.com/cedya"
      target="_blank"
      rel="noopener noreferrer"
      title="Buy me a coffee"
      className={cn(
        'group flex items-center justify-center gap-2 rounded-lg px-3 py-2.5',
        'border border-amber-400/30 bg-amber-400/10 text-sm font-medium text-amber-200',
        'transition-colors hover:border-amber-400/50 hover:bg-amber-400/20 hover:text-amber-100',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className
      )}
    >
      <Coffee className="h-4 w-4 shrink-0 transition-transform group-hover:-rotate-6" />
      <span>Buy me a coffee</span>
    </a>
  );
}
