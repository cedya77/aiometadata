import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAdmin } from '@/contexts/AdminContext';
import { useCallback, useEffect, useState } from 'react';

// ============================================================================
// Types
// ============================================================================

export type DashboardTab = 'overview' | 'analytics' | 'content' | 'performance' | 'system' | 'operations' | 'users';

interface DashboardQueryOptions {
  activeTab?: DashboardTab;
  enabled?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

// Polling intervals in milliseconds
const POLLING_INTERVALS = {
  OVERVIEW: 5 * 1000,           // 5 seconds - quick stats + health (most visible)
  ANALYTICS: 15 * 1000,         // 15 seconds - metrics data
  PERFORMANCE: 15 * 1000,       // 15 seconds - timing data
  SYSTEM: 10 * 1000,            // 10 seconds - system config + activity
  OPERATIONS: 5 * 1000,         // 5 seconds - warming tasks need fast updates
  USERS: 15 * 1000,             // 15 seconds - user activity
  CONTENT: 60 * 1000,           // 60 seconds - slow-changing data
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
  all: ['dashboard'] as const,
} as const;

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
        return await fetchDashboardData('/api/dashboard/overview', getHeaders());
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
        return await fetchDashboardData('/api/dashboard/analytics', getHeaders());
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
export function useDashboardContent(options: DashboardQueryOptions = {}) {
  const { isAdmin, isGuest, logout } = useAdmin();
  const getHeaders = useApiHeaders();
  const isVisible = usePageVisibility();
  const { activeTab = 'overview', enabled = true } = options;

  const isAuthenticated = isAdmin || isGuest;
  const isActiveTab = activeTab === 'content';
  // Only admins get live polling - guests fetch once on load
  const shouldPoll = isVisible && isActiveTab && isAdmin;

  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.content,
    queryFn: async () => {
      try {
        return await fetchDashboardData('/api/dashboard/content', getHeaders());
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
// Combined Hook for Dashboard
// ============================================================================

/**
 * Combined hook that provides all dashboard data with tab-aware polling
 */
export function useDashboardData(activeTab: DashboardTab) {
  const { isAdmin } = useAdmin();
  
  const options = { activeTab, enabled: true };

  const overview = useDashboardOverview(options);
  const analytics = useDashboardAnalytics(options);
  const content = useDashboardContent(options);
  const performance = useDashboardPerformance(options);
  const system = useDashboardSystem(options);
  const operations = useDashboardOperations(options);
  const users = useDashboardUsers(options);

  // Compute overall loading state
  const isLoading = 
    overview.isLoading || 
    analytics.isLoading || 
    system.isLoading ||
    (isAdmin && operations.isLoading);

  // Compute if any query has an error
  const hasError = 
    overview.isError || 
    analytics.isError || 
    system.isError;

  return {
    // Individual query results
    overview,
    analytics,
    content,
    performance,
    system,
    operations,
    users,
    
    // Convenience accessors for data
    data: {
      overview: overview.data,
      analytics: analytics.data,
      content: content.data,
      performance: performance.data,
      system: system.data,
      operations: operations.data,
      users: users.data,
    },
    
    // Loading states
    isLoading,
    isInitialLoading: overview.isLoading && !overview.data,
    
    // Error state
    hasError,
    
    // Refetch functions
    refetchAll: () => {
      overview.refetch();
      analytics.refetch();
      content.refetch();
      performance.refetch();
      system.refetch();
      if (isAdmin) {
        operations.refetch();
        users.refetch();
      }
    },
  };
}

// ============================================================================
// Utility Hook for Last Updated Display
// ============================================================================

/**
 * Hook to get formatted "last updated" time for a query
 */
export function useLastUpdated(dataUpdatedAt: number | undefined) {
  const [lastUpdated, setLastUpdated] = useState<string>('');

  useEffect(() => {
    if (!dataUpdatedAt) {
      setLastUpdated('');
      return;
    }

    const updateTime = () => {
      const now = Date.now();
      const diff = now - dataUpdatedAt;
      
      if (diff < 5000) {
        setLastUpdated('Just now');
      } else if (diff < 60000) {
        const seconds = Math.floor(diff / 1000);
        setLastUpdated(`${seconds}s ago`);
      } else if (diff < 3600000) {
        const minutes = Math.floor(diff / 60000);
        setLastUpdated(`${minutes}m ago`);
      } else {
        setLastUpdated(new Date(dataUpdatedAt).toLocaleTimeString());
      }
    };

    updateTime();
    const interval = setInterval(updateTime, 5000);
    
    return () => clearInterval(interval);
  }, [dataUpdatedAt]);

  return lastUpdated;
}
