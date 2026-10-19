import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAdmin } from '@/contexts/AdminContext';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ============================================================================
// Types
// ============================================================================

export type DashboardTab = 'overview' | 'analytics' | 'content' | 'performance' | 'system' | 'operations' | 'users' | 'jellyfin' | 'logs' | 'settings';

interface DashboardQueryOptions {
  activeTab?: DashboardTab;
  enabled?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

// Polling intervals in milliseconds
const POLLING_INTERVALS = {
  OVERVIEW: 5 * 1000,           // 5 seconds - live strip stays snappy; heavy signals memoized server-side
  ANALYTICS: 15 * 1000,         // 15 seconds - metrics data
  PERFORMANCE: 60 * 1000,       // 60 seconds - timing data (aggregated stats, slow-changing)
  SYSTEM: 10 * 1000,            // 10 seconds - system config + activity
  OPERATIONS: 5 * 1000,         // 5 seconds - warming tasks need fast updates
  COLD_STORE: 60 * 1000,        // 60 seconds - size gauge over a large table, not a live feed
  USERS: 15 * 1000,             // 15 seconds - user activity
  ACCOUNTS: 30 * 1000,          // 30 seconds - sign-ins change less often than config users
  JELLYFIN: 10 * 1000,          // 10 seconds - live sessions move
  CONTENT: 60 * 1000,           // 60 seconds - slow-changing data
  LOGS: 2 * 1000,               // 2 seconds - live log streaming (backstop for the SSE stream)
} as const;

// Cap client-side log accumulation so a long-open tab can't grow unbounded.
// The server serves the real value; this is the fallback before it arrives.
const DEFAULT_MAX_CLIENT_LOG_ENTRIES = 10000;

/**
 * Filters the stream applies server side, against the whole buffer rather than
 * the tail the browser happens to hold. `level` carries a single label only,
 * which is what the buffer matches on; a multi-level pick stays local.
 */
export interface LogStreamFilters {
  level?: string;
  tag?: string;
  service?: string;
  search?: string;
}

// Query keys for cache management
export const DASHBOARD_QUERY_KEYS = {
  overview: ['dashboard', 'overview'] as const,
  analytics: ['dashboard', 'analytics'] as const,
  content: ['dashboard', 'content'] as const,
  performance: ['dashboard', 'performance'] as const,
  system: ['dashboard', 'system'] as const,
  operations: ['dashboard', 'operations'] as const,
  users: ['dashboard', 'users'] as const,
  accounts: ['dashboard', 'accounts'] as const,
  signinFailures: ['dashboard', 'signin-failures'] as const,
  jellyfin: ['dashboard', 'jellyfin'] as const,
  logs: ['dashboard', 'logs'] as const,
  settings: ['dashboard', 'settings'] as const,
  all: ['dashboard'] as const,
} as const;

const CLIENT_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function appendTz(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}tz=${encodeURIComponent(CLIENT_TZ)}`;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Creates headers for API requests based on auth state
 */
function useApiHeaders() {
  const { isAdmin, adminKey } = useAdmin();
  
  return useCallback(() => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (isAdmin && adminKey) {
      headers['x-admin-key'] = adminKey;
    }
    return headers;
  }, [isAdmin, adminKey]);
}

/**
 * Generic fetch function with error handling
 */
async function fetchDashboardData<T>(
  endpoint: string,
  headers: Record<string, string>
): Promise<T> {
  const response = await fetch(endpoint, { headers });
  
  if (response.status === 401) {
    throw new Error('UNAUTHORIZED');
  }
  
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  
  return response.json();
}

/**
 * Hook to track browser tab visibility for pausing polling
 */
export function usePageVisibility() {
  const [isVisible, setIsVisible] = useState(!document.hidden);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsVisible(!document.hidden);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return isVisible;
}

// ============================================================================
// Individual Query Hooks
// ============================================================================

/**
 * Overview data - quick stats, system status
 * Polls every 10s when overview tab is active (admin only - guests fetch once)
 */
export function useDashboardOverview(options: DashboardQueryOptions = {}) {
  const { isAdmin, isGuest, logout } = useAdmin();
  const getHeaders = useApiHeaders();
  const isVisible = usePageVisibility();
  const { activeTab = 'overview', enabled = true } = options;

  const isAuthenticated = isAdmin || isGuest;
  const isActiveTab = activeTab === 'overview';
  // Only admins get live polling - guests fetch once on load
  const shouldPoll = isVisible && isActiveTab && isAdmin;

  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.overview,
    queryFn: async () => {
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const params = tz ? `?tz=${encodeURIComponent(tz)}` : '';
        return await fetchDashboardData(`/api/dashboard/overview${params}`, getHeaders());
      } catch (error) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') {
          logout();
          throw error;
        }
        throw error;
      }
    },
    // Only fetch when this tab is active
    enabled: enabled && isAuthenticated && isActiveTab,
    refetchInterval: shouldPoll ? POLLING_INTERVALS.OVERVIEW : false,
    refetchIntervalInBackground: false,
  });
}

/**
 * Analytics data - request metrics, cache performance, provider performance
 * Polls every 30s when analytics tab is active (admin only - guests fetch once)
 */
export function useDashboardAnalytics(options: DashboardQueryOptions = {}) {
  const { isAdmin, isGuest, logout } = useAdmin();
  const getHeaders = useApiHeaders();
  const isVisible = usePageVisibility();
  const { activeTab = 'overview', enabled = true } = options;

  const isAuthenticated = isAdmin || isGuest;
  const isActiveTab = activeTab === 'analytics';
  // Only admins get live polling - guests fetch once on load
  const shouldPoll = isVisible && isActiveTab && isAdmin;

  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.analytics,
    queryFn: async () => {
      try {
        return await fetchDashboardData(appendTz('/api/dashboard/analytics'), getHeaders());
      } catch (error) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') {
          logout();
          throw error;
        }
        throw error;
      }
    },
    // Only fetch when this tab is active
    enabled: enabled && isAuthenticated && isActiveTab,
    refetchInterval: shouldPoll ? POLLING_INTERVALS.ANALYTICS : false,
    refetchIntervalInBackground: false,
  });
}

/**
 * Content data - popular content, search patterns
 * Polls every 60s when content tab is active (admin only - guests fetch once)
 */
export function useDashboardContent(options: DashboardQueryOptions & { timeframe?: string } = {}) {
  const { isAdmin, isGuest, logout } = useAdmin();
  const getHeaders = useApiHeaders();
  const isVisible = usePageVisibility();
  const { activeTab = 'overview', enabled = true, timeframe = 'today' } = options;

  const isAuthenticated = isAdmin || isGuest;
  const isActiveTab = activeTab === 'content';
  const shouldPoll = isVisible && isActiveTab && isAdmin;

  return useQuery({
    queryKey: [...DASHBOARD_QUERY_KEYS.content, timeframe],
    queryFn: async () => {
      try {
        return await fetchDashboardData(appendTz(`/api/dashboard/content?timeframe=${timeframe}`), getHeaders());
      } catch (error) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') {
          logout();
          throw error;
        }
        throw error;
      }
    },
    enabled: enabled && isAuthenticated && isActiveTab,
    refetchInterval: shouldPoll ? POLLING_INTERVALS.CONTENT : false,
    refetchIntervalInBackground: false,
  });
}

/**
 * Performance/Timing data - detailed timing metrics
 * Polls every 30s when performance tab is active (admin only - guests fetch once)
 */
export function useDashboardPerformance(options: DashboardQueryOptions = {}) {
  const { isAdmin, isGuest, logout } = useAdmin();
  const getHeaders = useApiHeaders();
  const isVisible = usePageVisibility();
  const { activeTab = 'overview', enabled = true } = options;

  const isAuthenticated = isAdmin || isGuest;
  const isActiveTab = activeTab === 'performance';
  // Only admins get live polling - guests fetch once on load
  const shouldPoll = isVisible && isActiveTab && isAdmin;

  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.performance,
    queryFn: async () => {
      try {
        return await fetchDashboardData('/api/dashboard/timing', getHeaders());
      } catch (error) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') {
          logout();
          throw error;
        }
        throw error;
      }
    },
    // Only fetch when this tab is active
    enabled: enabled && isAuthenticated && isActiveTab,
    refetchInterval: shouldPoll ? POLLING_INTERVALS.PERFORMANCE : false,
    refetchIntervalInBackground: false,
  });
}

/**
 * System data - config, resource usage, provider status, recent activity
 * Polls every 30s when system or overview tab is active (admin only - guests fetch once)
 * Note: Also needed for overview tab (recent activity)
 */
export function useDashboardSystem(options: DashboardQueryOptions = {}) {
  const { isAdmin, isGuest, logout } = useAdmin();
  const getHeaders = useApiHeaders();
  const isVisible = usePageVisibility();
  const { activeTab = 'overview', enabled = true } = options;

  const isAuthenticated = isAdmin || isGuest;
  // System data is needed for both overview (recent activity) and system tabs
  const isActiveTab = activeTab === 'system' || activeTab === 'overview';
  // Only admins get live polling - guests fetch once on load
  const shouldPoll = isVisible && isActiveTab && isAdmin;

  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.system,
    queryFn: async () => {
      try {
        return await fetchDashboardData('/api/dashboard/system', getHeaders());
      } catch (error) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') {
          logout();
          throw error;
        }
        throw error;
      }
    },
    // Only fetch when overview or system tab is active
    enabled: enabled && isAuthenticated && isActiveTab,
    refetchInterval: shouldPoll ? POLLING_INTERVALS.SYSTEM : false,
    refetchIntervalInBackground: false,
  });
}

/**
 * Operations data - cache stats, error logs, maintenance tasks (admin only)
 * Polls every 5s when operations tab is active (warming tasks need fast updates)
 */
export function useDashboardOperations(options: DashboardQueryOptions = {}) {
  const { isAdmin, logout, adminKey } = useAdmin();
  const getHeaders = useApiHeaders();
  const isVisible = usePageVisibility();
  const { activeTab = 'overview', enabled = true } = options;

  const isActiveTab = activeTab === 'operations';
  // Operations is admin-only
  const shouldPoll = isVisible && isActiveTab && isAdmin;

  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.operations,
    queryFn: async () => {
      try {
        return await fetchDashboardData('/api/dashboard/operations', getHeaders());
      } catch (error) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') {
          logout();
          throw error;
        }
        throw error;
      }
    },
    // Only fetch when operations tab is active
    enabled: enabled && isAdmin && isActiveTab,
    refetchInterval: shouldPoll ? POLLING_INTERVALS.OPERATIONS : false,
    refetchIntervalInBackground: false,
  });
}

/**
 * Memory profiler data - heap stats, cache sizes (admin only)
 * Polls every 10s when operations tab is active
 */
export function useDashboardMemory(options: DashboardQueryOptions = {}) {
  const { isAdmin, logout, adminKey } = useAdmin();
  const getHeaders = useApiHeaders();
  const isVisible = usePageVisibility();
  const { activeTab = 'overview', enabled = true } = options;

  const isActiveTab = activeTab === 'operations';
  const shouldPoll = isVisible && isActiveTab && isAdmin;

  return useQuery({
    queryKey: ['dashboard', 'memory'] as const,
    queryFn: async () => {
      try {
        return await fetchDashboardData('/api/dashboard/memory', getHeaders());
      } catch (error) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') {
          logout();
          throw error;
        }
        throw error;
      }
    },
    enabled: enabled && isAdmin && isActiveTab,
    refetchInterval: shouldPoll ? POLLING_INTERVALS.SYSTEM : false,
    refetchIntervalInBackground: false,
  });
}

/**
 * Users data - user stats, activity (admin only)
 * Polls every 30s when users tab is active
 */
export function useDashboardUsers(options: DashboardQueryOptions = {}) {
  const { isAdmin, logout, adminKey } = useAdmin();
  const getHeaders = useApiHeaders();
  const isVisible = usePageVisibility();
  const { activeTab = 'overview', enabled = true } = options;

  const isActiveTab = activeTab === 'users';
  // Users is admin-only
  const shouldPoll = isVisible && isActiveTab && isAdmin;

  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.users,
    queryFn: async () => {
      try {
        return await fetchDashboardData('/api/dashboard/users', getHeaders());
      } catch (error) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') {
          logout();
          throw error;
        }
        throw error;
      }
    },
    // Only fetch when users tab is active
    enabled: enabled && isAdmin && isActiveTab,
    refetchInterval: shouldPoll ? POLLING_INTERVALS.USERS : false,
    refetchIntervalInBackground: false,
  });
}

export interface HeatmapData {
  grid: number[][];
  peak: number;
}

export function useDashboardHeatmap(options: DashboardQueryOptions & { days?: number } = {}) {
  const { isAdmin, logout, adminKey } = useAdmin();
  const getHeaders = useApiHeaders();
  const { activeTab = 'overview', enabled = true, days = 7 } = options;

  const isActiveTab = activeTab === 'users';

  return useQuery({
    queryKey: [...DASHBOARD_QUERY_KEYS.users, 'heatmap', days] as const,
    queryFn: async () => {
      try {
        return await fetchDashboardData<HeatmapData>(appendTz(`/api/dashboard/users/heatmap?days=${days}`), getHeaders());
      } catch (error) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') {
          logout();
          throw error;
        }
        throw error;
      }
    },
    enabled: enabled && isAdmin && isActiveTab,
    refetchInterval: false,
    refetchIntervalInBackground: false,
  });
}

/**
 * Logs data - live log stream with cursor-based polling (admin only)
 * Polls every 2s when logs tab is active, appends new entries
 */
export interface LogEntry {
  id: number;
  timestamp: string;
  level: number;
  levelLabel: string;
  tag: string;
  message: string;
  args?: string;
  userId?: string;
  service?: string;
}

export interface LogsData {
  entries: LogEntry[];
  cursor: number;
  tags: string[];
  services: string[];
  newestId?: number;
}

export function useDashboardLogs(
  options: DashboardQueryOptions & { paused?: boolean; filters?: LogStreamFilters } = {}
) {
  const { isAdmin, logout, adminKey, logViewerMaxEntries } = useAdmin();
  const getHeaders = useApiHeaders();
  const isVisible = usePageVisibility();
  const { activeTab = 'overview', enabled = true, paused = false, filters } = options;
  const maxEntries = logViewerMaxEntries > 0 ? logViewerMaxEntries : DEFAULT_MAX_CLIENT_LOG_ENTRIES;

  // Serialised so the effect re-runs on a real change, not on a new object.
  const filterQuery = useMemo(() => {
    const params = new URLSearchParams();
    for (const key of ['level', 'tag', 'service', 'search'] as const) {
      const value = (filters?.[key] || '').trim();
      if (value) params.set(key, value);
    }
    return params.toString();
    // Keyed on the fields, not the object: an inline literal from a caller would
    // otherwise reconnect the stream on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters?.level, filters?.tag, filters?.service, filters?.search]);

  const isActiveTab = activeTab === 'logs';
  const shouldStream = isVisible && isActiveTab && isAdmin && enabled && !paused;

  const cursorRef = useRef(0);
  const [accumulated, setAccumulated] = useState<LogsData>({ entries: [], cursor: 0, tags: [], services: [] });

  const [isFetching, setIsFetching] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  // A changed filter is a different question, so the tail collected under the old
  // one is dropped and the stream replays matching history from the whole buffer.
  // Declared before the stream effect so the reset lands before the reconnect.
  useEffect(() => {
    cursorRef.current = 0;
    setAccumulated(prev => ({ entries: [], cursor: 0, tags: prev.tags, services: prev.services }));
  }, [filterQuery]);

  // Pure SSE: the stream replays buffered history after our cursor (gapless on
  // connect/reconnect, since the server hands off backfill->live atomically), then
  // pushes live entries. No companion poll. EventSource can't send the x-admin-key
  // header, so we read a fetch stream; reconnect resumes from the last cursor.
  useEffect(() => {
    if (!shouldStream) return;
    const controller = new AbortController();
    let cancelled = false;
    let buf = '';
    setIsFetching(true);

    (async () => {
      try {
        const url = `/api/dashboard/logs/stream?afterCursor=${cursorRef.current}`
          + (filterQuery ? `&${filterQuery}` : '');
        const res = await fetch(url, {
          headers: getHeaders(),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          if (res.status === 401) logout();
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split('\n\n');
          buf = frames.pop() || '';
          const incoming: LogEntry[] = [];
          for (const frame of frames) {
            if (frame.startsWith(':')) continue;                 // heartbeat comment
            if (frame.includes('event: ready')) { setIsFetching(false); continue; }
            const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            const json = dataLine.slice(5).trim();
            if (!json) continue;
            try {
              const entry = JSON.parse(json) as LogEntry;
              if (typeof entry.id === 'number' && entry.id > cursorRef.current) incoming.push(entry);
            } catch { /* ignore malformed frame */ }
          }
          if (incoming.length > 0) {
            cursorRef.current = incoming[incoming.length - 1].id;
            setAccumulated((prev) => {
              const combined = [...prev.entries, ...incoming];
              const entries = combined.length > maxEntries ? combined.slice(-maxEntries) : combined;
              let tags = prev.tags;
              let tagAdds: Set<string> | null = null;
              let services = prev.services;
              let serviceAdds: Set<string> | null = null;
              for (const e of incoming) {
                if (e.tag && !tags.includes(e.tag)) (tagAdds ??= new Set(tags)).add(e.tag);
                const svc = e.service || 'addon';
                if (!services.includes(svc)) (serviceAdds ??= new Set(services)).add(svc);
              }
              if (tagAdds) tags = Array.from(tagAdds).sort();
              if (serviceAdds) services = Array.from(serviceAdds).sort();
              return { entries, cursor: cursorRef.current, tags, services, newestId: cursorRef.current };
            });
          }
        }
      } catch {
        // aborted on cleanup, or the connection dropped
      } finally {
        if (!cancelled) {
          setIsFetching(false);
          // auto-reconnect; resumes from cursorRef so the server replays the gap
          setTimeout(() => { if (!cancelled) setRetryCount((c) => c + 1); }, 2000);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldStream, adminKey, getHeaders, retryCount, filterQuery, maxEntries]);

  const resetLogs = useCallback(() => {
    setAccumulated(prev => ({ entries: [], cursor: prev.cursor, tags: prev.tags, services: prev.services }));
  }, []);

  const refetch = useCallback(() => {
    setRetryCount((c) => c + 1);
  }, []);

  return { data: accumulated, isFetching, refetch, resetLogs, isLoading: false, isError: false, error: null };
}

// ============================================================================
// Mutation Hooks
// ============================================================================

/**
 * Clear cache mutation
 */
export function useClearCache() {
  const { adminKey, logout } = useAdmin();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (type: 'all' | 'expired' | 'metadata') => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch('/api/dashboard/cache/clear', {
        method: 'POST',
        headers,
        body: JSON.stringify({ type }),
      });

      if (response.status === 401) {
        logout();
        throw new Error('Session expired. Please log in again.');
      }

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to clear cache');
      }

      return response.json();
    },
    onSuccess: () => {
      // Invalidate operations query to refresh cache stats
      queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEYS.operations });
      queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEYS.overview });
    },
  });
}

export interface ClearCacheByIdResult {
  success: boolean;
  dryRun: boolean;
  token: string;
  matched: number;
  deletedCount: number;
  skipped: number;
  samples: string[];
  message: string;
}

export function useClearCacheById() {
  const { adminKey, logout } = useAdmin();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ token, dryRun, includeColdStore }: { token: string; dryRun?: boolean; includeColdStore?: boolean }): Promise<ClearCacheByIdResult> => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch('/api/dashboard/cache/clear-by-id', {
        method: 'POST',
        headers,
        body: JSON.stringify({ token, dryRun: !!dryRun, includeColdStore: includeColdStore !== false }),
      });

      if (response.status === 401) {
        logout();
        throw new Error('Session expired. Please log in again.');
      }

      const data = await response.json();
      if (!response.ok || data.success === false) {
        throw new Error(data.message || data.error || 'Failed to clear cache entries');
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data.dryRun) {
        queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEYS.operations });
        queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEYS.overview });
      }
    },
  });
}

/**
 * Execute maintenance task mutation
 */
export function useExecuteMaintenanceTask() {
  const { adminKey, logout } = useAdmin();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ taskId, action }: { taskId: number; action: string }) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch('/api/dashboard/maintenance/execute', {
        method: 'POST',
        headers,
        body: JSON.stringify({ taskId, action }),
      });

      if (response.status === 401) {
        logout();
        throw new Error('Session expired. Please log in again.');
      }

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return response.json();
    },
    onSuccess: () => {
      // Invalidate operations query to refresh maintenance tasks
      queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEYS.operations });
    },
  });
}

/**
 * Clear error logs mutation
 */
export function useClearErrorLogs() {
  const { adminKey, logout } = useAdmin();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch('/api/dashboard/errors/clear', {
        method: 'POST',
        headers,
      });

      if (response.status === 401) {
        logout();
        throw new Error('Session expired. Please log in again.');
      }

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to clear errors');
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEYS.operations });
    },
  });
}

/**
 * Purge poster cache mutation
 */
export function usePurgePosterCache() {
  const { adminKey, logout } = useAdmin();
  const queryClient = useQueryClient();

  return useMutation({
    // A string is an image class, which is what the per-type and "Clear all"
    // buttons send. `{ domain }` purges one provider across every class instead,
    // because a provider's art spans poster, background, logo and processed.
    mutationFn: async (target?: string | { domain: string }) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      let body: Record<string, string> = {};
      if (typeof target === 'string') body = { type: target };
      else if (target?.domain) body = { domain: target.domain };

      const response = await fetch('/api/dashboard/poster-cache/purge', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (response.status === 401) {
        logout();
        throw new Error('Session expired. Please log in again.');
      }

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to purge poster cache');
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['poster-cache-stats'] });
    },
  });
}

/** A rule as stored in POSTER_CACHE_PROVIDER_POLICIES. */
export interface ProviderPolicyRule {
  domain: string;
  policy: 'default' | 'infer' | 'custom' | 'bypass';
  /** Only for `custom`, and kept verbatim so editing cannot quietly rewrite it. */
  ttl?: string;
}

/**
 * Drop a single image from the cache so it is re-fetched on the next request.
 * Accepts either the upstream URL or a /poster-cache/... URL.
 */
export function useInvalidateCachedImage() {
  const { adminKey, logout } = useAdmin();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (url: string) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch('/api/dashboard/poster-cache/invalidate', {
        method: 'POST',
        headers,
        body: JSON.stringify({ url }),
      });

      if (response.status === 401) {
        logout();
        throw new Error('Session expired. Please log in again.');
      }

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Failed to refresh image');
      }
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['poster-cache-stats'] });
    },
  });
}

export interface ClearArtByIdResult {
  id: string;
  removed: number;
  freed_bytes: number;
  clearedByClass: Record<string, number>;
  searchability: {
    total: number;
    searchable: number;
    unsearchable: number;
    unsearchableByClass: Record<string, number>;
  };
}

export function useClearArtById() {
  const { adminKey, logout } = useAdmin();
  const queryClient = useQueryClient();

  return useMutation<ClearArtByIdResult, Error, string>({
    mutationFn: async (id: string) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch('/api/dashboard/poster-cache/invalidate-by-id', {
        method: 'POST',
        headers,
        body: JSON.stringify({ id }),
      });

      if (response.status === 401) {
        logout();
        throw new Error('Session expired. Please log in again.');
      }

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Failed to clear art for that ID');
      }
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['poster-cache-stats'] });
    },
  });
}

export interface ColdStoreTierStats {
  tier: string;
  count: number;
  titles: number;
  bytes: number;
}

export interface ColdStoreStats {
  /** True once the SQLite handle is open (i.e. the feature booted). */
  enabled: boolean;
  /** True when META_COLD_STORE_ENABLED is set, even before init. */
  configured: boolean;
  rows: number;
  titles: number;
  bytes: number;
  maxBytes: number;
  tiers: ColdStoreTierStats[];
  oldestCreatedAt: number | null;
  nextExpiryAt: number | null;
  expiredRows: number;
  /** Lookups served from disk. */
  hits: number;
  /** Lookups that fell through to the origin provider. */
  misses: number;
  /** Individual components handed back across all hits. */
  componentsServed: number;
}

/**
 * Meta cold store stats. Unlike the poster cache this always resolves — a
 * disabled store reports `configured: false` so the panel can explain itself
 * rather than render an error.
 */
export function useColdStoreStats(options: DashboardQueryOptions = {}) {
  const { isAdmin, adminKey } = useAdmin();
  const isVisible = usePageVisibility();
  const { activeTab = 'overview', enabled = true } = options;

  const isActiveTab = activeTab === 'operations';
  const shouldPoll = isVisible && isActiveTab && isAdmin;

  return useQuery<ColdStoreStats | null>({
    queryKey: ['cold-store-stats'],
    queryFn: async () => {
      const headers: Record<string, string> = {};
      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch('/api/dashboard/cold-store/stats', { headers });
      if (!response.ok) return null;
      return response.json();
    },
    enabled: enabled && isAdmin && isActiveTab,
    refetchInterval: shouldPoll ? POLLING_INTERVALS.COLD_STORE : false,
    refetchIntervalInBackground: false,
  });
}

/**
 * Drop cold-store rows. Passing a metaId drops just that title; omitting it
 * drops the whole store.
 */
export function usePurgeColdStore() {
  const { adminKey, logout } = useAdmin();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (args?: string | { metaId?: string; includeRedis?: boolean }) => {
      const { metaId, includeRedis } = typeof args === 'string' ? { metaId: args, includeRedis: undefined } : (args || {});
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch('/api/dashboard/cold-store/purge', {
        method: 'POST',
        headers,
        body: JSON.stringify(metaId ? { metaId, includeRedis: includeRedis !== false } : {}),
      });

      if (response.status === 401) {
        logout();
        throw new Error('Session expired. Please log in again.');
      }

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Failed to purge cold store');
      }
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cold-store-stats'] });
      // May also have cleared Redis keys, so refresh the cache stats alongside.
      queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEYS.operations });
    },
  });
}

/** Drop expired and inactive rows now instead of waiting for the hourly sweep. */
export function useSweepColdStore() {
  const { adminKey, logout } = useAdmin();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch('/api/dashboard/cold-store/sweep', { method: 'POST', headers });

      if (response.status === 401) {
        logout();
        throw new Error('Session expired. Please log in again.');
      }

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Failed to sweep cold store');
      }
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cold-store-stats'] });
    },
  });
}

/**
 * Fetch poster cache stats
 */
export function usePosterCacheStats(options: DashboardQueryOptions = {}) {
  const { isAdmin, adminKey } = useAdmin();
  const isVisible = usePageVisibility();
  const { activeTab = 'overview', enabled = true } = options;

  const isActiveTab = activeTab === 'operations';
  const shouldPoll = isVisible && isActiveTab && isAdmin;

  return useQuery({
    queryKey: ['poster-cache-stats'],
    queryFn: async () => {
      const headers: Record<string, string> = {};
      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch('/api/dashboard/poster-cache/stats', { headers });
      if (!response.ok) return null;
      return response.json();
    },
    enabled: enabled && isAdmin && isActiveTab,
    refetchInterval: shouldPoll ? POLLING_INTERVALS.OPERATIONS : false,
    refetchIntervalInBackground: false,
  });
}

/**
 * Clear user data mutation
 */
export function useClearUserData() {
  const { adminKey, logout } = useAdmin();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch('/api/dashboard/users/clear', {
        method: 'POST',
        headers,
      });

      if (response.status === 401) {
        logout();
        throw new Error('Session expired. Please log in again.');
      }

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEYS.users });
      queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEYS.overview });
    },
  });
}

// ============================================================================
// Settings Hooks
// ============================================================================

export interface SettingItem {
  key: string;
  label: string;
  description: string;
  category: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  default: string | number | boolean;
  options?: string[];
  sensitive: boolean;
  requiresRestart: boolean;
  envOnly: boolean;
  uiHint: 'tags' | null;
  maxTags: number | null;
  min: number | null;
  max: number | null;
  value: string;
  hasEnvVar: boolean;
  hasDbOverride: boolean;
  disabledReason: string | null;
  changedSinceBoot: boolean;
}

export function useDashboardSettings(options: DashboardQueryOptions = {}) {
  const { isAdmin, adminKey, logout } = useAdmin();
  const getHeaders = useApiHeaders();
  const { activeTab = 'settings', enabled = true } = options;

  return useQuery<{ settings: SettingItem[]; canRestart?: boolean }>({
    queryKey: DASHBOARD_QUERY_KEYS.settings,
    queryFn: async () => {
      try {
        return await fetchDashboardData('/api/dashboard/settings', getHeaders());
      } catch (error) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') {
          logout();
        }
        throw error;
      }
    },
    enabled: enabled && isAdmin && activeTab === 'settings',
    staleTime: 30 * 1000,
  });
}

export function useUpdateSetting() {
  const { adminKey, logout } = useAdmin();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ key, value, confirm }: { key: string; value: string; confirm?: boolean }) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminKey) headers['x-admin-key'] = adminKey;

      const response = await fetch(`/api/dashboard/settings/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(confirm ? { value, confirm: true } : { value }),
      });

      if (response.status === 401) { logout(); throw new Error('Session expired.'); }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const err: any = new Error(data.error || `HTTP ${response.status}`);
        err.requiresConfirmation = data.requiresConfirmation === true;
        err.reason = data.reason;
        throw err;
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEYS.settings });
    },
  });
}

export interface AccountRow {
  accountId: string;
  issuer: string;
  subject: string;
  username: string;
  email: string | null;
  /** Null until the account signs in again, which is when groups are recorded. */
  groups: string[] | null;
  permissionsKnown: boolean;
  permissions: string[] | null;
  blocked: boolean;
  createdAt: string;
  lastSeenAt: string;
  activeSessions: number;
}

export type SigninFailureReason =
  | 'refused'
  | 'blocked'
  | 'rate-limited'
  | 'browser-mismatch'
  | 'expired'
  | 'provider-error';

export interface SigninFailure {
  id: string;
  at: string;
  reason: SigninFailureReason;
  username: string | null;
  subject: string | null;
  issuer: string | null;
  groups: string[] | null;
  groupsClaim: string | null;
  address: string | null;
  detail: string | null;
}

export interface AccountConfigRow {
  userUUID: string;
  label: string;
  linkedAt: string;
  lastOpenedAt: string | null;
}

export function useDashboardAccounts(options: DashboardQueryOptions = {}) {
  const { isAdmin, logout } = useAdmin();
  const getHeaders = useApiHeaders();
  const isVisible = usePageVisibility();
  const { activeTab = 'overview', enabled = true } = options;

  const isActiveTab = activeTab === 'users';
  const shouldPoll = isVisible && isActiveTab && isAdmin;

  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.accounts,
    queryFn: async () => {
      try {
        return await fetchDashboardData<{ accounts: AccountRow[]; groupsClaim: string; mappingReadable: boolean }>('/api/auth/accounts', getHeaders());
      } catch (error) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') {
          logout();
          throw error;
        }
        throw error;
      }
    },
    enabled: enabled && isAdmin && isActiveTab,
    refetchInterval: shouldPoll ? POLLING_INTERVALS.ACCOUNTS : false,
    refetchIntervalInBackground: false,
  });
}

export function useAccountConfigs(accountId: string | null) {
  const getHeaders = useApiHeaders();

  return useQuery({
    queryKey: ['dashboard', 'accounts', accountId, 'configs'] as const,
    queryFn: async () =>
      fetchDashboardData<{ configs: AccountConfigRow[] }>(`/api/auth/accounts/${encodeURIComponent(accountId as string)}/configs`, getHeaders()),
    enabled: Boolean(accountId),
  });
}

export function useSigninFailures(options: DashboardQueryOptions = {}) {
  const { isAdmin } = useAdmin();
  const getHeaders = useApiHeaders();
  const isVisible = usePageVisibility();
  const { activeTab = 'overview', enabled = true } = options;

  const isActiveTab = activeTab === 'users';

  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.signinFailures,
    queryFn: async () =>
      fetchDashboardData<{ failures: SigninFailure[] }>('/api/auth/signin-failures', getHeaders()),
    enabled: enabled && isAdmin && isActiveTab,
    refetchInterval: isVisible && isActiveTab && isAdmin ? POLLING_INTERVALS.ACCOUNTS : false,
    refetchIntervalInBackground: false,
  });
}

export function useClearSigninFailures() {
  const { adminKey, logout } = useAdmin();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminKey) headers['x-admin-key'] = adminKey;

      const response = await fetch('/api/auth/signin-failures', { method: 'DELETE', headers });
      if (response.status === 401) { logout(); throw new Error('Session expired.'); }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEYS.signinFailures });
    },
  });
}

export function useSetAccountBlocked() {
  const { adminKey, logout } = useAdmin();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ accountId, blocked }: { accountId: string; blocked: boolean }) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminKey) headers['x-admin-key'] = adminKey;

      const response = await fetch(`/api/auth/accounts/${encodeURIComponent(accountId)}/block`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ blocked }),
      });
      if (response.status === 401) { logout(); throw new Error('Session expired.'); }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEYS.accounts });
    },
  });
}

export function useRevokeAccountSessions() {
  const { adminKey, logout } = useAdmin();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (accountId: string) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminKey) headers['x-admin-key'] = adminKey;

      const response = await fetch(`/api/auth/accounts/${encodeURIComponent(accountId)}/revoke`, { method: 'POST', headers });
      if (response.status === 401) { logout(); throw new Error('Session expired.'); }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEYS.accounts });
    },
  });
}

export function useDeleteAccount() {
  const { adminKey, logout } = useAdmin();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ accountId, confirm }: { accountId: string; confirm?: boolean }) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminKey) headers['x-admin-key'] = adminKey;

      const url = `/api/auth/accounts/${encodeURIComponent(accountId)}${confirm ? '?confirm=true' : ''}`;
      const response = await fetch(url, { method: 'DELETE', headers });
      if (response.status === 401) { logout(); throw new Error('Session expired.'); }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEYS.accounts });
    },
  });
}

export function useRestartServer() {
  const { adminKey, logout } = useAdmin();

  return useMutation({
    mutationFn: async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminKey) headers['x-admin-key'] = adminKey;

      const response = await fetch('/api/dashboard/restart', {
        method: 'POST',
        headers,
      });

      if (response.status === 401) { logout(); throw new Error('Session expired.'); }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      return response.json();
    },
  });
}

export function useResetSetting() {
  const { adminKey, logout } = useAdmin();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ key, confirm }: { key: string; confirm?: boolean }) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminKey) headers['x-admin-key'] = adminKey;

      const response = await fetch(`/api/dashboard/settings/reset/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(confirm ? { confirm: true } : {}),
      });

      if (response.status === 401) { logout(); throw new Error('Session expired.'); }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const err: any = new Error(data.error || `HTTP ${response.status}`);
        err.requiresConfirmation = data.requiresConfirmation === true;
        err.reason = data.reason;
        throw err;
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEYS.settings });
    },
  });
}


export interface SettingsImportResult {
  imported: string[];
  skipped: { key: string; reason: string }[];
  failed: { key: string; reason: string }[];
  requiresRestart: boolean;
}

/** Downloads every setting saved from the dashboard, secrets blanked. */
export function useExportSettings() {
  const { adminKey, logout } = useAdmin();

  return useMutation({
    mutationFn: async () => {
      const headers: Record<string, string> = {};
      if (adminKey) headers['x-admin-key'] = adminKey;
      const response = await fetch('/api/dashboard/settings/export', { headers });
      if (response.status === 401) { logout(); throw new Error('Session expired.'); }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `aiometadata-settings-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      return payload as { settings: Record<string, string | null>; maskedSecretKeys: string[] };
    },
  });
}

export function useImportSettings() {
  const { adminKey, logout } = useAdmin();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (settings: Record<string, unknown>): Promise<SettingsImportResult> => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminKey) headers['x-admin-key'] = adminKey;
      const response = await fetch('/api/dashboard/settings/import', {
        method: 'POST',
        headers,
        body: JSON.stringify({ settings }),
      });
      if (response.status === 401) { logout(); throw new Error('Session expired.'); }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEYS.settings });
    },
  });
}

export interface JellyfinSessionRow {
  profile: string;
  profileKey: string;
  viewer: string | null;
  imageUrl: string | null;
  backdropUrl: string | null;
  title: string;
  episode: string | null;
  positionMs: number;
  runtimeMs: number;
  paused: boolean;
  at: number;
}

export interface JellyfinPlayRow {
  profile: string;
  videoId: string;
  imageUrl: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  title: string;
  episode: string | null;
  seriesId: string | null;
  season: number | null;
  number: number | null;
  episodeTitle: string | null;
  positionMs: number;
  runtimeMs: number;
  played: boolean;
  lastPlayedAt: number | null;
  watchedAt: number | null;
  rewatch: boolean;
  updatedAt: number;
}

export interface JellyfinOverview {
  playedDay: number;
  playedWeek: number;
  activeConfigurations: number | null;
  activeDays: number;
  playingNow: number;
  pausedNow: number;
  sessions: number;
  sync: { startedAt: number; finishedAt: number; configurations: number; added: number; running: boolean };
}

export interface JellyfinSearchRow {
  userUUID: string;
  label: string;
  profiles: Array<{ key: string; name: string }>;
  lastActivity: number | null;
}

export interface JellyfinProfileSummary {
  key: string;
  name: string;
  avatar: string | null;
  sharedWith: string[];
  inProgress: number;
  played: number;
  movies: number;
  episodes: number;
  days: Record<string, number>;
  lastActivity: number | null;
}

export interface JellyfinSyncRow {
  service: string;
  profiles: string[];
  syncedAt: number | null;
  fullAt: number | null;
  imported: boolean;
  pending: number;
  oldestPendingAt: number | null;
  attempts: number;
  lastError: string | null;
}

export interface JellyfinConfiguration {
  userUUID: string;
  label: string;
  profile: string | null;
  history: string | null;
  profiles: JellyfinProfileSummary[];
  viewers: Array<{ key: string; name: string; avatar: string | null; historyKey: string }>;
  sync: JellyfinSyncRow[];
  sessions: JellyfinSessionRow[];
  rows: number;
  inProgress: JellyfinPlayRow[];
  recentlyPlayed: JellyfinPlayRow[];
  totals: { progress: number; played: number };
}

function useJellyfinQuery<T>(key: readonly unknown[], path: string, options: DashboardQueryOptions & { enabledWhen?: boolean; poll?: boolean } = {}) {
  const { isAdmin, logout } = useAdmin();
  const getHeaders = useApiHeaders();
  const isVisible = usePageVisibility();
  const { activeTab = 'overview', enabled = true, enabledWhen = true, poll = true } = options;
  const isActiveTab = activeTab === 'jellyfin';

  return useQuery({
    queryKey: key,
    queryFn: async () => {
      try {
        return await fetchDashboardData<T>(path, getHeaders());
      } catch (error) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') logout();
        throw error;
      }
    },
    enabled: enabled && enabledWhen && isAdmin && isActiveTab,
    refetchInterval: poll && isVisible && isActiveTab && isAdmin ? POLLING_INTERVALS.JELLYFIN : false,
    refetchIntervalInBackground: false,
    placeholderData: (previous) => previous,
  });
}

export function useJellyfinOverview(options: DashboardQueryOptions = {}) {
  return useJellyfinQuery<JellyfinOverview>(DASHBOARD_QUERY_KEYS.jellyfin, '/api/dashboard/jellyfin', options);
}

export function useJellyfinSearch(query: string, options: DashboardQueryOptions = {}) {
  return useJellyfinQuery<{ query: string; results: JellyfinSearchRow[] }>(
    ['dashboard', 'jellyfin', 'search', query] as const,
    `/api/dashboard/jellyfin/search?q=${encodeURIComponent(query)}`,
    { ...options, enabledWhen: query.length > 0, poll: false }
  );
}

export function useJellyfinConfiguration(userUUID: string | null, profile: string | null, rows: number | null, options: DashboardQueryOptions = {}) {
  const params = new URLSearchParams();
  if (profile !== null) params.set('profile', profile);
  if (rows !== null) params.set('rows', String(rows));
  params.set('tz', String(new Date().getTimezoneOffset()));
  const suffix = params.toString() ? `?${params}` : '';
  return useJellyfinQuery<JellyfinConfiguration>(
    ['dashboard', 'jellyfin', 'configuration', userUUID, profile, rows] as const,
    `/api/dashboard/jellyfin/${encodeURIComponent(userUUID ?? '')}${suffix}`,
    { ...options, enabledWhen: Boolean(userUUID) }
  );
}

export interface JellyfinEpisodeRef {
  season: number | null;
  number: number | null;
  name?: string | null;
}

export interface JellyfinShowRow {
  metaId: string;
  title: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  source: string;
  lastWatchedAt: number | null;
  outcome: string;
  next: JellyfinEpisodeRef | null;
  from: JellyfinEpisodeRef | null;
  last: JellyfinEpisodeRef | null;
  airsAt: number | null;
  episodes: number | null;
  watched: number | null;
  total: number | null;
}

export function useJellyfinShows(userUUID: string | null, profile: string | null, fresh: number, options: DashboardQueryOptions = {}) {
  const params = new URLSearchParams();
  if (profile !== null) params.set('profile', profile);
  if (fresh) params.set('fresh', '1');
  const suffix = params.toString() ? `?${params}` : '';
  return useJellyfinQuery<{ rows: JellyfinShowRow[]; ms: number }>(
    ['dashboard', 'jellyfin', 'shows', userUUID, profile, fresh] as const,
    `/api/dashboard/jellyfin/${encodeURIComponent(userUUID ?? '')}/shows${suffix}`,
    { ...options, enabledWhen: Boolean(userUUID), poll: false }
  );
}

export interface JellyfinCalendarRow {
  id: string;
  seriesId: string | null;
  seriesName: string;
  name: string | null;
  season: number | null;
  number: number | null;
  premiereDate: string | null;
  played: boolean;
  still: string | null;
  thumb: string | null;
  backdrop: string | null;
  logo: string | null;
}

const CALENDAR_DAY_MS = 24 * 60 * 60 * 1000;

export function useJellyfinCalendar(userUUID: string | null, profile: string | null, start: Date, days: number, options: DashboardQueryOptions = {}) {
  const params = new URLSearchParams();
  if (profile !== null) params.set('profile', profile);
  params.set('from', String(start.getTime() - CALENDAR_DAY_MS));
  params.set('to', String(start.getTime() + (days + 1) * CALENDAR_DAY_MS));
  return useJellyfinQuery<{ rows: JellyfinCalendarRow[] }>(
    ['dashboard', 'jellyfin', 'calendar', userUUID, profile, start.getTime(), days] as const,
    `/api/dashboard/jellyfin/${encodeURIComponent(userUUID ?? '')}/calendar?${params}`,
    { ...options, enabledWhen: Boolean(userUUID), poll: false }
  );
}

export interface JellyfinLibraryRow {
  metaId: string;
  type: 'movie' | 'series';
  title: string;
  year: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  logoUrl: string | null;
  overview: string | null;
  score: string | null;
  genres: string[];
  at: number | null;
  rating: number | null;
}

export type JellyfinLibraryTab = 'watchlist' | 'ratings' | 'dropped';

export type JellyfinLibraryKind = 'all' | 'movie' | 'series';

export interface JellyfinLibrary {
  tab: JellyfinLibraryTab;
  kind: JellyfinLibraryKind;
  offset: number;
  total: number;
  kinds: { movie: number; series: number };
  counts: Record<JellyfinLibraryTab, number>;
  sources: string[];
  complete: boolean;
  rows: JellyfinLibraryRow[];
}

export const JELLYFIN_LIBRARY_PAGE = 48;

export function useJellyfinLibrary(userUUID: string | null, profile: string | null, tab: JellyfinLibraryTab, kind: JellyfinLibraryKind, offset: number, options: DashboardQueryOptions = {}) {
  const params = new URLSearchParams({ tab, kind, offset: String(offset), limit: String(JELLYFIN_LIBRARY_PAGE) });
  if (profile !== null) params.set('profile', profile);
  return useJellyfinQuery<JellyfinLibrary>(
    ['dashboard', 'jellyfin', 'library', userUUID, profile, tab, kind, offset] as const,
    `/api/dashboard/jellyfin/${encodeURIComponent(userUUID ?? '')}/library?${params}`,
    { ...options, enabledWhen: Boolean(userUUID), poll: false }
  );
}

export function useJellyfinUndrop() {
  const getHeaders = useApiHeaders();
  return async (userUUID: string, profile: string | null, metaId: string): Promise<boolean> => {
    const response = await fetch(`/api/dashboard/jellyfin/${encodeURIComponent(userUUID)}/library/undrop`, {
      method: 'POST',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ metaId, profile: profile ?? undefined }),
    });
    if (!response.ok) throw new Error(`Could not pick it back up (${response.status})`);
    return Boolean((await response.json())?.undropped);
  };
}

export interface JellyfinTitleEpisode {
  id: string;
  season: number | null;
  number: number | null;
  name: string | null;
  overview: string | null;
  airsAt: number | null;
  runtimeMs: number;
  still: string | null;
  played: boolean;
  playCount: number;
  lastPlayedAt: number | null;
  positionMs: number;
}

export interface JellyfinTitle {
  id: string;
  metaId: string;
  type: 'movie' | 'series';
  title: string;
  year: string | null;
  overview: string | null;
  genres: string[];
  score: string | null;
  runtime: string | null;
  status: 'Continuing' | 'Ended' | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  logoUrl: string | null;
  ids: { imdb: string | null; tmdb: string | number | null; tvdb: string | number | null };
  onWatchlist: boolean;
  dropped: boolean;
  rating: number | null;
  played: boolean;
  playCount: number;
  lastPlayedAt: number | null;
  positionMs: number;
  episodes: JellyfinTitleEpisode[];
  seasons: Array<{ season: number; id: string; name: string | null; tag: string | null; poster: string | null; count: number }>;
  people: JellyfinTitlePerson[];
  watched: number;
  aired: number;
}

export interface JellyfinTitlePerson {
  id: string;
  name: string;
  role: string | null;
  type: string;
  photo: string | null;
}

export type JellyfinPersonRole = 'all' | 'Actor' | 'Director' | 'Writer' | 'Producer' | 'Composer';

export interface JellyfinPerson {
  id: string;
  name: string;
  overview: string | null;
  born: string | null;
  died: string | null;
  birthplace: string | null;
  knownFor: string | null;
  photo: string | null;
  credits: Array<{ type: 'movie' | 'series'; year: number | null; roles: string[] }>;
}

export interface JellyfinPersonTitle {
  id: string;
  type: 'movie' | 'series';
  title: string;
  year: number | null;
  posterUrl: string | null;
  played: boolean;
  progress: number;
}

export const JELLYFIN_PERSON_PAGE = 40;

export function useJellyfinPerson(userUUID: string | null, profile: string | null, personId: string | null, options: DashboardQueryOptions = {}) {
  const params = new URLSearchParams({ item: personId ?? '' });
  if (profile !== null) params.set('profile', profile);
  return useJellyfinQuery<JellyfinPerson>(
    ['dashboard', 'jellyfin', 'person', userUUID, profile, personId] as const,
    `/api/dashboard/jellyfin/${encodeURIComponent(userUUID ?? '')}/person?${params}`,
    { ...options, enabledWhen: Boolean(userUUID && personId), poll: false }
  );
}

export function useJellyfinPersonTitles(userUUID: string | null, profile: string | null, personId: string | null, kind: JellyfinLibraryKind, role: JellyfinPersonRole, order: 'newest' | 'oldest', offset: number, options: DashboardQueryOptions & { enabledWhen?: boolean } = {}) {
  const params = new URLSearchParams({ item: personId ?? '', kind, role, order, offset: String(offset), limit: String(JELLYFIN_PERSON_PAGE) });
  if (profile !== null) params.set('profile', profile);
  return useJellyfinQuery<{ offset: number; total: number; rows: JellyfinPersonTitle[] }>(
    ['dashboard', 'jellyfin', 'person-titles', userUUID, profile, personId, kind, role, order, offset] as const,
    `/api/dashboard/jellyfin/${encodeURIComponent(userUUID ?? '')}/person/titles?${params}`,
    { ...options, enabledWhen: Boolean(userUUID && personId) && options.enabledWhen !== false, poll: false }
  );
}

export type JellyfinTitleRef = { item: string } | { id: string; type: 'movie' | 'series' };

export function useJellyfinTitle(userUUID: string | null, profile: string | null, ref: JellyfinTitleRef | null, options: DashboardQueryOptions = {}) {
  const params = new URLSearchParams();
  if (profile !== null) params.set('profile', profile);
  if (ref && 'item' in ref) params.set('item', ref.item);
  if (ref && 'id' in ref) { params.set('id', ref.id); params.set('type', ref.type); }
  return useJellyfinQuery<JellyfinTitle>(
    ['dashboard', 'jellyfin', 'title', userUUID, profile, params.toString()] as const,
    `/api/dashboard/jellyfin/${encodeURIComponent(userUUID ?? '')}/title?${params}`,
    { ...options, enabledWhen: Boolean(userUUID && ref), poll: false }
  );
}

export type JellyfinTitleAction = 'played' | 'unplayed' | 'playedUpTo' | 'watchlist' | 'unwatchlist' | 'drop' | 'undrop' | 'rate';

export interface JellyfinFoundTitle {
  id: string;
  type: 'movie' | 'series';
  title: string;
  year: string | null;
  posterUrl: string | null;
}

export interface JellyfinSearchCatalog {
  id: string;
  type: string;
  name: string;
}

export function useJellyfinSearches(userUUID: string | null, profile: string | null, options: DashboardQueryOptions = {}) {
  const params = new URLSearchParams();
  if (profile !== null) params.set('profile', profile);
  return useJellyfinQuery<{ quick: boolean; catalogs: JellyfinSearchCatalog[] }>(
    ['dashboard', 'jellyfin', 'searches', userUUID, profile] as const,
    `/api/dashboard/jellyfin/${encodeURIComponent(userUUID ?? '')}/searches?${params}`,
    { ...options, enabledWhen: Boolean(userUUID), poll: false }
  );
}

export function useJellyfinFind(userUUID: string | null, profile: string | null, query: string, catalog: string | null, options: DashboardQueryOptions = {}) {
  const params = new URLSearchParams({ q: query });
  if (profile !== null) params.set('profile', profile);
  if (catalog) params.set('catalog', catalog);
  return useJellyfinQuery<{ query: string; available: boolean; results: JellyfinFoundTitle[] }>(
    ['dashboard', 'jellyfin', 'find', userUUID, profile, catalog, query] as const,
    `/api/dashboard/jellyfin/${encodeURIComponent(userUUID ?? '')}/find?${params}`,
    { ...options, enabledWhen: Boolean(userUUID) && query.length >= 2, poll: false }
  );
}

export function useJellyfinTitleAction() {
  const getHeaders = useApiHeaders();
  return async (userUUID: string, profile: string | null, action: JellyfinTitleAction, itemIds: string[], rating: number | null = null): Promise<void> => {
    const response = await fetch(`/api/dashboard/jellyfin/${encodeURIComponent(userUUID)}/title/action`, {
      method: 'POST',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, itemIds, profile: profile ?? undefined, rating }),
    });
    if (!response.ok) throw new Error(`Could not save the change (${response.status})`);
  };
}

export interface JellyfinDevice {
  deviceId: string;
  client: string;
  device: string;
  version: string;
  lastSeen: number;
  canOpen: boolean;
  canPlay: boolean;
}

export function useJellyfinDevices(userUUID: string | null, profile: string | null, open: boolean, options: DashboardQueryOptions = {}) {
  const params = new URLSearchParams();
  if (profile !== null) params.set('profile', profile);
  return useJellyfinQuery<{ devices: JellyfinDevice[] }>(
    ['dashboard', 'jellyfin', 'devices', userUUID, profile] as const,
    `/api/dashboard/jellyfin/${encodeURIComponent(userUUID ?? '')}/devices?${params}`,
    { ...options, enabledWhen: Boolean(userUUID) && open }
  );
}

export interface JellyfinOpenOn {
  itemId: string;
  itemType: string;
  itemName: string;
  play: boolean;
}

export function useJellyfinOpenOn() {
  const getHeaders = useApiHeaders();
  return async (userUUID: string, profile: string | null, deviceId: string, target: JellyfinOpenOn): Promise<boolean> => {
    const response = await fetch(`/api/dashboard/jellyfin/${encodeURIComponent(userUUID)}/devices/open`, {
      method: 'POST',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...target, deviceId, profile: profile ?? undefined }),
    });
    if (response.status === 409) return false;
    if (!response.ok) throw new Error(`Could not reach the device (${response.status})`);
    return true;
  };
}

export function useJellyfinShowRefresh() {
  const getHeaders = useApiHeaders();
  return async (userUUID: string, metaId: string): Promise<boolean> => {
    const response = await fetch(`/api/dashboard/jellyfin/${encodeURIComponent(userUUID)}/shows/refresh`, {
      method: 'POST',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ metaId }),
    });
    if (!response.ok) throw new Error(`Refresh failed (${response.status})`);
    return Boolean((await response.json())?.refreshed);
  };
}

export type JellyfinPlayKind = 'progress' | 'played';

export function useJellyfinPlays(userUUID: string | null, profile: string | null, kind: JellyfinPlayKind, offset: number, options: DashboardQueryOptions = {}) {
  const params = new URLSearchParams({ kind, offset: String(offset), limit: '30' });
  if (profile !== null) params.set('profile', profile);
  return useJellyfinQuery<{ kind: JellyfinPlayKind; profile: string | null; offset: number; rows: JellyfinPlayRow[]; done: boolean }>(
    ['dashboard', 'jellyfin', 'plays', userUUID, profile, kind, offset] as const,
    `/api/dashboard/jellyfin/${encodeURIComponent(userUUID ?? '')}/plays?${params}`,
    { ...options, enabledWhen: Boolean(userUUID) && offset > 0, poll: false }
  );
}

export function useJellyfinExport() {
  const getHeaders = useApiHeaders();
  return async (userUUID: string): Promise<void> => {
    const response = await fetch(`/api/dashboard/jellyfin/${encodeURIComponent(userUUID)}/export`, { headers: getHeaders() });
    if (!response.ok) throw new Error(`Export failed (${response.status})`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `jellyfin-playback-${userUUID.slice(0, 8)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };
}
