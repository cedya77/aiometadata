// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { ReactNode } from 'react';
import { AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

export type CalloutVariant = 'info' | 'warn' | 'danger';

const VARIANTS: Record<CalloutVariant, { wrapper: string; icon: string; Icon: typeof Info }> = {
  info: {
    wrapper: 'bg-sky-500/10 border-sky-500/25 text-sky-200',
    icon: 'text-sky-400',
    Icon: Info,
  },
  warn: {
    wrapper: 'bg-amber-500/10 border-amber-500/25 text-amber-200',
    icon: 'text-amber-400',
    Icon: AlertTriangle,
  },
  danger: {
    wrapper: 'bg-red-500/10 border-red-500/25 text-red-200',
    icon: 'text-red-400',
    Icon: AlertCircle,
  },
};

/**
 * The one note/warning block. Replaces four ad-hoc treatments across the
 * settings pages. The app shell is hard-coded dark (App.tsx:21), so these are
 * single-palette by design — do not add light-mode pairs.
 */
export function Callout({
  variant = 'info',
  children,
  className,
}: {
  variant?: CalloutVariant;
  children: ReactNode;
  className?: string;
}) {
  const { wrapper, icon, Icon } = VARIANTS[variant];
  return (
    <div className={cn('flex items-start gap-2 rounded-lg border p-3 text-sm', wrapper, className)}>
      <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', icon)} aria-hidden="true" />
      <div className="min-w-0 [&_strong]:font-semibold">{children}</div>
    </div>
  );
}
