type Severity = 'critical' | 'warning' | 'info';
type TabHealth = 'ok' | 'warn' | 'alert';

interface Signal {
  id: string;
  severity: Severity;
  title: string;
  detail?: string;
  metric?: string;
  link?: { tab: string; label: string };
}

interface TrendingItem {
  id: string;
  type: string;
  title: string;
  rating: number | null;
  year: number | string | null;
  poster: string | null;
  landscapePoster: string | null;
  imdb_id: string | null;
  requests: number;
  prevRequests: number;
  deltaPct: number | null;
  isNew: boolean;
}

interface OverviewSignals {
  verdict: { level: 'healthy' | 'warning' | 'critical'; headline: string; count: number };
  live: { requestsPerMin: number; activeUsers: number; successRate: number; successWindow: string; sparkline: number[] };
  needsAttention: Signal[];
  notable: Signal[];
  system: {
    status: string;
    memoryMB: number;
    diskPct: number | null;
    errorRate: number;
    redisOk: boolean;
    platform: string;
    processId: number;
    nodeVersion: string;
    version: string;
    uptime: string;
  };
  tabs: Record<string, TabHealth>;
  trending: TrendingItem[];
  timestamp: string;
}

const HEAVY_TTL_MS = 30000;
const TRENDING_TTL_MS = 5 * 60 * 1000;
const memoStore = new Map<string, { at: number; value: Promise<any> }>();

function memo(key: string, fn: () => Promise<any>, ttlMs: number = HEAVY_TTL_MS): Promise<any> {
  const hit = memoStore.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = fn();
  memoStore.set(key, { at: now, value });
  value.catch(() => { if (memoStore.get(key)?.value === value) memoStore.delete(key); });
  return value;
}

function fractionOfDay(tz: string | null): number {
  const now = new Date();
  let h = now.getHours();
  let m = now.getMinutes();
  let s = now.getSeconds();
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
      }).formatToParts(now);
      const get = (t: string) => parseInt(parts.find(p => p.type === t)?.value || '0', 10);
      h = get('hour') % 24;
      m = get('minute');
      s = get('second');
    } catch {}
  }
  return (h * 3600 + m * 60 + s) / 86400;
}

function findRedisHealth(systemOverview: any): boolean {
  const checks = systemOverview?.healthChecks;
  if (!checks) return true;
  const arr = Array.isArray(checks) ? checks : Object.entries(checks).map(([name, v]) => ({ name, ...(v as any) }));
  const redis = arr.find((c: any) => /redis/i.test(c.name || c.service || ''));
  if (!redis) return true;
  const status = (redis.status || redis.state || '').toString().toLowerCase();
  if (status) return !/error|down|fail|unhealthy/.test(status);
  if (typeof redis.healthy === 'boolean') return redis.healthy;
  if (typeof redis.ok === 'boolean') return redis.ok;
  return true;
}

function buildHeadline(level: string, needsAttention: Signal[]): string {
  if (level === 'healthy') return 'All systems healthy';
  const titles = needsAttention.slice(0, 2).map(s => s.title);
  let headline = titles.join(' · ');
  const extra = needsAttention.length - titles.length;
  if (extra > 0) headline += ` · +${extra} more`;
  return headline;
}

export async function buildOverviewSignals(
  dashboardApi: any,
  opts: { tz?: string | null; systemOverview?: any } = {},
): Promise<OverviewSignals> {
  const tz = opts.tz || null;
  const rt = dashboardApi.requestTracker;

  const [stats, providers, hourly, activeUsers, requestsPerMin, resource, systemOverview, popular, searches, errorLogs, trending] = await Promise.all([
    rt ? rt.getStats(tz) : null,
    memo('providerPerf', () => dashboardApi.getProviderPerformance().catch(() => [])),
    memo(`hourly:${tz}`, () => rt ? rt.getHourlyStats(12, tz).catch(() => []) : Promise.resolve([])),
    rt ? rt.getActiveUsers().catch(() => 0) : 0,
    dashboardApi.getRequestsPerMinute().catch(() => 0),
    memo('resourceUsage', () => dashboardApi.getResourceUsage().catch(() => ({}))),
    opts.systemOverview ? Promise.resolve(opts.systemOverview) : dashboardApi.getSystemOverview(),
    memo(`popular:${tz}`, () => rt ? rt.getPopularContent(5, 1, tz).catch(() => []) : Promise.resolve([])),
    memo(`searches:${tz}`, () => rt ? rt.getSearchPatterns(10, 1, tz).catch(() => []) : Promise.resolve([])),
    memo('errorLogs', () => dashboardApi.getErrorLogs ? dashboardApi.getErrorLogs().catch(() => []) : Promise.resolve([])),
    memo(`trending:${tz}`, () => rt ? rt.getTrendingContent(10, tz).catch(() => []) : Promise.resolve([]), TRENDING_TTL_MS),
  ]);

  const errorRate = stats?.errorRate || 0;
  const tracked = stats?.trackedResponses || 0;

  const needsAttention: Signal[] = [];

  for (const p of providers || []) {
    if (p.status === 'error') {
      needsAttention.push({
        id: `provider-${p.name}`,
        severity: 'critical',
        title: `${p.name} is degraded`,
        detail: `${p.errorRate}% errors · ${p.responseTime}ms avg · ${p.totalCalls} calls`,
        link: { tab: 'analytics', label: 'View in Analytics' },
      });
    } else if (p.status === 'warning') {
      needsAttention.push({
        id: `provider-${p.name}`,
        severity: 'warning',
        title: `${p.name} is slow or erroring`,
        detail: `${p.errorRate}% errors · ${p.responseTime}ms avg`,
        link: { tab: 'analytics', label: 'View in Analytics' },
      });
    }
  }

  if (tracked >= 50 && errorRate >= 5) {
    needsAttention.push({
      id: 'error-rate',
      severity: 'critical',
      title: `Error rate elevated: ${errorRate}%`,
      detail: `${stats.todayErrors} errors of ${tracked} tracked today`,
      link: { tab: 'logs', label: 'View in Logs' },
    });
  } else if (tracked >= 50 && errorRate >= 2) {
    needsAttention.push({
      id: 'error-rate',
      severity: 'warning',
      title: `Error rate ${errorRate}%`,
      detail: `${stats.todayErrors} errors of ${tracked} tracked today`,
      link: { tab: 'logs', label: 'View in Logs' },
    });
  }

  const redisOk = findRedisHealth(systemOverview);
  if (!redisOk) {
    needsAttention.push({
      id: 'redis',
      severity: 'critical',
      title: 'Redis is unreachable',
      detail: 'Caching and metrics are degraded',
      link: { tab: 'operations', label: 'View in Operations' },
    });
  }

  for (let i = 0; i < (systemOverview?.issues || []).length; i++) {
    const issue = systemOverview.issues[i];
    needsAttention.push({
      id: `issue-${i}`,
      severity: /critical/i.test(issue) ? 'critical' : 'warning',
      title: issue,
      link: { tab: 'system', label: 'View in System' },
    });
  }

  const notable: Signal[] = [];

  const today = stats?.todayRequests || 0;
  const yesterday = stats?.yesterdayRequests || 0;
  const frac = fractionOfDay(tz);
  if (yesterday > 0 && frac > 0.02) {
    const expected = yesterday * frac;
    const deltaPct = Math.round(((today - expected) / expected) * 100);
    const dir = deltaPct > 0 ? '↑' : deltaPct < 0 ? '↓' : '→';
    notable.push({
      id: 'request-pace',
      severity: 'info',
      title: `Requests ${dir}${Math.abs(deltaPct)}% vs this time yesterday`,
      metric: `${today.toLocaleString()} today`,
      link: { tab: 'analytics', label: 'Analytics' },
    });
  } else {
    notable.push({
      id: 'request-pace',
      severity: 'info',
      title: `${today.toLocaleString()} requests today`,
      link: { tab: 'analytics', label: 'Analytics' },
    });
  }

  const topContent = (popular || [])[0];
  if (topContent?.title) {
    notable.push({
      id: 'top-content',
      severity: 'info',
      title: `Most-requested: ${topContent.title}`,
      metric: `${(topContent.requests || 0).toLocaleString()} reqs`,
      detail: topContent.year ? `${topContent.type} · ${topContent.year}` : topContent.type,
      link: { tab: 'content', label: 'Content' },
    });
  }

  const topSearch = (searches || [])[0];
  if (topSearch?.query) {
    notable.push({
      id: 'top-search',
      severity: 'info',
      title: `Top search: "${topSearch.query}"`,
      metric: `${(topSearch.count || 0).toLocaleString()}×`,
      detail: `${topSearch.success}% found results`,
      link: { tab: 'content', label: 'Content' },
    });
  }

  const failingSearch = (searches || []).find((s: any) => s.count >= 5 && s.success < 20 && s.query !== topSearch?.query);
  if (failingSearch) {
    notable.push({
      id: 'failing-search',
      severity: 'info',
      title: `"${failingSearch.query}" returns few results`,
      metric: `${failingSearch.count}× · ${failingSearch.success}% found`,
      link: { tab: 'content', label: 'Content' },
    });
  }

  const level: 'healthy' | 'warning' | 'critical' =
    needsAttention.some(s => s.severity === 'critical') ? 'critical'
      : needsAttention.some(s => s.severity === 'warning') ? 'warning'
        : 'healthy';

  const analyticsHealth: TabHealth =
    (providers || []).some((p: any) => p.status === 'error') || errorRate >= 5 ? 'alert'
      : (providers || []).some((p: any) => p.status === 'warning') || errorRate >= 2 ? 'warn'
        : 'ok';
  const logsHealth: TabHealth =
    needsAttention.some(s => s.severity === 'critical') ? 'alert'
      : (errorLogs || []).length > 0 ? 'warn' : 'ok';

  const mem = systemOverview?.memoryUsage?.rss || 0;

  return {
    verdict: { level, headline: buildHeadline(level, needsAttention), count: needsAttention.length },
    live: {
      requestsPerMin: requestsPerMin || 0,
      activeUsers: activeUsers || 0,
      successRate: stats?.successRate || 0,
      successWindow: 'today',
      sparkline: (hourly || []).map((h: any) => h.requests || 0),
    },
    needsAttention,
    notable,
    system: {
      status: systemOverview?.status || 'unknown',
      memoryMB: Math.round(mem / 1048576),
      diskPct: typeof resource?.diskUsage === 'number' ? resource.diskUsage : null,
      errorRate,
      redisOk,
      platform: systemOverview?.platform || '',
      processId: systemOverview?.processId || 0,
      nodeVersion: systemOverview?.nodeVersion || '',
      version: systemOverview?.version || 'N/A',
      uptime: systemOverview?.uptime || '',
    },
    tabs: {
      analytics: analyticsHealth,
      content: 'ok',
      performance: analyticsHealth === 'alert' ? 'warn' : 'ok',
      users: 'ok',
      operations: (systemOverview?.issues || []).length > 0 || !redisOk ? 'warn' : 'ok',
      logs: logsHealth,
    },
    trending: trending || [],
    timestamp: new Date().toISOString(),
  };
}
