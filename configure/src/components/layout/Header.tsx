import { lazy, Suspense, useEffect, useState } from 'react';
import { ThemeToggle } from '../ThemeToggle';
import { useConfig } from '../../contexts/ConfigContext';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Bell, LogIn, LogOut, Eye, EyeOff, BarChart3, Pencil, Check, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const LazyChangelogModal = lazy(() =>
  import('../ChangelogBox').then((module) => ({ default: module.ChangelogModal }))
);

export function Header() {
  const { addonVersion, config, setConfig, resetConfig, auth, setAuth } = useConfig();
  const isLoggedIn = auth.authenticated;
  const [authTransitioning, setAuthTransitioning] = useState(false);
  const [shouldLoadChangelog, setShouldLoadChangelog] = useState(false);
  const [isChangelogOpen, setIsChangelogOpen] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [uuidInput, setUuidInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [uuidFromUrl, setUuidFromUrl] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [requireAddonPassword, setRequireAddonPassword] = useState(false);
  const [addonPasswordInput, setAddonPasswordInput] = useState("");
  const [isUUIDTrusted, setIsUUIDTrusted] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      if (window.location.pathname.includes('/configure')) {
        sessionStorage.setItem(
          'lastConfigureUrl',
          window.location.pathname + window.location.search + window.location.hash
        );
      }
    } catch {}
  }, []);

  const handleLogoClick = () => {
    if (typeof window === 'undefined') return;
    const currentPath = window.location.pathname;
    if (currentPath.startsWith('/dashboard')) {
      const stored = sessionStorage.getItem('lastConfigureUrl');
      window.location.href = stored || '/configure';
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  useEffect(() => {
    try {
      const pathParts = window.location.pathname.split('/');
      const stremioIndex = pathParts.findIndex(p => p === 'stremio');
      if (stremioIndex !== -1 && pathParts[stremioIndex + 1]) {
        const potentialUUID = pathParts[stremioIndex + 1];
        if (potentialUUID.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
          setUuidFromUrl(potentialUUID);
          setUuidInput(potentialUUID);
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    try {
      const isFromStremio = window.location.pathname.includes('/stremio/') || 
                           sessionStorage.getItem('fromStremioSettings') === 'true';
      
      // Don't prompt for login on dashboard route
      const isDashboardRoute = window.location.pathname === '/dashboard' || window.location.pathname === '/dashboard/';
      
      if (!auth.authenticated && isFromStremio && !isDashboardRoute) {
        sessionStorage.removeItem('fromStremioSettings');
        setTimeout(() => setIsLoginOpen(true), 100);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (window.location.pathname.includes('/stremio/')) {
      sessionStorage.setItem('fromStremioSettings', 'true');
    }
  }, []);

  useEffect(() => {
    fetch("/api/config/addon-info")
      .then(res => res.json())
      .then(data => setRequireAddonPassword(!!data.requiresAddonPassword))
      .catch(() => setRequireAddonPassword(false));
  }, []);

  useEffect(() => {
    if (uuidInput && uuidInput.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      fetch(`/api/config/is-trusted/${encodeURIComponent(uuidInput)}`)
        .then(res => res.json())
        .then(data => {
          setIsUUIDTrusted(!!data.trusted);
          setRequireAddonPassword(!!data.requiresAddonPassword);
        })
        .catch(() => {
          setIsUUIDTrusted(null);
          setRequireAddonPassword(false);
        });
    } else {
      setIsUUIDTrusted(null);
      setRequireAddonPassword(false);
    }
  }, [uuidInput]);

  const handleLogin = async () => {
    setIsLoading(true);
    setLoginError('');
    try {
      if (!uuidInput || !passwordInput) {
        setLoginError('UUID and password are required');
        setIsLoading(false);
        return;
      }
      const response = await fetch(`/api/config/load/${encodeURIComponent(uuidInput)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordInput, addonPassword: addonPasswordInput })
      });
      if (!response.ok) {
        let message = 'Failed to load configuration';
        try {
          const err = await response.json();
          message = err?.error || message;
        } catch {}
        throw new Error(message);
      }
      const result = await response.json();
      if (!result?.success || !result?.config) {
        throw new Error('Invalid response from server');
      }
      setConfig({ ...result.config, catalogSetupComplete: true });
      setAuth({ authenticated: true, userUUID: uuidInput, password: passwordInput });
      toast.success('Configuration loaded');
      setIsLoginOpen(false);
      setUuidInput('');
      setPasswordInput('');
      setAddonPasswordInput('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load configuration';
      setLoginError(msg);
      toast.error(msg);
    } finally {
      setIsLoading(false);
    }
  };
  return (
    <header className="w-full max-w-5xl py-6 sm:py-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center space-x-4">
          <button
            type="button"
            onClick={handleLogoClick}
            className="group flex items-center focus:outline-none"
            aria-label="Return to configuration"
          >
            <img 
              src="/logo.png"
              alt="AIO-Metadata Addon Logo" 
              className="h-12 w-12 sm:h-16 sm:w-16 transition-transform group-hover:scale-105"
            />
          </button>
          <div className="text-left">
            <div className="flex items-center gap-2">
              {isEditingName ? (
                <div className="flex items-center gap-1.5">
                  <Input
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        setConfig(prev => ({ ...prev, addonName: nameInput.trim() }));
                        setIsEditingName(false);
                      } else if (e.key === 'Escape') {
                        setIsEditingName(false);
                      }
                    }}
                    className="text-2xl sm:text-3xl font-bold h-auto py-0.5 px-1.5 w-[200px] sm:w-[280px]"
                    autoFocus
                    placeholder="AIOMetadata"
                  />
                  <button
                    onClick={() => {
                      setConfig(prev => ({ ...prev, addonName: nameInput.trim() }));
                      setIsEditingName(false);
                    }}
                    className="p-1 text-muted-foreground hover:text-foreground"
                    aria-label="Save name"
                  >
                    <Check className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setIsEditingName(false)}
                    className="p-1 text-muted-foreground hover:text-foreground"
                    aria-label="Cancel"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <>
                  <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground">
                    {config.addonName || 'AIOMetadata'}
                  </h1>
                  <button
                    onClick={() => {
                      setNameInput(config.addonName || 'AIOMetadata');
                      setIsEditingName(true);
                    }}
                    className="p-1 text-muted-foreground hover:text-foreground"
                    aria-label="Edit addon name"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <span className="text-sm text-muted-foreground">v{addonVersion}</span>
                </>
              )}
            </div>
            <p className="text-md text-muted-foreground mt-1">
              Your one-stop-shop for Stremio metadata.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <Button
            variant="outline"
            size="sm"
            className="gap-2 text-xs sm:text-sm"
            onClick={() => {
              setShouldLoadChangelog(true);
              setIsChangelogOpen(true);
            }}
          >
            <Bell className="h-4 w-4" />
            <span className="hidden sm:inline">What's New</span>
            <span className="sm:hidden">Updates</span>
          </Button>
          {shouldLoadChangelog ? (
            <Suspense fallback={null}>
              <LazyChangelogModal
                version={`v${addonVersion}`}
                open={isChangelogOpen}
                onOpenChange={setIsChangelogOpen}
                hideTrigger
              />
            </Suspense>
          ) : null}
        <button
          onClick={() => {
            window.open('https://buymeacoffee.com/cedya', '_blank');
          }}
          aria-label="Buy me a coffee"
          title="Buy me a coffee"
          className="hidden sm:inline-block"
        >
          <img
            src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png"
            alt="Buy Me A Coffee"
            className="h-8 sm:h-10 w-auto hover:opacity-90 transition-opacity"
          />
        </button>
        <Button
          onClick={() => {
            const host = `${window.location.protocol}//${window.location.host}`;
            window.open(`${host}/dashboard`, '_blank');
          }}
          variant="outline"
          size="icon"
          aria-label="Open Dashboard"
          title="Open Dashboard"
          className="h-8 w-8 sm:h-10 sm:w-10"
        >
          <BarChart3 className="h-4 w-4 sm:h-5 sm:w-5" />
        </Button>
        {isLoggedIn ? (
          <Button
            onClick={async () => {
              setAuthTransitioning(true);
              setIsLoginOpen(false);
              await resetConfig();
              setAuth({ authenticated: false, userUUID: null, password: null });
              toast.success('Signed out and reset configuration');
              setTimeout(() => {
                setAuthTransitioning(false);
                window.location.href = '/configure';
              }, 300);
            }}
            variant="outline"
            size="icon"
            aria-label="Sign out"
            className="h-8 w-8 sm:h-10 sm:w-10"
          >
            <LogOut className="h-4 w-4 sm:h-5 sm:w-5" />
          </Button>
        ) : (
          <Button 
            onClick={() => { if (!authTransitioning) setIsLoginOpen(true); }} 
            variant="outline" 
            size="icon" 
            aria-label="Log in"
            className="h-8 w-8 sm:h-10 sm:w-10"
          >
            <LogIn className="h-4 w-4 sm:h-5 sm:w-5" />
          </Button>
        )}
        <ThemeToggle />
        </div>
      </div>

      <Dialog
        open={isLoginOpen}
        onOpenChange={(next) => {
          if (authTransitioning) return;
          setIsLoginOpen(next);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Load Saved Configuration</DialogTitle>
            <DialogDescription>Enter your UUID and password{requireAddonPassword ? ' and addon password' : ''} to load your saved configuration.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault(); // Prevent page reload
              handleLogin();
            }}
          >
            <div className="space-y-4">
              {loginError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">
                  {loginError}
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="uuid">UUID</Label>
                <Input 
                  id="uuid" 
                  value={uuidInput} 
                  onChange={(e) => setUuidInput(e.target.value)} 
                  placeholder="Your UUID" 
                  disabled={!!uuidFromUrl}
                  className={uuidFromUrl ? "bg-gray-50 text-gray-500 cursor-not-allowed" : ""}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Input 
                    id="password" 
                    type={showPassword ? "text" : "password"} 
                    value={passwordInput} 
                    onChange={(e) => setPasswordInput(e.target.value)} 
                    placeholder="Your password" 
                  />
                  <Button
                    type="button" // Important: prevent form submission
                    variant="ghost"
                    size="sm"
                    className="absolute right-2 top-1/2 -translate-y-1/2"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              {requireAddonPassword && isUUIDTrusted === false && (
                <div className="space-y-2">
                  <Label htmlFor="addonPassword">Addon Password</Label>
                  <Input
                    id="addonPassword"
                    type="password"
                    value={addonPasswordInput}
                    onChange={e => setAddonPasswordInput(e.target.value)}
                    placeholder="Enter the addon password"
                    minLength={6}
                  />
                  <p className="text-xs text-muted-foreground mt-1">Required by the addon administrator.</p>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button 
                  type="button" // Keep as button to prevent form submission
                  variant="outline" 
                  onClick={() => setIsLoginOpen(false)}
                >
                  Cancel
                </Button>
                <Button 
                  type="submit" // Change to submit to trigger form submission
                  disabled={isLoading}
                >
                  {isLoading ? 'Loading…' : 'Load'}
                </Button>
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </header>
  );
}
