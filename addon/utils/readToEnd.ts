import consola from 'consola';

const logger = consola.withTag('Trackers');

export async function readToEnd<T>(
  label: string,
  read: (page: number) => Promise<{ items: T[]; more: boolean }>,
  keyOf: (item: T) => string = (item) => JSON.stringify(item)
): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  for (let page = 0; ; page += 1) {
    const { items, more } = await read(page);
    let fresh = 0;
    for (const item of items) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      fresh += 1;
    }
    if (!more || !items.length) return out;
    if (!fresh) {
      logger.warn(`${label}: page ${page + 1} repeated earlier pages, stopped at ${out.length} items`);
      return out;
    }
  }
}
