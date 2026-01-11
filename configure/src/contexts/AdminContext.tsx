import React, { createContext, useContext, useState, useEffect } from 'react';

interface AdminContextType {
  isAdmin: boolean;
  isGuest: boolean;
  adminKey: string | null;
  login: (key: string) => Promise<boolean>;
  loginAsGuest: () => void;
  logout: () => void;
  isLoading: boolean;
  adminKeyConfigured: boolean;  // Indicates if ADMIN_KEY is set on server
  guestModeEnabled: boolean;    // Indicates if guest mode is available
}

const AdminContext = createContext<AdminContextType | undefined>(undefined);

const ADMIN_KEY_STORAGE = 'admin-key';
const ADMIN_SESSION_STORAGE = 'admin-session';
const GUEST_SESSION_STORAGE = 'guest-session';

// Message returned by backend when ADMIN_KEY is not configured
const ADMIN_KEY_NOT_CONFIGURED_MESSAGE = 'ADMIN_KEY environment variable must be configured to access the dashboard';

export function AdminProvider({ children }: { children: React.ReactNode }) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [isGuest, setIsGuest] = useState(false);
  const [adminKey, setAdminKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [adminKeyConfigured, setAdminKeyConfigured] = useState(true);  // Assume configured until proven otherwise
  const [guestModeEnabled, setGuestModeEnabled] = useState(false);     // Guest mode disabled by default

  // Fetch dashboard config to determine guest mode availability
  const fetchDashboardConfig = async (): Promise<{ guestModeEnabled: boolean; adminKeyConfigured: boolean }> => {
    try {
      const response = await fetch('/api/dashboard/config', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        return {
          guestModeEnabled: data.guestModeEnabled ?? false,
          adminKeyConfigured: data.adminKeyConfigured ?? true
        };
      }
      
      // If config endpoint fails, fall back to defaults
      return { guestModeEnabled: false, adminKeyConfigured: true };
    } catch (error) {
      console.error('Error fetching dashboard config:', error);
      return { guestModeEnabled: false, adminKeyConfigured: true };
    }
  };

  // Check if admin features are available
  const checkAdminFeaturesAvailable = async (): Promise<{ available: boolean; configured: boolean }> => {
    try {
      // Use lightweight auth check endpoint
      const response = await fetch('/api/dashboard/auth/check', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      if (response.status === 401) {
        // Check if the 401 is due to ADMIN_KEY not being configured
        try {
          const data = await response.json();
          if (data.message && data.message.includes('ADMIN_KEY environment variable must be configured')) {
            // ADMIN_KEY is not configured on the server
            return { available: false, configured: false };
          }
        } catch {
          // If we can't parse JSON, assume it's a normal auth failure
        }
        // Normal 401 - admin features are available and require authentication
        return { available: true, configured: true };
      }
      
      // If it returns 200, admin features are disabled (no ADMIN_KEY set)
      return { available: false, configured: false };
    } catch (error) {
      return { available: false, configured: true };  // Network error, assume configured
    }
  };

  // Check for existing admin session on mount
  useEffect(() => {
    const checkExistingSession = async () => {
      try {
        // First fetch dashboard config to determine guest mode availability
        const config = await fetchDashboardConfig();
        setGuestModeEnabled(config.guestModeEnabled);
        setAdminKeyConfigured(config.adminKeyConfigured);

        // Check for existing guest session
        const guestSession = sessionStorage.getItem(GUEST_SESSION_STORAGE);
        if (guestSession === 'true' && config.guestModeEnabled) {
          // Restore guest session
          setIsGuest(true);
          setIsAdmin(false);
          setAdminKey(null);
          setIsLoading(false);
          return;
        }

        // Check if admin features are available (ADMIN_KEY is set)
        const { available: adminFeaturesAvailable, configured } = await checkAdminFeaturesAvailable();
        
        // Update the adminKeyConfigured state if different from config
        if (!configured) {
          setAdminKeyConfigured(false);
        }
        
        if (!adminFeaturesAvailable) {
          // Admin features are disabled (no ADMIN_KEY set or not configured)
          setIsAdmin(false);
          setAdminKey(null);
          setIsLoading(false);
          return;
        }

        // Admin features are available and require authentication, check for existing session
        const storedKey = sessionStorage.getItem(ADMIN_KEY_STORAGE);
        const sessionActive = sessionStorage.getItem(ADMIN_SESSION_STORAGE);
        
        if (storedKey && sessionActive) {
          // Verify the key is still valid
          const { valid: isValid, configured } = await verifyAdminKey(storedKey);
          
          // Update adminKeyConfigured state if we detect it's not configured
          if (!configured) {
            setAdminKeyConfigured(false);
          }
          
          if (isValid) {
            setAdminKey(storedKey);
            setIsAdmin(true);
          } else {
            // Clear invalid session
            sessionStorage.removeItem(ADMIN_KEY_STORAGE);
            sessionStorage.removeItem(ADMIN_SESSION_STORAGE);
          }
        }
      } catch (error) {
        console.error('Error checking admin session:', error);
        // Clear any invalid session data
        sessionStorage.removeItem(ADMIN_KEY_STORAGE);
        sessionStorage.removeItem(ADMIN_SESSION_STORAGE);
        sessionStorage.removeItem(GUEST_SESSION_STORAGE);
      } finally {
        setIsLoading(false);
      }
    };

    checkExistingSession();
  }, []);

  // Verify admin key and return result with configuration status
  const verifyAdminKey = async (key: string): Promise<{ valid: boolean; configured: boolean }> => {
    try {
      // Use lightweight auth check endpoint
      const responseWithKey = await fetch('/api/dashboard/auth/check', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': key
        }
      });
      
      if (responseWithKey.ok) {
        return { valid: true, configured: true };
      }
      
      // Check if the 401 is due to ADMIN_KEY not being configured
      if (responseWithKey.status === 401) {
        try {
          const data = await responseWithKey.json();
          if (data.message && data.message.includes(ADMIN_KEY_NOT_CONFIGURED_MESSAGE)) {
            // ADMIN_KEY is not configured on the server
            return { valid: false, configured: false };
          }
        } catch {
          // If we can't parse JSON, assume it's a normal auth failure
        }
      }
      
      return { valid: false, configured: true };
    } catch (error) {
      console.error('Error verifying admin key:', error);
      return { valid: false, configured: true };  // Network error, assume configured
    }
  };

  const login = async (key: string): Promise<boolean> => {
    try {
      setIsLoading(true);
      const { valid: isValid, configured } = await verifyAdminKey(key);
      
      // Update adminKeyConfigured state based on response
      if (!configured) {
        setAdminKeyConfigured(false);
        return false;
      }
      
      if (isValid) {
        setAdminKey(key);
        setIsAdmin(true);
        sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
        sessionStorage.setItem(ADMIN_SESSION_STORAGE, 'true');
        return true;
      } else {
        return false;
      }
    } catch (error) {
      console.error('Error during admin login:', error);
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const logout = () => {
    setAdminKey(null);
    setIsAdmin(false);
    setIsGuest(false);
    sessionStorage.removeItem(ADMIN_KEY_STORAGE);
    sessionStorage.removeItem(ADMIN_SESSION_STORAGE);
    sessionStorage.removeItem(GUEST_SESSION_STORAGE);
  };

  const loginAsGuest = () => {
    // Only allow guest login if guest mode is enabled
    if (!guestModeEnabled) {
      return;
    }
    
    setIsGuest(true);
    setIsAdmin(false);
    setAdminKey(null);
    sessionStorage.setItem(GUEST_SESSION_STORAGE, 'true');
    // Clear any admin session data
    sessionStorage.removeItem(ADMIN_KEY_STORAGE);
    sessionStorage.removeItem(ADMIN_SESSION_STORAGE);
  };

  const value: AdminContextType = {
    isAdmin,
    isGuest,
    adminKey,
    login,
    loginAsGuest,
    logout,
    isLoading,
    adminKeyConfigured,
    guestModeEnabled
  };

  return (
    <AdminContext.Provider value={value}>
      {children}
    </AdminContext.Provider>
  );
}

export function useAdmin() {
  const context = useContext(AdminContext);
  if (context === undefined) {
    throw new Error('useAdmin must be used within an AdminProvider');
  }
  return context;
}
