import { Card, CardContent } from "@/components/ui/card";
import { Header } from './components/layout/Header';
import { SettingsLayout } from './components/SettingsLayout';
import { ChangelogModal } from './components/ChangelogBox';
import { ConfigProvider } from './contexts/ConfigContext';
import { AdminProvider } from './contexts/AdminContext';
import { Toaster } from "@/components/ui/sonner";
import { useConfig } from './contexts/ConfigContext';

function AppContent() {
  const { config } = useConfig();
  
  return (
    <div className="min-h-screen w-full bg-background text-foreground flex flex-col items-center p-4 sm:p-6">
      <Header />
      
      {/* Custom Description Blurb - Outside main card */}
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
    <ConfigProvider>
      <AdminProvider>
        <AppContent />
      </AdminProvider>
    </ConfigProvider>
  );
}

export default App;

