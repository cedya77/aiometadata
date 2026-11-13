// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getTagColor } from '@/lib/tagColors';
import type { TagColorKey } from '@/contexts/config';

interface TagChipBaseProps {
  name: string;
  color?: TagColorKey | string;
  /** Trailing detail carried by the tag itself, such as the limit it installs with. */
  suffix?: ReactNode;
  dimmed?: boolean;
  className?: string;
}

/**
 * A chip is either something you press or something you remove, never both:
 * the remove control is itself a button, which cannot nest inside one.
 */
type TagChipProps = TagChipBaseProps & (
  | { onClick: () => void; pressed?: boolean; onRemove?: undefined }
  | { onClick?: undefined; pressed?: undefined; onRemove?: () => void }
);

export function TagChip({ name, color, suffix, onRemove, onClick, pressed, dimmed, className }: TagChipProps) {
  const c = getTagColor(color);
  const body = (
    <>
      {name}
      {suffix != null && (
        <span className="rounded-full bg-black/20 px-1 text-[0.65rem] leading-4">{suffix}</span>
      )}
    </>
  );
  const shape = cn(
    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors',
    c.chip,
    dimmed && 'opacity-40 grayscale',
    className,
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={pressed}
        className={cn(
          shape,
          'cursor-pointer hover:opacity-90',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        )}
      >
        {body}
      </button>
    );
  }

  return (
    <span className={shape}>
      {body}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="ml-0.5 -mr-1 rounded-full p-0.5 hover:bg-black/25"
          aria-label={`Remove ${name} tag`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
