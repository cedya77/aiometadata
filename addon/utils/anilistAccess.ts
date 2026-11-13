// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
// @ts-ignore
import { getSetting } from '../lib/settingsService';

/**
 * Set ANILIST_REQUIRES_AUTH if AniList starts refusing anonymous reads again. It
 * gates the artwork cache guards in lib/anilist.ts, error caching on the list and
 * trending catalogs, and the connect notices in the interface.
 */
export function anilistRequiresAuth(): boolean {
  return String(getSetting('ANILIST_REQUIRES_AUTH') ?? '').toLowerCase() === 'true';
}
