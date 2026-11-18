// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { httpJson, saidBy, searchFailure } from './http';
import type { WebResult, WebSearchEngine } from './types';

/** A SearXNG server of the instance's own: no hosted API, no keys. */
export const searxng: WebSearchEngine = {
  id: 'searxng',
  name: 'SearXNG',
  about: 'Free, through this instance\'s own SearXNG server.',

  async search({ base }, query, limit): Promise<WebResult[]> {
    const { status, data, text } = await httpJson(`${base}/search?q=${encodeURIComponent(query)}&format=json`, { method: 'GET' });
    // SearXNG answers JSON only where its settings list it among search.formats.
    if (status === 403) throw searchFailure(403, 'SearXNG refused a JSON answer: add json to search.formats in its settings.yml');
    if (status === 429) throw searchFailure(429, 'SearXNG is limiting requests, try again shortly');
    if (status !== 200 || !data) throw searchFailure(status, `SearXNG answered ${status}${saidBy(data, text) ? `: ${saidBy(data, text)}` : ''}`);
    const rows: any[] = Array.isArray(data.results) ? data.results : [];
    // No results because its engines refused is a failure, not an empty web.
    const silent: string[] = Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines.map((entry: any) => String(Array.isArray(entry) ? entry[0] : entry)) : [];
    if (!rows.length && silent.length) throw searchFailure(503, `SearXNG's engines did not answer: ${silent.join(', ')}`);
    return rows.slice(0, limit).map((row) => ({
      title: String(row?.title ?? '').trim(),
      url: String(row?.url ?? '').trim(),
      snippet: String(row?.content ?? '').replace(/\s+/g, ' ').trim(),
      published: row?.publishedDate ? String(row.publishedDate) : null,
    }));
  },
};
