// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useConfig } from '@/contexts/ConfigContext';

/** Whether this configuration can search the web through fastCRW: with a key of its own, or one the instance offers. */
export function useFastcrw(): boolean {
  const { config, webSearchInstance } = useConfig();
  return webSearchInstance || Boolean(config.apiKeys?.fastcrw?.trim());
}
