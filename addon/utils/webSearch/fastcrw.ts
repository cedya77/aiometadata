// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { httpJson, saidBy, searchFailure } from './http';
import type { WebResult, WebSearchEngine } from './types';

function refusal(status: number, said: string): Error {
  const what = status === 402 ? 'fastCRW has no credits left'
    : status === 401 || status === 403 ? 'fastCRW refused the key'
      : status === 429 ? 'fastCRW is limiting requests, try again shortly'
        : status === 503 ? 'search is off or unreachable on that fastCRW server'
          : `fastCRW answered ${status}`;
  return searchFailure(status, said ? `${what}: ${said}` : what, what);
}

export const fastcrw: WebSearchEngine = {
  id: 'fastcrw',
  name: 'fastCRW',
  about: 'A search costs 2 fastCRW credits.',
  hostedUrl: 'https://api.fastcrw.com',
  keyLink: 'https://fastcrw.com',

  async search({ base, key }, query, limit): Promise<WebResult[]> {
    // No time filter: a server whose engines cannot filter by date refuses the whole search, so callers name the year.
    const { status, data, text } = await httpJson(`${base}/v1/search`, { method: 'POST', key, body: { query, limit } });
    if (status !== 200 || !data || data.success === false) throw refusal(status, saidBy(data, text));
    // The hosted API puts the results in data, a server of one's own in data.results, a search by source in data.web.
    const rows: any[] = Array.isArray(data.data) ? data.data
      : Array.isArray(data.data?.results) ? data.data.results
        : Array.isArray(data.data?.web) ? data.data.web
          : [];
    return rows.map((row) => ({
      title: String(row?.title ?? '').trim(),
      url: String(row?.url ?? '').trim(),
      snippet: String(row?.snippet ?? row?.description ?? '').replace(/\s+/g, ' ').trim(),
      published: row?.publishedDate ? String(row.publishedDate) : null,
    }));
  },

  // The capabilities route answers a key without spending credits.
  async checkKey(base, key) {
    const { status } = await httpJson(`${base}/v1/capabilities`, { method: 'GET', key, timeoutMs: 10000 });
    if (status === 200) return true;
    if (status === 401 || status === 403) return false;
    throw searchFailure(status, `fastCRW answered ${status}`);
  },
};
