import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAdmin } from '@/contexts/AdminContext';
import { useCallback, useEffect, useRef, useState } from 'react';

// ============================================================================
// Types
// ============================================================================

export type DashboardTab = 'overview' | 'analytics' | 'content' | 'performance' | 'system' | 'operations' | 'users' | 'logs' | 'settings';

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
  USERS: 15 * 1000,             // 15 seconds - user activity
  CONTENT: 60 * 1000,           // 60 seconds - slow-changing data
  LOGS: 2 * 1000,               // 2 seconds - live log streaming (backstop for the SSE stream)
} as const;

// Cap client-side log accumulation so a long-open tab can't grow unbounded.
const MAX_CLIENT_LOG_ENTRIES = 10000;

// Query keys for cache management
export const DASHBOARD_QUERY_KEYS = {
  overview: ['dashboard', 'overview'] as const,
  analytics: ['dashboard', 'analytics'] as const,
  content: ['dashboard', 'content'] as const,
  performance: ['dashboard', 'performance'] as const,
  system: ['dashboard', 'system'] as const,
  operations: ['dashboard', 'operations'] as const,
  users: ['dashboard', 'users'] as const,
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
    enabled: enabled && isAdmin && !!adminKey && isActiveTab,
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
    enabled: enabled && isAdmin && !!adminKey && isActiveTab,
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
    enabled: enabled && isAdmin && !!adminKey && isActiveTab,
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
    enabled: enabled && isAdmin && !!adminKey && isActiveTab,
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

export function useDashboardLogs(options: DashboardQueryOptions & { paused?: boolean } = {}) {
  const { isAdmin, logout, adminKey } = useAdmin();
  const getHeaders = useApiHeaders();
  const isVisible = usePageVisibility();
  const { activeTab = 'overview', enabled = true, paused = false } = options;

  const isActiveTab = activeTab === 'logs';
  const shouldStream = isVisible && isActiveTab && isAdmin && !!adminKey && enabled && !paused;

  const cursorRef = useRef(0);
  const [accumulated, setAccumulated] = useState<LogsData>({ entries: [], cursor: 0, tags: [], services: [] });
  const [isFetching, setIsFetching] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

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
        const res = await fetch(`/api/dashboard/logs/stream?afterCursor=${cursorRef.current}`, {
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
              const entries = combined.length > MAX_CLIENT_LOG_ENTRIES ? combined.slice(-MAX_CLIENT_LOG_ENTRIES) : combined;
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
  }, [shouldStream, adminKey, getHeaders, retryCount]);

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

  return useMutation({
    mutationFn: async () => {
      const headers: Record<string, string> = {};
      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch('/api/dashboard/poster-cache/purge', {
        method: 'POST',
        headers,
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
    enabled: enabled && isAdmin && !!adminKey && isActiveTab,
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
    enabled: enabled && isAdmin && !!adminKey && activeTab === 'settings',
    staleTime: 30 * 1000,
  });
}

export function useUpdateSetting() {
  const { adminKey, logout } = useAdmin();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminKey) headers['x-admin-key'] = adminKey;

      const response = await fetch(`/api/dashboard/settings/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ value }),
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
    mutationFn: async (key: string) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminKey) headers['x-admin-key'] = adminKey;

      const response = await fetch(`/api/dashboard/settings/reset/${encodeURIComponent(key)}`, {
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEYS.settings });
    },
  });
}

