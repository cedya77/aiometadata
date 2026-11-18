// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useConfig } from '@/contexts/ConfigContext';

export interface WebSearchEngineInfo {
  id: string;
  name: string;
  about: string;
  keyLink: string | null;
  /** Its hosted API takes a key of the user's own. */
  userKeys: boolean;
}

/** The web search engines, and those this configuration can reach: the instance's, and any it holds a key for. */
export function useWebSearch() {
  const { config, webSearch } = useConfig();
  const keys = (config.apiKeys ?? {}) as Record<string, string | undefined>;
  const available = webSearch.engines.filter((engine) => engine.id === webSearch.instance || (engine.userKeys && Boolean(keys[engine.id]?.trim())));
  return {
    engines: webSearch.engines,
    available,
    instance: webSearch.instance,
    /** Whether the choice is worth showing: an engine can be reached, or one was chosen and may need a key again. */
    offered: (via?: string) => available.length > 0 || Boolean(via),
  };
}
