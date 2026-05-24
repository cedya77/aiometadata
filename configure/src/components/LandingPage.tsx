import { Settings, BarChart3, BookOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConfig } from '../contexts/ConfigContext';

export function LandingPage() {
  const { config } = useConfig();
  const addonName = config.addonName || 'AIOMetadata';

  return (
    <div className="dark min-h-screen w-full bg-background text-foreground flex flex-col items-center justify-center p-8">
      <div className="flex flex-col items-center gap-8 text-center max-w-md">
        <img
          src="/logo.png"
          alt="AIOMetadata logo"
          className="h-24 w-24 drop-shadow-[0_0_20px_rgba(255,255,255,0.15)]"
        />

        <div className="space-y-2">
          <h1 className="text-4xl font-bold tracking-tight">{addonName}</h1>
          <p className="text-muted-foreground text-lg">All-in-one metadata addon for Stremio</p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 w-full sm:w-auto">
          <Button
            size="lg"
            className="sm:min-w-[140px]"
            onClick={() => { window.location.href = '/configure'; }}
          >
            <Settings className="h-4 w-4" />
            Configure
          </Button>

          <Button
            size="lg"
            variant="outline"
            className="sm:min-w-[140px]"
            onClick={() => { window.location.href = '/dashboard'; }}
          >
            <BarChart3 className="h-4 w-4" />
            Dashboard
          </Button>

          <Button
            size="lg"
            variant="outline"
            className="sm:min-w-[140px]"
            onClick={() => window.open('https://github.com/aghermida/aiometadata', '_blank', 'noopener,noreferrer')}
          >
            <BookOpen className="h-4 w-4" />
            Documentation
          </Button>
        </div>
      </div>
    </div>
  );
}
