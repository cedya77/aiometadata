// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE


const DURATION_UNIT_MS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  h: 60 * 60 * 1000,
  hr: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  y: 365 * 24 * 60 * 60 * 1000,
};

const DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|w|y)\s*$/i;

/** A unit is required: a bare number would have to guess between seconds and days. */
export function parseDurationMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = DURATION_RE.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.floor(amount * DURATION_UNIT_MS[match[2].toLowerCase()]);
}
