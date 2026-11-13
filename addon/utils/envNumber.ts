// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
/**
 * `parseInt(...) || fallback` throws away a deliberate 0, which is how a delay or
 * a cache gets turned off. Only a value that is not a number at all falls back.
 */
export function envInt(name: string, fallback: number, min: number = 0): number {
  const parsed = parseInt(String(process.env[name]), 10);
  return Number.isFinite(parsed) ? Math.max(min, parsed) : fallback;
}
