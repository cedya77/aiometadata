const ORDERS = new Set(['official', 'default', 'dvd', 'absolute', 'alternate', 'regional', 'alttwo']);

function orderMap(config: any): Record<string, string> | null {
  const map = config?.tvdbEpisodeOrders;
  return map && typeof map === 'object' && !Array.isArray(map) ? map : null;
}

export function episodeOrderOverride(config: any, tvdbId: string | number | null | undefined): string | null {
  const map = orderMap(config);
  if (!map || !tvdbId) return null;
  const value = map[`tvdb:${tvdbId}`];
  return typeof value === 'string' && ORDERS.has(value) ? value : null;
}

export function withEpisodeOrder<T extends Record<string, any>>(config: T, tvdbId: string | number | null | undefined): T {
  const order = episodeOrderOverride(config, tvdbId);
  return order && order !== config?.tvdbSeasonType ? { ...config, tvdbSeasonType: order } : config;
}

export function countEpisodeOrders(config: any): number {
  const map = orderMap(config);
  if (!map) return 0;
  return Object.entries(map).filter(([key, value]) => key.startsWith('tvdb:') && ORDERS.has(value)).length;
}
