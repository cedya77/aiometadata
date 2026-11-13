// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useId, useState } from 'react';
import { AlertTriangle, ChevronDown, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AnimeNotice, NoticeLevel } from '@/lib/animeNotices';

const LEVELS: Record<NoticeLevel, { summary: string; icon: string; Icon: typeof Info }> = {
  info: { summary: 'text-sky-200', icon: 'text-sky-400', Icon: Info },
  warn: { summary: 'text-amber-200', icon: 'text-amber-400', Icon: AlertTriangle },
};

export function NoticeDisclosure({
  notices,
  className,
}: {
  notices: AnimeNotice[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();

  if (notices.length === 0) return null;

  const level: NoticeLevel = notices.some((notice) => notice.level === 'warn') ? 'warn' : 'info';
  const { summary, icon, Icon } = LEVELS[level];

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={contentId}
        className={cn('flex w-full items-center gap-2 text-left text-sm', summary)}
      >
        <Icon className={cn('h-4 w-4 shrink-0', icon)} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          {notices.length === 1 ? '1 note' : `${notices.length} notes`} about your current setup
        </span>
        <ChevronDown
          className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <ul id={contentId} className={cn('mt-2 space-y-2 pl-10 list-disc text-sm', summary)}>
          {notices.map((notice) => (
            <li key={notice.id}>{notice.text}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
