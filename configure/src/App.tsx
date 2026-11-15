import { Header } from './components/layout/Header';
import { SettingsLayout } from './components/SettingsLayout';
import { AdminProvider } from './contexts/AdminContext';
import { SaveProvider } from './contexts/SaveContext';
import { Toaster } from "@/components/ui/sonner";
import { useConfig } from './contexts/ConfigContext';
import { isOwnPage } from './lib/ownPage';
import OwnPage from './components/dashboard/OwnPage';

function AppContent() {
  const { config } = useConfig();
  const isDashboardMode = !!(window as any).DASHBOARD_MODE;

  if (isDashboardMode) {
    return (
      <div className="dark min-h-screen w-full bg-background text-foreground">
        <SettingsLayout />
        <Toaster />
      </div>
    );
  }

  return (
    <SaveProvider>
      <div className="dark min-h-screen w-full bg-background text-foreground">
        <div className="w-full px-4 sm:px-6 lg:px-8">
          <Header />

          {config.apiKeys.customDescriptionBlurb && (
            <div
              className="mb-6 p-4 bg-black border rounded-lg"
              dangerouslySetInnerHTML={{ __html: config.apiKeys.customDescriptionBlurb }}
            />
          )}

          <SettingsLayout />
        </div>
        <Toaster />
      </div>
    </SaveProvider>
  );
}

function App() {
  if (isOwnPage()) return <OwnPage />;
  return (
    <AdminProvider>
      <AppContent />
    </AdminProvider>
  );
}

export default App;

