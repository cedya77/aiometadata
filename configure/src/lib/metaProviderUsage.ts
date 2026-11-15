// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { AppConfig } from '../contexts/config';

export type MetaProviderId = 'tvdb' | 'tmdb' | 'mal';

type ConfigLike = { providers?: Partial<AppConfig['providers']> };

export function isInUse(config: ConfigLike, provider: MetaProviderId): boolean {
  const providers = config?.providers;
  if (!providers) return false;
  if (provider === 'mal') {
    return providers.anime === 'mal' || providers.anime_id_provider === 'mal';
  }
  return providers.movie === provider
    || providers.series === provider
    || providers.anime === provider;
}
