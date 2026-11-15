// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { ExportNote } from '@shared/types';
import type { SourceIssue } from './manifestSources';
import { collectProblems, type ProblemTarget } from './problems';

export type IssueSeverity = 'blocking' | 'warning' | 'info';

export interface IssueRow {
  key: string;
  message: string;
  severity: IssueSeverity;
  entryId: string | null;
  folderId: string | null;
}

export interface BlockingInput {
  target: 'nuvio' | 'jellyfin';
  strandedNative: number;
  overBy: number;
  pendingCount: number;
  headroom: number;
  /** Required API keys the configuration is still missing, by display name. */
  missingKeys: string[];
}

export interface IssueCenterArgs {
  blocking: IssueRow[];
  issues: SourceIssue[];
  notes: ExportNote[];
  targets: Map<string, ProblemTarget>;
}

export interface SaveVerdict {
  canSave: boolean;
  blocking: number;
  warnings: number;
  label: string;
}

const RANK: Record<IssueSeverity, number> = { blocking: 0, warning: 1, info: 2 };

/**
 * The two conditions that refuse a save outright, as rows so they sit in the
 * same list as everything else rather than ambushing the user at the button.
 */
export function blockingIssues({
  target,
  strandedNative,
  overBy,
  pendingCount,
  headroom,
  missingKeys,
}: BlockingInput): IssueRow[] {
  const rows: IssueRow[] = [];

  if (missingKeys.length > 0) {
    rows.push({
      key: 'block-missing-keys',
      severity: 'blocking',
      message: `Your configuration cannot be saved until ${missingKeys.join(', ')} ${missingKeys.length === 1 ? 'is' : 'are'} filled in on the Configuration tab. Apply only keeps this design without saving.`,
      entryId: null,
      folderId: null,
    });
  }

  if (overBy > 0) {
    rows.push({
      key: 'block-over-limit',
      severity: 'blocking',
      message: `This design needs ${pendingCount} new catalogs and there is room for ${headroom}. Remove ${overBy} more catalog${overBy === 1 ? '' : 's'} worth of tiles.`,
      entryId: null,
      folderId: null,
    });
  }

  if (strandedNative > 0) {
    const sources = `${strandedNative} source${strandedNative === 1 ? '' : 's'}`;
    rows.push({
      key: 'block-native',
      severity: 'blocking',
      message: target === 'jellyfin'
        ? `Jellyfin cannot serve ${sources} that the app fetches itself. Route them through AIOMetadata, or build for Nuvio.`
        : `Nuvio cannot serve ${sources} that Fusion fetched itself. Route them through AIOMetadata.`,
      entryId: null,
      folderId: null,
    });
  }

  return rows;
}

export function buildIssueCenter({ blocking, issues, notes, targets }: IssueCenterArgs): IssueRow[] {
  return [...blocking, ...collectProblems(issues, notes, targets)]
    .sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

export function saveVerdict(rows: IssueRow[]): SaveVerdict {
  const blocking = rows.filter(row => row.severity === 'blocking').length;
  const warnings = rows.filter(row => row.severity === 'warning').length;

  if (blocking > 0) {
    return { canSave: false, blocking, warnings, label: `${blocking} issue${blocking === 1 ? '' : 's'} to fix` };
  }
  if (warnings > 0) {
    return { canSave: true, blocking, warnings, label: `Save · ${warnings} warning${warnings === 1 ? '' : 's'}` };
  }
  return { canSave: true, blocking, warnings, label: 'Save' };
}
