// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
export {};

/**
 * `director` and `writer` are arrays of names. Entries written while they were
 * joined into one string are still readable, and the component key they live
 * under is derived from the configuration rather than from the field's shape,
 * so nothing expires them early. Reads coerce instead, which costs one check
 * per meta and lets those entries age out on their own.
 *
 * A name that itself contained a comma was already lost to the join, so the
 * split cannot recover it. Splitting still reads better than handing a client
 * the wrong type for the field.
 */

const CREDIT_FIELDS = ['director', 'writer'] as const;

interface MetaWithCredits {
  director?: unknown;
  writer?: unknown;
  [key: string]: any;
}

interface PayloadWithMetas {
  meta?: MetaWithCredits | null;
  metas?: MetaWithCredits[];
  [key: string]: any;
}

function toNameArray(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.split(',').map(name => name.trim()).filter(Boolean);
}

function normalizeMetaCredits<T extends MetaWithCredits | null | undefined>(meta: T): T {
  if (!meta || typeof meta !== 'object') return meta;

  for (const field of CREDIT_FIELDS) {
    if (typeof meta[field] === 'string') {
      meta[field] = toNameArray(meta[field]);
    }
  }

  return meta;
}

function normalizeCreditsInPayload<T extends PayloadWithMetas | null | undefined>(payload: T): T {
  if (!payload || typeof payload !== 'object') return payload;

  if (payload.meta) {
    normalizeMetaCredits(payload.meta);
  }

  if (Array.isArray(payload.metas)) {
    for (const meta of payload.metas) {
      normalizeMetaCredits(meta);
    }
  }

  return payload;
}

module.exports = {
  normalizeMetaCredits,
  normalizeCreditsInPayload,
};
