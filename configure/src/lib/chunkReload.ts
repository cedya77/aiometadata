// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
const RELOAD_STAMP_KEY = 'aiom:chunk-reload-at';

export const RELOAD_GUARD_WINDOW_MS = 60_000;

const CHUNK_ERROR_PATTERNS = [
  'dynamically imported module',
  'importing a module script failed',
  'failed to load module script',
  'unable to preload css', 
];

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const haystack = message.toLowerCase();
  return CHUNK_ERROR_PATTERNS.some((pattern) => haystack.includes(pattern));
}

export interface ReloadGuardStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function claimChunkReload(
  storage: ReloadGuardStorage | null | undefined,
  now: number = Date.now()
): boolean {
  if (!storage) return false;

  try {
    const raw = storage.getItem(RELOAD_STAMP_KEY);
    const last = raw === null ? Number.NaN : Number(raw);
    if (Number.isFinite(last) && now - last < RELOAD_GUARD_WINDOW_MS) {
      return false;
    }
    storage.setItem(RELOAD_STAMP_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

export function reloadGuardStorage(): ReloadGuardStorage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}
