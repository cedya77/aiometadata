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
  LOGS: 2 * 1000,               // 2 seconds - live log streaming
} as const;

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
}

export interface LogsData {
  entries: LogEntry[];
  cursor: number;
  tags: string[];
  newestId?: number;
}

export function useDashboardLogs(options: DashboardQueryOptions & { paused?: boolean } = {}) {
  const { isAdmin, logout, adminKey } = useAdmin();
  const getHeaders = useApiHeaders();
  const isVisible = usePageVisibility();
  const { activeTab = 'overview', enabled = true, paused = false } = options;

  const isActiveTab = activeTab === 'logs';
  const shouldPoll = isVisible && isActiveTab && isAdmin && !paused;

  const cursorRef = useRef(0);
  const [accumulated, setAccumulated] = useState<LogsData>({ entries: [], cursor: 0, tags: [] });

  const query = useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.logs,
    queryFn: async () => {
      try {
        const params = new URLSearchParams({ afterCursor: String(cursorRef.current), limit: '500' });
        return await fetchDashboardData<LogsData>(`/api/dashboard/logs?${params}`, getHeaders());
      } catch (error) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') {
          logout();
          throw error;
        }
        throw error;
      }
    },
    structuralSharing: false,
    enabled: enabled && isAdmin && !!adminKey && isActiveTab,
    refetchInterval: shouldPoll ? POLLING_INTERVALS.LOGS : false,
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    if (!query.data) return;
    if (typeof query.data.newestId === 'number' && query.data.newestId < cursorRef.current) {
      cursorRef.current = 0;
      setAccumulated({ entries: [], cursor: 0, tags: query.data.tags });
      return;
    }
    if (query.data.entries.length > 0 && query.data.cursor > cursorRef.current) {
      cursorRef.current = query.data.cursor;
      setAccumulated(prev => {
        const combined = [...prev.entries, ...query.data!.entries];
        return { entries: combined, cursor: query.data!.cursor, tags: query.data!.tags };
      });
    } else if (query.data.tags.length > 0) {
      setAccumulated(prev => {
        if (prev.tags.length !== query.data!.tags.length) {
          return { ...prev, tags: query.data!.tags };
        }
        return prev;
      });
    }
  }, [query.data]);

  const resetLogs = useCallback(() => {
    setAccumulated(prev => ({ entries: [], cursor: prev.cursor, tags: prev.tags }));
  }, []);

  return { ...query, data: accumulated, resetLogs };
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
}

export function useDashboardSettings(options: DashboardQueryOptions = {}) {
  const { isAdmin, adminKey, logout } = useAdmin();
  const getHeaders = useApiHeaders();
  const { activeTab = 'settings', enabled = true } = options;

  return useQuery<{ settings: SettingItem[] }>({
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

