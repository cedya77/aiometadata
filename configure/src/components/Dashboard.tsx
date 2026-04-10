import React, { useState, useEffect, useRef, Suspense, lazy } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
  useClearCache,
  useExecuteMaintenanceTask,
  useClearErrorLogs,
  useClearUserData,
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
} from "lucide-react";

const DashboardOverview = lazy(() => import('./sections/Dashboard/Overview').then(m => ({ default: m.DashboardOverview })));
const DashboardAnalytics = lazy(() => import('./sections/Dashboard/Analytics').then(m => ({ default: m.DashboardAnalytics })));
const DashboardContent = lazy(() => import('./sections/Dashboard/Content').then(m => ({ default: m.DashboardContent })));
const DashboardPerformance = lazy(() => import('./sections/Dashboard/Performance').then(m => ({ default: m.DashboardPerformance })));
const DashboardSystem = lazy(() => import('./sections/Dashboard/System').then(m => ({ default: m.DashboardSystem })));
const DashboardOperations = lazy(() => import('./sections/Dashboard/Operations').then(m => ({ default: m.DashboardOperations })));
const DashboardUsers = lazy(() => import('./sections/Dashboard/Users').then(m => ({ default: m.DashboardUsers })));

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
          className="sm:max-w-md mx-4" 
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
          className="sm:max-w-md mx-4"
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
          <div className="space-y-4">
            {error && (
              <div className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-md text-sm text-red-700 dark:text-red-300">
                {error}
              </div>
            )}
            {/* Show warning if ADMIN_KEY is not configured but guest mode is enabled */}
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
                type="password"
                value={inputAdminKey}
                onChange={(e) => setInputAdminKey(e.target.value)}
                placeholder="Enter admin key"
                onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                autoFocus
                disabled={adminKeyNotConfigured}
              />
            </div>
            <div className="flex justify-between gap-2">
              <Button variant="outline" onClick={handleBackToOptions}>
                Back
              </Button>
              <Button onClick={handleLogin} disabled={isLoading || adminKeyNotConfigured}>
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
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // Show login options: Admin Login and Guest (if enabled)
  return (
    <Dialog open={isOpen} onOpenChange={() => {}}>
      <DialogContent 
        className="sm:max-w-md mx-4"
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

  // Access level state management - tracks current access level based on AdminContext state
  const accessLevel: AccessLevel = isAdmin ? 'admin' : isGuest ? 'guest' : 'none';

  // TanStack Query hooks with tab-aware polling
  const queryOptions = { activeTab, enabled: isAdmin || isGuest };
  
  const overviewQuery = useDashboardOverview(queryOptions);
  const analyticsQuery = useDashboardAnalytics(queryOptions);
  const contentQuery = useDashboardContent(queryOptions);
  const performanceQuery = useDashboardPerformance(queryOptions);
  const systemQuery = useDashboardSystem(queryOptions);
  const operationsQuery = useDashboardOperations(queryOptions);
  const usersQuery = useDashboardUsers(queryOptions);

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
      component: () => (
        <DashboardOverview
          data={dashboardData.overview}
          systemData={dashboardData.system}
          loading={dashboardData.loading}
        />
      ),
    },
    {
      value: "analytics",
      title: "Analytics",
      component: () => (
        <DashboardAnalytics
          data={dashboardData.analytics}
          loading={dashboardData.loading}
          isMobile={isMobile}
        />
      ),
    },
    {
      value: "content",
      title: "Content",
      component: () => (
        <DashboardContent
          data={dashboardData.content}
          loading={dashboardData.loading}
        />
      ),
    },
    {
      value: "performance",
      title: "Performance",
      component: () => (
        <DashboardPerformance
          data={dashboardData.performance}
          loading={dashboardData.loading}
        />
      ),
    },
    {
      value: "system",
      title: "System",
      component: () => (
        <DashboardSystem
          data={dashboardData.system}
          loading={dashboardData.loading}
        />
      ),
    },
  ];

  if (accessLevel === 'admin') {
    dashboardPages.push(
      {
        value: "operations",
        title: "Operations",
        component: () => (
          <DashboardOperations
            data={dashboardData.operations}
            loading={dashboardData.loading}
          />
        ),
      },
      {
        value: "users",
        title: "Users",
        component: () => (
          <DashboardUsers
            data={dashboardData.users}
            loading={dashboardData.loading}
          />
        ),
      },
    );
  }

  // Mobile layout with accordion
  if (isMobile) {
    return (
      <div className="w-full p-4">
        <div className="flex flex-col items-start justify-between gap-4 mb-6">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
            <p className="text-sm text-muted-foreground">
              Monitor your addon's performance, health, and usage statistics
            </p>
          </div>
          <AdminStatusBadge />
        </div>


        <Accordion 
          type="single" 
          collapsible 
          className="w-full"
          onValueChange={(value) => value && setActiveTab(value as DashboardTab)}
        >
          {dashboardPages.map((page, index) => (
            <AccordionItem
              value={page.value}
              key={page.value}
              className={
                index === dashboardPages.length - 1 ? "border-b-0" : "border-b"
              }
            >
              <AccordionTrigger className="text-lg font-medium hover:no-underline py-4">
                {page.title}
              </AccordionTrigger>
              <AccordionContent className="pt-2 pb-6">
                <Suspense fallback={<div className="flex items-center justify-center p-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}>
                  <page.component />
                </Suspense>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6 p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
            Dashboard
          </h2>
          <p className="text-sm sm:text-base text-muted-foreground">
            Monitor your addon's performance, health, and usage statistics
          </p>
        </div>
        <AdminStatusBadge />
      </div>

      {/* Metrics Disabled Banner */}
      {(dashboardData.overview as any)?.metricsDisabled && (
        <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-3 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
            Metrics have been disabled on this instance
          </p>
        </div>
      )}
      
      <Tabs defaultValue="overview" className="w-full" onValueChange={(value) => setActiveTab(value as DashboardTab)}>
        <TabsList className="inline-flex h-10 items-center justify-center rounded-md p-1 text-muted-foreground w-full gap-x-1 bg-muted overflow-x-auto">
          {dashboardPages.map((page) => (
            <TabsTrigger key={page.value} value={page.value} className="text-xs sm:text-sm whitespace-nowrap">
              {page.title}
            </TabsTrigger>
          ))}
        </TabsList>

        {dashboardPages.map((page) => (
          <TabsContent key={page.value} value={page.value} className="mt-6">
            <Suspense fallback={<div className="flex items-center justify-center p-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}>
              <page.component />
            </Suspense>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
