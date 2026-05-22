import { Card, CardContent } from "@/components/ui/card";
import { Header } from './components/layout/Header';
import { SettingsLayout } from './components/SettingsLayout';
import { AdminProvider } from './contexts/AdminContext';
import { Toaster } from "@/components/ui/sonner";
import { useConfig } from './contexts/ConfigContext';

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

