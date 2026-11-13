// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronDown, Info } from 'lucide-react';

import type { IssueRow } from '@/lib/collectionBuilder/issueCenter';

/**
 * Everything the design has to say about itself, in one line. It renders even
 * with nothing to report, so the header does not change height as problems
 * come and go and push the panes around underneath it.
 */
export function StatusBar({
  rows,
  trailing,
  onGoTo,
}: {
  rows: IssueRow[];
  trailing?: ReactNode;
  onGoTo: (entryId: string | null, folderId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const blocking = rows.filter(row => row.severity === 'blocking').length;
  const warnings = rows.filter(row => row.severity === 'warning').length;

  const tone = blocking > 0 ? 'text-red-400' : warnings > 0 ? 'text-amber-400' : 'text-muted-foreground';
  const summary = blocking > 0
    ? `${blocking} to fix before saving`
    : warnings > 0
      ? `${warnings} worth checking`
      : 'No issues';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          disabled={rows.length === 0}
          className={`flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-white/[0.04] active:bg-white/[0.06] disabled:pointer-events-none ${tone}`}
          aria-expanded={open}
        >
          {blocking > 0 || warnings > 0
            ? <AlertTriangle className="h-4 w-4" />
            : <Info className="h-4 w-4" />}
          {summary}
          {rows.length > 0 && (
            <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
          )}
        </button>
        {trailing}
      </div>

      {open && rows.length > 0 && (
        <ul className="space-y-1 rounded-xl bg-white/[0.03] p-2 text-xs">
          {rows.map(row => {
            const rowTone = row.severity === 'blocking'
              ? 'text-red-400'
              : row.severity === 'warning' ? 'text-amber-500' : 'text-muted-foreground';
            return (
              <li key={row.key}>
                {row.entryId ? (
                  <button
                    type="button"
                    onClick={() => { onGoTo(row.entryId, row.folderId); setOpen(false); }}
                    className={`w-full rounded px-1.5 py-1 text-left hover:bg-white/[0.06] hover:text-foreground ${rowTone}`}
                  >
                    {row.message}
                  </button>
                ) : (
                  <span className={`block px-1.5 py-1 ${rowTone}`}>{row.message}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
