// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { fastcrw } from './fastcrw';
import { searxng } from './searxng';
import type { WebSearchEngine } from './types';

/** Every web search engine. A new one is a file beside these and a line here. */
export const ENGINES: WebSearchEngine[] = [fastcrw, searxng];

export function engineOf(id: unknown): WebSearchEngine | null {
  return ENGINES.find((engine) => engine.id === id) ?? null;
}
