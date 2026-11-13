// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { Badge } from '@/components/ui/badge';
import { JELLYFIN_CHIP, NUVIO_CHIP } from '@/lib/collectionBuilder/terms';

/** Marks a control that only one of the two targets understands. */
export function ScopeChip({ scope }: { scope: 'nuvio' | 'jellyfin' }) {
  const label = scope === 'nuvio' ? 'Nuvio only' : 'Jellyfin only';
  const tone = scope === 'nuvio' ? NUVIO_CHIP : JELLYFIN_CHIP;
  return (
    <Badge variant="outline" className={`h-5 shrink-0 px-1.5 text-xs font-medium ${tone}`}>
      {label}
    </Badge>
  );
}
