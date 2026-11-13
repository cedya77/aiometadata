// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle, ChevronDown, Circle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { hashFor } from '@/lib/settingsRoute';
import type { KeyStatus } from '@/lib/configStatus';

export const CONFIG_STATUS_SUMMARY_ID = 'config-status-summary';

const DETAILS_ID = 'config-status-details';
const MAX_NAMED_KEYS = 3;

function goToKey(anchor: string): void {
  window.location.hash = hashFor('integrations', anchor);
}

function AddKeyButton({ row }: { row: KeyStatus }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 shrink-0 px-2 text-xs"
      onClick={() => goToKey(row.anchor)}
    >
      Add key
      <span className="sr-only"> for {row.name}</span>
      <span aria-hidden="true"> &rarr;</span>
    </Button>
  );
}

function StatusRow({ row }: { row: KeyStatus }) {
  const { name, configured, required } = row;
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="flex min-w-0 items-center gap-3">
        {configured ? (
          <CheckCircle className="h-4 w-4 shrink-0 text-green-500" aria-hidden="true" />
        ) : required ? (
          <AlertCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        ) : (
          <Circle className="h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden="true" />
        )}
        <span className="truncate text-sm font-medium">{name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {required ? 'Required' : 'Optional'}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {configured ? (
          <span className="text-sm font-medium text-green-500">Configured</span>
        ) : (
          <>
            <span
              className={cn(
                'text-sm font-medium',
                required ? 'text-destructive' : 'text-muted-foreground'
              )}
            >
              {required ? 'Missing' : 'Not set'}
            </span>
            <AddKeyButton row={row} />
          </>
        )}
      </div>
    </div>
  );
}

/** Never empty: tmdb is required unconditionally, so there is always a name. */
function readyLine(statuses: KeyStatus[]): string {
  const names = statuses.filter((row) => row.required && row.configured).map((row) => row.name);
  const shown = names.slice(0, MAX_NAMED_KEYS).join(', ');
  const extra = names.length - MAX_NAMED_KEYS;
  return extra > 0 ? `Ready: ${shown} +${extra} more` : `Ready: ${shown}`;
}

export function ConfigStatusPanel({
  statuses,
  missingKeys,
  loading,
}: {
  statuses: KeyStatus[];
  missingKeys: KeyStatus[];
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const blocked = missingKeys.length > 0;

  return (
    <div className="space-y-3">
      <div id={CONFIG_STATUS_SUMMARY_ID} role="status">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Checking API keys...
          </div>
        ) : blocked ? (
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
            <span className="font-medium text-amber-200">
              {missingKeys.length === 1
                ? '1 API key needed before you can save'
                : `${missingKeys.length} API keys needed before you can save`}
            </span>
          </div>
        ) : (
          <div className="flex items-start gap-2 text-sm">
            <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-green-500" aria-hidden="true" />
            <span className="min-w-0">
              <span className="font-medium">All required API keys are configured</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {readyLine(statuses)}
              </span>
            </span>
          </div>
        )}
      </div>

      {!loading && blocked ? (
        <ul className="space-y-2">
          {missingKeys.map((row) => (
            <li
              key={row.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-amber-200">{row.name}</div>
                {row.reason ? (
                  <div className="mt-0.5 text-xs text-amber-200/80">{row.reason}</div>
                ) : null}
              </div>
              <AddKeyButton row={row} />
            </li>
          ))}
        </ul>
      ) : null}

      {!loading ? (
        <>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-controls={DETAILS_ID}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Details
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
              aria-hidden="true"
            />
          </button>
          {open ? (
            <div id={DETAILS_ID} className="divide-y divide-border rounded-lg border">
              {statuses.map((row) => (
                <StatusRow key={row.id} row={row} />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
