// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
/** Most permissive last. An install URL may only pick a rating below the stored one. */
export const AGE_RATING_ORDER = ['G', 'PG', 'PG-13', 'R', 'NC-17'] as const;

export const AGE_RATING_LABELS: Record<string, string> = {
  'None': 'None (Show All)',
  'G': 'G (All Ages)',
  'PG': 'PG (Parental Guidance)',
  'PG-13': 'PG-13 (Parents Strongly Cautioned)',
  'R': 'R (Restricted)',
  'NC-17': 'NC-17 (Adults Only)',
};

export const AGE_RATING_OPTIONS = [
  { value: 'None', label: AGE_RATING_LABELS['None'] },
  ...AGE_RATING_ORDER.map(value => ({ value, label: AGE_RATING_LABELS[value] })),
];
