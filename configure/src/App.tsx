import { Card, CardContent } from "@/components/ui/card";
import { Header } from './components/layout/Header';
import { SettingsLayout } from './components/SettingsLayout';
import { ConfigProvider } from './contexts/ConfigContext';
import { Toaster } from "@/components/ui/sonner";

function App() {
  return (
    <ConfigProvider>
      <div className="min-h-screen w-full bg-background text-foreground flex flex-col items-center p-4 sm:p-6">
        <Header />
        <Card className="w-full max-w-5xl shadow-2xl mb-32">
          
          <CardContent className="p-6 md:p-8">
            <SettingsLayout />
          </CardContent>
        </Card>
        <Toaster />
      </div>
    </ConfigProvider>
  );
}

export default App;

