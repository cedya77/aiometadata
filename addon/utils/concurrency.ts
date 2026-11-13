// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
const META_CONCURRENCY = parseInt(process.env.META_CONCURRENCY || '0', 10) || 0;

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

export async function mapWithLimit<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!META_CONCURRENCY || items.length <= META_CONCURRENCY) {
    return Promise.all(items.map(fn));
  }

  return mapWithConcurrency(items, META_CONCURRENCY, fn);
}
