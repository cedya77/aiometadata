// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
  published: string | null;
}

/** Where one configuration's search goes: an engine, the server it answers at, and the key it takes, which may be empty. */
export interface WebSearchSource {
  engine: WebSearchEngine;
  base: string;
  key: string;
  /** The key is the configuration's own rather than the instance's. */
  own: boolean;
}

/** A web search engine. A new one is a file beside the others and a line in engines.ts; the settings page lists it by itself. */
export interface WebSearchEngine {
  id: string;
  name: string;
  /** What choosing it means, shown under the choice. */
  about: string;
  /** Its hosted API, which a user can reach with a key of their own; absent where there is only an instance's own server. */
  hostedUrl?: string;
  /** Where a user gets a key for the hosted API. */
  keyLink?: string;
  /** The results for a query, at most `limit`. Throws with a `statusCode` and a short `reason` when the engine refuses or fails. */
  search(source: WebSearchSource, query: string, limit: number): Promise<WebResult[]>;
  /** Whether a key is accepted, without spending anything. */
  checkKey?(base: string, key: string): Promise<boolean>;
}
