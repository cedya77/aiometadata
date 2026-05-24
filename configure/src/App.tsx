import { Card, CardContent } from "@/components/ui/card";
import { Header } from './components/layout/Header';
import { SettingsLayout } from './components/SettingsLayout';
import { AdminProvider } from './contexts/AdminContext';
import { useAdmin } from './contexts/AdminContext';
import { Toaster } from "@/components/ui/sonner";
import { useConfig } from './contexts/ConfigContext';
import { LandingPage } from './components/LandingPage';
import { AdminAuthGate } from './components/AdminAuthGate';
import { LoadingScreen } from './components/LoadingScreen';

function AppContent() {
  const { config } = useConfig();
  const { isAdmin, isGuest, isLoading, adminKeyConfigured } = useAdmin();
  const isDashboardMode = !!(window as any).DASHBOARD_MODE;
  const isLandingMode = !!(window as any).LANDING_MODE;
  const isStremioRoute = window.location.pathname.startsWith('/stremio/');

  if (isLandingMode) {
    return (
      <div className="dark min-h-screen w-full bg-background text-foreground">
        <LandingPage />
        <Toaster />
      </div>
    );
  }

  // Show a brief loading screen while AdminContext verifies any stored session
  if (!isStremioRoute && adminKeyConfigured && isLoading) {
    return <LoadingScreen message="Checking authentication..." showSkeleton={false} />;
  }

  // Block access to /configure and /dashboard when ADMIN_KEY is set and user is not authenticated
  if (!isStremioRoute && adminKeyConfigured && !isAdmin && !isGuest) {
    return (
      <div className="dark min-h-screen w-full bg-background text-foreground">
        <AdminAuthGate mode={isDashboardMode ? 'dashboard' : 'configure'} />
        <Toaster />
      </div>
    );
  }

  if (isDashboardMode) {
    return (
      <div className="dark min-h-screen w-full bg-background text-foreground">
        <SettingsLayout />
        <Toaster />
      </div>
    );
  }

  return (
    <div className="dark min-h-screen w-full bg-background text-foreground flex flex-col items-center p-4 sm:p-6">
      <Header />

      {config.apiKeys.customDescriptionBlurb && (
        <div
          className="mb-6 p-4 bg-black border rounded-lg w-full max-w-5xl"
          dangerouslySetInnerHTML={{ __html: config.apiKeys.customDescriptionBlurb }}
        />
      )}

      <Card className="w-full max-w-5xl shadow-2xl mb-32">
        <CardContent className="p-6 md:p-8">
          <SettingsLayout />
        </CardContent>
      </Card>
      <Toaster />
    </div>
  );
}

function App() {
  return (
    <AdminProvider>
      <AppContent />
    </AdminProvider>
  );
}

export default App;

