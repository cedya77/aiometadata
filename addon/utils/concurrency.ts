const META_CONCURRENCY = parseInt(process.env.META_CONCURRENCY || '0', 10) || 0;

export async function mapWithLimit<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!META_CONCURRENCY || items.length <= META_CONCURRENCY) {
    return Promise.all(items.map(fn));
  }

  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: META_CONCURRENCY }, () => worker()));
  return results;
}
