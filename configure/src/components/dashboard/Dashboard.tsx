import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAdmin } from "@/contexts/AdminContext";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import {
  useDashboardOverview,
  useDashboardAnalytics,
  useDashboardContent,
  useDashboardPerformance,
  useDashboardSystem,
  useDashboardOperations,
  useDashboardUsers,
  useDashboardLogs,
  useDashboardSettings,
  type DashboardTab,
} from "@/hooks/useDashboardQueries";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Loader2,
  Shield,
  Users,
  Key,
  LogOut,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { DashboardContent } from "./DashboardContent";
import { DashboardAnalytics } from "./DashboardAnalytics";
import { DashboardSystem } from "./DashboardSystem";
import { DashboardLogs } from "./DashboardLogs";
import { DashboardOverview } from "./DashboardOverview";
import { DashboardPerformance } from "./DashboardPerformance";
import { DashboardOperations } from "./DashboardOperations";
import { DashboardUsers } from "./DashboardUsers";
import { DashboardSettings } from "./DashboardSettings";







// Blocking Admin Login Modal Component
interface AdminLoginModalProps {
  isOpen: boolean;
  onSuccess: () => void;
  onGuestSuccess: () => void;
  onCancel: () => void;
  adminKeyNotConfigured?: boolean;
  guestModeEnabled?: boolean;
}

function AdminLoginModal({ 
  isOpen, 
  onSuccess, 
  onGuestSuccess,
  onCancel, 
  adminKeyNotConfigured,
  guestModeEnabled 
}: AdminLoginModalProps) {
  const { login, loginAsGuest, isLoading } = useAdmin();
  const [inputAdminKey, setInputAdminKey] = useState("");
  const [error, setError] = useState("");
  const [showAdminInput, setShowAdminInput] = useState(false);

  const handleLogin = async () => {
    if (!inputAdminKey.trim()) {
      setError("Please enter an admin key");
      return;
    }

    setError("");
    const success = await login(inputAdminKey);
    if (success) {
      setInputAdminKey("");
      setError("");
      setShowAdminInput(false);
      onSuccess();
    } else {
      setError("Invalid admin key. Please try again.");
    }
  };

  const handleGuestLogin = () => {
    loginAsGuest();
    onGuestSuccess();
  };

  const handleGoBack = () => {
    // Navigate away from dashboard 
    const stored = sessionStorage.getItem('lastConfigureUrl');
    window.location.href = stored || '/configure';
  };

  const handleBackToOptions = () => {
    setShowAdminInput(false);
    setInputAdminKey("");
    setError("");
  };

  // Show specific message when ADMIN_KEY is not configured AND guest mode is disabled
  if (adminKeyNotConfigured && !guestModeEnabled) {
    return (
      <Dialog open={isOpen} onOpenChange={() => {}}>
        <DialogContent 
          className="sm:max-w-md" 
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-amber-500" />
              Dashboard Access Unavailable
            </DialogTitle>
            <DialogDescription>
              Dashboard access requires the ADMIN_KEY environment variable to be configured on the server.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="p-3 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-md text-sm text-amber-700 dark:text-amber-300">
              <p className="font-medium mb-1">Configuration Required</p>
              <p>Please set the ADMIN_KEY environment variable on your server to enable dashboard access.</p>
            </div>
            <div className="flex justify-end">
              <Button variant="outline" onClick={handleGoBack}>
                Go Back
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // Show admin login input when "Admin Login" is clicked
  if (showAdminInput) {
    return (
      <Dialog open={isOpen} onOpenChange={() => {}}>
        <DialogContent 
          className="sm:max-w-md"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Admin Authentication
            </DialogTitle>
            <DialogDescription>
              Enter your admin key to access all dashboard features.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!isLoading && !adminKeyNotConfigured) handleLogin();
            }}
          >
            {error && (
              <div className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-md text-sm text-red-700 dark:text-red-300">
                {error}
              </div>
            )}
            {adminKeyNotConfigured && guestModeEnabled && (
              <div className="p-3 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-md text-sm text-amber-700 dark:text-amber-300">
                <p className="font-medium mb-1">Admin Access Unavailable</p>
                <p>ADMIN_KEY is not configured on the server. You can continue as a guest to view public metrics.</p>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="admin-key-modal">Admin Key</Label>
              <Input
                id="admin-key-modal"
                name="password"
                autoComplete="current-password"
                type="password"
                value={inputAdminKey}
                onChange={(e) => setInputAdminKey(e.target.value)}
                placeholder="Enter admin key"
                autoFocus
                disabled={adminKeyNotConfigured}
              />
            </div>
            <div className="flex justify-between gap-2">
              <Button type="button" variant="outline" onClick={handleBackToOptions}>
                Back
              </Button>
              <Button type="submit" disabled={isLoading || adminKeyNotConfigured}>
                {isLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Authenticating...
                  </>
                ) : (
                  "Login"
                )}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    );
  }

  // Show login options: Admin Login and Guest (if enabled)
  return (
    <Dialog open={isOpen} onOpenChange={() => {}}>
      <DialogContent 
        className="sm:max-w-md"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Dashboard Access
          </DialogTitle>
          <DialogDescription>
            {guestModeEnabled 
              ? "Choose how you'd like to access the dashboard."
              : "Enter your admin key to access the dashboard."
            }
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {/* Admin Login Option */}
          <Button 
            className="w-full justify-start h-auto py-4" 
            variant="outline"
            onClick={() => setShowAdminInput(true)}
          >
            <div className="flex items-center gap-3">
              <Key className="h-5 w-5 text-primary" />
              <div className="text-left">
                <p className="font-medium">Admin Login</p>
                <p className="text-xs text-muted-foreground">Full access to all dashboard features</p>
              </div>
            </div>
          </Button>

          {/* Guest Option - Only shown when guest mode is enabled */}
          {guestModeEnabled && (
            <Button 
              className="w-full justify-start h-auto py-4" 
              variant="outline"
              onClick={handleGuestLogin}
            >
              <div className="flex items-center gap-3">
                <Users className="h-5 w-5 text-muted-foreground" />
                <div className="text-left">
                  <p className="font-medium">Continue as Guest</p>
                  <p className="text-xs text-muted-foreground">View public metrics without authentication</p>
                </div>
              </div>
            </Button>
          )}

          <div className="flex justify-start pt-2">
            <Button variant="ghost" size="sm" onClick={handleGoBack}>
              Go Back
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Access level type for tracking current user access
type AccessLevel = 'none' | 'guest' | 'admin';

// Admin Status Badge Component - Shows admin/guest status and logout button
interface AdminStatusBadgeProps {}

function AdminStatusBadge({}: AdminStatusBadgeProps) {
  const { isAdmin, isGuest, adminKey, logout } = useAdmin();

  // Determine current access level based on AdminContext state
  const accessLevel: AccessLevel = isAdmin ? 'admin' : isGuest ? 'guest' : 'none';

  const handleLogout = () => {
    logout();
  };

  // Don't show badge if not authenticated
  if (accessLevel === 'none') {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      {accessLevel === 'admin' ? (
        <Badge variant="default" className="bg-green-600">
          <Shield className="h-3 w-3 mr-1" />
          Admin
        </Badge>
      ) : (
        <Badge variant="secondary" className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
          <Users className="h-3 w-3 mr-1" />
          Guest
        </Badge>
      )}
      {(adminKey || isGuest) && (
        <Button variant="outline" size="sm" onClick={handleLogout}>
          <LogOut className="h-4 w-4 mr-1" />
          Logout
        </Button>
      )}
    </div>
  );
}

// Main Dashboard Component
export function Dashboard() {
  const { isAdmin, isGuest, adminKey, isLoading, adminKeyConfigured, guestModeEnabled } = useAdmin();
  const { isMobile } = useBreakpoint();
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [activeTab, setActiveTab] = useState<DashboardTab>('overview');
  const [activeMobileSection, setActiveMobileSection] = useState<DashboardTab | undefined>(undefined);
  const [contentTimeframe, setContentTimeframe] = useState('today');
  const [logsPaused, setLogsPaused] = useState(false);

  const navigateToTab = (tab: string) => {
    setActiveTab(tab as DashboardTab);
    setActiveMobileSection((prev) => (prev !== undefined ? (tab as DashboardTab) : prev));
  };

  // Access level state management - tracks current access level based on AdminContext state
  const accessLevel: AccessLevel = isAdmin ? 'admin' : isGuest ? 'guest' : 'none';

  // TanStack Query hooks with tab-aware polling
  const queryOptions = { activeTab, enabled: isAdmin || isGuest };
  
  const overviewQuery = useDashboardOverview(queryOptions);
  const analyticsQuery = useDashboardAnalytics(queryOptions);
  const contentQuery = useDashboardContent({ ...queryOptions, timeframe: contentTimeframe });
  const performanceQuery = useDashboardPerformance(queryOptions);
  const systemQuery = useDashboardSystem(queryOptions);
  const operationsQuery = useDashboardOperations(queryOptions);
  const usersQuery = useDashboardUsers(queryOptions);
  const logsQuery = useDashboardLogs({ ...queryOptions, paused: logsPaused });
  const settingsQuery = useDashboardSettings(queryOptions);

  // Refetch data when tab changes (only if not already fetching)
  const prevTabRef = useRef<DashboardTab | null>(null);
  useEffect(() => {
    // Skip initial mount
    if (prevTabRef.current === null) {
      prevTabRef.current = activeTab;
      return;
    }
    
    // Only refetch if tab actually changed
    if (prevTabRef.current !== activeTab) {
      prevTabRef.current = activeTab;
      
      // Only trigger refetch if not already fetching to prevent request piling
      switch (activeTab) {
        case 'overview':
          if (!overviewQuery.isFetching) overviewQuery.refetch();
          if (!systemQuery.isFetching) systemQuery.refetch();
          break;
        case 'analytics':
          if (!analyticsQuery.isFetching) analyticsQuery.refetch();
          break;
        case 'content':
          if (!contentQuery.isFetching) contentQuery.refetch();
          break;
        case 'performance':
          if (!performanceQuery.isFetching) performanceQuery.refetch();
          break;
        case 'system':
          if (!systemQuery.isFetching) systemQuery.refetch();
          break;
        case 'operations':
          if (isAdmin && !operationsQuery.isFetching) operationsQuery.refetch();
          break;
        case 'users':
          if (isAdmin && !usersQuery.isFetching) usersQuery.refetch();
          break;
        case 'logs':
          if (isAdmin && !logsQuery.isFetching) logsQuery.refetch();
          break;
        case 'settings':
          if (isAdmin && !settingsQuery.isFetching) settingsQuery.refetch();
          break;
      }
    }
  }, [activeTab]);

  // Compute loading state - only show loading on initial load
  const isInitialLoading = overviewQuery.isLoading && !overviewQuery.data;

  // Build dashboard data object for child components (maintains backward compatibility)
  const dashboardData = {
    overview: overviewQuery.data,
    analytics: analyticsQuery.data,
    content: contentQuery.data,
    performance: performanceQuery.data,
    system: systemQuery.data,
    operations: operationsQuery.data,
    users: usersQuery.data,
    logs: logsQuery.data,
    settings: settingsQuery.data,
    loading: isInitialLoading,
    error: overviewQuery.error?.message || null,
  };

  // Show login modal when not authenticated (neither admin nor guest)
  useEffect(() => {
    if (!isLoading && !isAdmin && !isGuest) {
      setShowLoginModal(true);
    } else if (isAdmin || isGuest) {
      setShowLoginModal(false);
    }
  }, [isLoading, isAdmin, isGuest]);

  // Handle successful admin login
  const handleLoginSuccess = () => {
    setShowLoginModal(false);
  };

  // Handle successful guest login
  const handleGuestSuccess = () => {
    setShowLoginModal(false);
  };

  // Handle login cancel (go back)
  const handleLoginCancel = () => {
    const stored = sessionStorage.getItem('lastConfigureUrl');
    window.location.href = stored || '/configure';
  };

  // Show loading state while checking authentication (only on initial load)
  // Don't show loading spinner during login attempts - keep the modal visible
  if (isLoading && !showLoginModal) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Checking authentication...</p>
        </div>
      </div>
    );
  }

  // Show login modal if not authenticated (neither admin nor guest)
  // Don't render any dashboard content behind the modal
  if (!isAdmin && !isGuest) {
    return (
      <AdminLoginModal
        isOpen={showLoginModal}
        onSuccess={handleLoginSuccess}
        onGuestSuccess={handleGuestSuccess}
        onCancel={handleLoginCancel}
        adminKeyNotConfigured={!adminKeyConfigured}
        guestModeEnabled={guestModeEnabled}
      />
    );
  }

  // Calculate grid columns based on admin status
  const gridCols = isAdmin ? "grid-cols-6" : "grid-cols-4";

  // Dashboard pages configuration - base pages available to all authenticated users
  const dashboardPages = [
    {
      value: "overview",
      title: "Overview",
      component: (
        <DashboardOverview
          data={dashboardData.overview}
          loading={dashboardData.loading}
          onNavigate={navigateToTab}
        />
      ),
    },
    {
      value: "analytics",
      title: "Analytics",
      component: (
        <DashboardAnalytics
          data={dashboardData.analytics}
          isMobile={isMobile}
        />
      ),
    },
    {
      value: "content",
      title: "Content",
      component: (
        <DashboardContent
          data={dashboardData.content}
          loading={dashboardData.loading}
          timeframe={contentTimeframe}
          onTimeframeChange={setContentTimeframe}
        />
      ),
    },
    {
      value: "performance",
      title: "Performance",
      component: (
        <DashboardPerformance
          data={dashboardData.performance}
          loading={dashboardData.loading}
        />
      ),
    },
    {
      value: "system",
      title: "System",
      component: (
        <DashboardSystem
          data={dashboardData.system}
        />
      ),
    },
  ];

  if (accessLevel === 'admin') {
    dashboardPages.push(
      {
        value: "operations",
        title: "Operations",
        component: (
          <DashboardOperations
            data={dashboardData.operations}
            loading={dashboardData.loading}
            activeTab={activeTab}
          />
        ),
      },
      {
        value: "users",
        title: "Users",
        component: (
          <DashboardUsers
            data={dashboardData.users}
            loading={dashboardData.loading}
            activeTab={activeTab}
          />
        ),
      },
      {
        value: "logs",
        title: "Logs",
        component: (
          <DashboardLogs
            data={dashboardData.logs}
            paused={logsPaused}
            onPauseToggle={() => setLogsPaused((p) => !p)}
            onClear={logsQuery.resetLogs}
          />
        ),
      },
      {
        value: "settings",
        title: "Settings",
        component: (
          <DashboardSettings
            data={dashboardData.settings}
          />
        ),
      },
    );
  }

  // Mobile layout with push/pop navigation
  if (isMobile) {
    const activePage = dashboardPages.find(p => p.value === activeMobileSection);

    return (
      <div className="w-full p-4 overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          {!activeMobileSection ? (
            <motion.div
              key="menu"
              initial={{ opacity: 0, x: -60 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -60 }}
              transition={{ type: "tween", duration: 0.2, ease: "easeOut" }}
            >
              <div className="flex flex-col items-start justify-between gap-4 mb-6">
                <div>
                  <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
                  <p className="text-sm text-muted-foreground">
                    Monitor your addon's performance, health, and usage statistics
                  </p>
                </div>
                <AdminStatusBadge />
              </div>

              <div className="rounded-xl border border-white/[0.06] bg-card/80 backdrop-blur-sm overflow-hidden">
                {dashboardPages.map((page, index) => (
                  <button
                    key={page.value}
                    onClick={() => {
                      setActiveTab(page.value as DashboardTab);
                      setActiveMobileSection(page.value as DashboardTab);
                    }}
                    className={`flex items-center justify-between w-full px-4 py-3.5 text-left transition-colors active:bg-white/[0.04] ${
                      index < dashboardPages.length - 1 ? 'border-b border-white/[0.04]' : ''
                    }`}
                  >
                    <span className="text-[15px] font-medium text-foreground">{page.title}</span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
                  </button>
                ))}
              </div>
            </motion.div>
          ) : (
            <motion.div
              key={activeMobileSection}
              initial={{ opacity: 0, x: 60 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 60 }}
              transition={{ type: "tween", duration: 0.2, ease: "easeOut" }}
            >
              <button
                onClick={() => setActiveMobileSection(undefined)}
                className="flex items-center gap-1 mb-4 -ml-1 py-1.5 px-2 rounded-lg text-muted-foreground active:bg-white/[0.04] transition-colors"
              >
                <ChevronLeft className="h-4 w-4" />
                <span className="text-sm font-medium">Dashboard</span>
              </button>
              <h2 className="text-xl font-semibold mb-4">{activePage?.title}</h2>
              {activePage?.component}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  // Desktop layout with tabs
  return (
    <div className="min-h-screen">
      <Tabs value={activeTab} className="w-full" onValueChange={(value) => setActiveTab(value as DashboardTab)}>
        {/* Sticky top bar */}
        <div className="sticky top-0 z-30 bg-background/80 backdrop-blur-lg border-b border-white/[0.06]">
          <div className="flex items-center justify-between gap-4 px-4 sm:px-6 lg:px-8 h-14">
            <h1 className="text-lg font-semibold tracking-tight shrink-0">Dashboard</h1>
            <TabsList className="relative inline-flex h-9 items-center justify-center rounded-full p-[3px] text-muted-foreground bg-muted/70 shadow-[inset_0_1px_4px_rgba(0,0,0,0.2),inset_0_0_1px_rgba(0,0,0,0.15)] border border-white/[0.04] overflow-hidden">
              {[
                { value: "overview", label: "Overview" },
                { value: "analytics", label: "Analytics" },
                { value: "content", label: "Content" },
                { value: "performance", label: "Perf" },
                { value: "system", label: "System" },
                ...(accessLevel === 'admin' ? [
                  { value: "operations", label: "Ops" },
                  { value: "users", label: "Users" },
                  { value: "logs", label: "Logs" },
                  { value: "settings", label: "Settings" },
                ] : []),
              ].map((tab) => (
                <TabsTrigger
                  key={tab.value}
                  value={tab.value}
                  className="relative z-10 inline-flex items-center justify-center whitespace-nowrap px-3 py-1 text-[13px] rounded-full bg-transparent transition-all duration-200 text-muted-foreground/70 hover:text-muted-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:font-semibold data-[state=active]:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  {activeTab === tab.value && (
                    <motion.div
                      layoutId="activeDashboardTabPill"
                      className="absolute inset-0 rounded-full bg-[hsl(240_6%_12%)] shadow-[0_1px_3px_rgba(0,0,0,0.3),0_1px_1px_rgba(0,0,0,0.2)] border border-white/[0.06]"
                      transition={{ type: "spring", stiffness: 500, damping: 32 }}
                    />
                  )}
                  <span className="relative z-10">{tab.label}</span>
                </TabsTrigger>
              ))}
            </TabsList>
            <AdminStatusBadge />
          </div>

          {(dashboardData.overview as any)?.metricsDisabled && (
            <div className="bg-amber-50 dark:bg-amber-950 border-t border-amber-200 dark:border-amber-800 px-4 sm:px-6 lg:px-8 py-2 flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                Metrics have been disabled on this instance
              </p>
            </div>
          )}
        </div>

        {/* Content area */}
        <div className="px-4 sm:px-6 lg:px-8 py-6">
        <TabsContent value="overview" className="mt-0">
          <DashboardOverview
            data={dashboardData.overview}
            loading={dashboardData.loading}
            onNavigate={navigateToTab}
          />
        </TabsContent>

        <TabsContent value="analytics" className="mt-0">
          <DashboardAnalytics
            data={dashboardData.analytics}
            isMobile={isMobile}
          />
        </TabsContent>

        <TabsContent value="content" className="mt-0">
          <DashboardContent
            data={dashboardData.content}
            loading={dashboardData.loading}
            timeframe={contentTimeframe}
            onTimeframeChange={setContentTimeframe}
          />
        </TabsContent>

        <TabsContent value="performance" className="mt-0">
          <DashboardPerformance
            data={dashboardData.performance}
            loading={dashboardData.loading}
          />
        </TabsContent>

        <TabsContent value="system" className="mt-0">
          <DashboardSystem
            data={dashboardData.system}
          />
        </TabsContent>

        {accessLevel === 'admin' && (
          <>
            <TabsContent value="operations" className="mt-0">
              <DashboardOperations
                data={dashboardData.operations}
                loading={dashboardData.loading}
                activeTab={activeTab}
              />
            </TabsContent>

            <TabsContent value="users" className="mt-0">
              <DashboardUsers
                data={dashboardData.users}
                loading={dashboardData.loading}
                activeTab={activeTab}
              />
            </TabsContent>

            <TabsContent value="logs" className="mt-0">
              <DashboardLogs
                data={dashboardData.logs}
                paused={logsPaused}
                onPauseToggle={() => setLogsPaused((p) => !p)}
                onClear={logsQuery.resetLogs}
              />
            </TabsContent>

            <TabsContent value="settings" className="mt-0">
              <DashboardSettings
                data={dashboardData.settings}
              />
            </TabsContent>
          </>
        )}
        </div>
      </Tabs>
    </div>
  );
}
