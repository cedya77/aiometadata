import { useState, useEffect, useCallback } from 'react';
import { useAdmin } from '@/contexts/AdminContext';

const API_BASE = process.env.NODE_ENV === 'development' 
  ? 'http://localhost:7000' 
  : window.location.origin;


// Hook for fetching main dashboard data
export function useDashboardData() {
  const { adminKey, isAdmin, isGuest, logout } = useAdmin();
  const [data, setData] = useState({
    systemOverview: null,
    quickStats: null,
    cachePerformance: null,
    providerPerformance: null,
    systemConfig: null,
    resourceUsage: null,
    errorLogs: null,
    maintenanceTasks: null
  });
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Only fetch if user is admin or guest
      if (!isAdmin && !isGuest) {
        setLoading(false);
        return;
      }

      // Build headers - only include admin key for admin users
      const headers = {
        'Content-Type': 'application/json'
      };
      
      // Only add admin key header for admin users
      if (isAdmin && adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      // Fetch public endpoint (overview) - accessible by both guest and admin
      const response = await fetch(`${API_BASE}/api/dashboard/overview`, {
        headers
      });

      // Handle 401 responses - for admin users, trigger re-authentication
      // For guest users, this shouldn't happen if guest mode is enabled
      if (response.status === 401) {
        if (isAdmin) {
          logout();
          setError('Session expired. Please log in again.');
        } else {
          setError('Access denied. Guest mode may be disabled.');
        }
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const dashboardData = await response.json();
      setData(dashboardData);
    } catch (err) {
      console.error('Error fetching dashboard data:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [isAdmin, isGuest, adminKey, logout]);

  const clearCache = useCallback(async (type) => {
    try {
      // Only allow cache clear if user is admin (protected endpoint)
      if (!isAdmin) {
        throw new Error('Not authenticated - admin access required');
      }

      const headers = {
        'Content-Type': 'application/json'
      };
      
      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch(`${API_BASE}/api/dashboard/cache/clear`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type })
      });

      // Handle 401 responses by triggering re-authentication
      if (response.status === 401) {
        logout();
        throw new Error('Session expired. Please log in again.');
      }

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      
      // Refresh data after cache clear
      if (result.success) {
        await fetchData();
      }

      return result;
    } catch (err) {
      console.error('Error clearing cache:', err);
      throw err;
    }
  }, [isAdmin, adminKey, logout, fetchData]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return {
    data,
    loading,
    error,
    refetch: fetchData,
    clearCache
  };
}


// Hook for fetching dashboard statistics

export function useDashboardStats() {
  const { adminKey, isAdmin, isGuest, logout } = useAdmin();
  const [stats, setStats] = useState({
    quickStats: null,
    cachePerformance: null,
    providerPerformance: null
  });
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchStats = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Allow fetching for both admin and guest users
      if (!isAdmin && !isGuest) {
        setLoading(false);
        return;
      }

      // Build headers - only include admin key for admin users
      const headers = {
        'Content-Type': 'application/json'
      };
      
      // Only add admin key header for admin users
      if (isAdmin && adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch(`${API_BASE}/api/dashboard/stats`, {
        headers
      });

      // Handle 401 responses
      if (response.status === 401) {
        if (isAdmin) {
          logout();
          setError('Session expired. Please log in again.');
        } else {
          setError('Access denied. Guest mode may be disabled.');
        }
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const statsData = await response.json();
      setStats(statsData);
    } catch (err) {
      console.error('Error fetching dashboard stats:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [isAdmin, isGuest, adminKey, logout]);

  useEffect(() => {
    fetchStats();
    
    // Auto-refresh every 30 seconds to get updated provider performance data
    // Only set up interval if user is admin or guest
    if (!isAdmin && !isGuest) return;
    
    const interval = setInterval(fetchStats, 30000);
    
    return () => clearInterval(interval);
  }, [fetchStats, isAdmin, isGuest]);

  return {
    stats,
    loading,
    error,
    refetch: fetchStats
  };
}


// Hook for fetching system data
export function useDashboardSystem() {
  const { adminKey, isAdmin, isGuest, logout } = useAdmin();
  const [systemData, setSystemData] = useState({
    systemConfig: null,
    resourceUsage: null
  });
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchSystemData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Allow fetching for both admin and guest users
      if (!isAdmin && !isGuest) {
        setLoading(false);
        return;
      }

      // Build headers - only include admin key for admin users
      const headers = {
        'Content-Type': 'application/json'
      };
      
      // Only add admin key header for admin users
      if (isAdmin && adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch(`${API_BASE}/api/dashboard/system`, {
        headers
      });

      // Handle 401 responses
      if (response.status === 401) {
        if (isAdmin) {
          logout();
          setError('Session expired. Please log in again.');
        } else {
          setError('Access denied. Guest mode may be disabled.');
        }
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const systemData = await response.json();
      setSystemData(systemData);
    } catch (err) {
      console.error('Error fetching system data:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [isAdmin, isGuest, adminKey, logout]);

  useEffect(() => {
    fetchSystemData();
    
    // Auto-refresh every 60 seconds for system data
    // Only set up interval if user is admin or guest
    if (!isAdmin && !isGuest) return;
    
    const interval = setInterval(fetchSystemData, 60000);
    
    return () => clearInterval(interval);
  }, [fetchSystemData, isAdmin, isGuest]);

  return {
    systemData,
    loading,
    error,
    refetch: fetchSystemData
  };
}


// Hook for fetching operations data (admin-only)
export function useDashboardOperations() {
  const { adminKey, isAdmin, logout } = useAdmin();
  const [operationsData, setOperationsData] = useState({
    errorLogs: null,
    maintenanceTasks: null
  });
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchOperationsData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Only fetch if user is admin - this is a protected endpoint
      // Guest users should not have access to operations data
      if (!isAdmin) {
        // Return empty data for non-admin users (including guests)
        setOperationsData({
          errorLogs: null,
          maintenanceTasks: null
        });
        setLoading(false);
        return;
      }

      const headers = {
        'Content-Type': 'application/json'
      };
      
      // Always include admin key for this protected endpoint
      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }

      const response = await fetch(`${API_BASE}/api/dashboard/operations`, {
        headers
      });

      // Handle 401 responses by triggering re-authentication
      if (response.status === 401) {
        logout();
        setError('Session expired. Please log in again.');
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const operationsData = await response.json();
      setOperationsData(operationsData);
    } catch (err) {
      console.error('Error fetching operations data:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [isAdmin, adminKey, logout]);

  useEffect(() => {
    fetchOperationsData();
  }, [fetchOperationsData]);

  return {
    operationsData,
    loading,
    error,
    refetch: fetchOperationsData
  };
}
