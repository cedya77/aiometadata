import { ThemeToggle } from '../ThemeToggle';
import { useConfig } from '../../contexts/ConfigContext';
import { Button } from '@/components/ui/button';
import { useEffect, useState } from 'react';
import { InstallDialog } from '../InstallDialog';
import { toast } from 'sonner';
import { compressToEncodedURIComponent } from 'lz-string';
import { LogIn, LogOut, Eye, EyeOff } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
export function Header() {
  const { addonVersion, config, setConfig, resetConfig, auth, setAuth } = useConfig();
  const isLoggedIn = auth.authenticated;
  const [isInstallOpen, setIsInstallOpen] = useState(false);
  const [manifestUrl, setManifestUrl] = useState('');
  const [authTransitioning, setAuthTransitioning] = useState(false);
  
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

  // Extract UUID from URL if it's a Stremio URL
  useEffect(() => {
    try {
      const pathParts = window.location.pathname.split('/');
      const stremioIndex = pathParts.findIndex(p => p === 'stremio');
      if (stremioIndex !== -1 && pathParts[stremioIndex + 1]) {
        const potentialUUID = pathParts[stremioIndex + 1];
        // Check if it's a valid UUID format
        if (potentialUUID.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
          setUuidFromUrl(potentialUUID);
          setUuidInput(potentialUUID);
        }
      }
    } catch {}
  }, []);

  // If opened from Stremio settings URL, prompt login on first load
  useEffect(() => {
    try {
      // Check if we came from a Stremio URL (either current or in sessionStorage)
      const isFromStremio = window.location.pathname.includes('/stremio/') || 
                           sessionStorage.getItem('fromStremioSettings') === 'true';
      
      if (!auth.authenticated && isFromStremio) {
        // Clear the flag
        sessionStorage.removeItem('fromStremioSettings');
        // defer to ensure dialog mounts after first paint
        setTimeout(() => setIsLoginOpen(true), 100);
      }
    } catch {}
    // run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Set flag when landing on Stremio URL
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

  // Watch for uuidInput changes and check trust status
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

  const openInstall = () => {
    const tmdbKey = config.apiKeys.tmdb?.trim();
    const tvdbKey = config.apiKeys.tvdb?.trim();
    if (!tmdbKey) {
      toast.error('TMDB API Key is Required', {
        description:
          "Please go to the 'Integrations' tab and enter your TMDB API key. This is the primary data source for the addon.",
        duration: 5000,
      });
      return;
    }
    if (!tvdbKey) {
      toast.error('TVDB API Key is Required', {
        description:
          "Please go to the 'Integrations' tab and enter your TVDB API key. This is required for series and anime metadata.",
        duration: 5000,
      });
      return;
    }

    const configToSerialize = {
      language: config.language,
      includeAdult: config.includeAdult,
      blurThumbs: config.blurThumbs,
      showPrefix: config.showPrefix,
      providers: config.providers,
      tvdbSeasonType: config.tvdbSeasonType,
      apiKeys: config.apiKeys,
      ageRating: config.ageRating,
      catalogs: config.catalogs.filter((c) => c.enabled),
      castCount: config.castCount,
      search: config.search,
    };
    const compressedConfig = compressToEncodedURIComponent(
      JSON.stringify(configToSerialize)
    );
    const host = `${window.location.protocol}//${window.location.host}`;
    const generatedManifestUrl = `${host}/stremio/preview/${compressedConfig}/manifest.json`;
    setManifestUrl(generatedManifestUrl);
    setIsInstallOpen(true);
  };

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
      setConfig(result.config);
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
    <header className="w-full max-w-5xl flex items-center justify-between py-6 sm:py-8">
      <div className="flex items-center space-x-4">
        {/* The Logo Image */}
        <img 
          src="/logo.png" // This path is correct because the image is in the `public` folder
          alt="AIO-Metadata Addon Logo" 
          className="h-12 w-12 sm:h-16 sm:w-16" // Responsive size
        />
        
        {/* The Title and Subtitle */}
        <div className="text-left">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground">
            AIOMetadata <span className="text-sm text-muted-foreground">v{addonVersion}</span>
          </h1>
          <p className="text-md text-muted-foreground mt-1">
            Your one-stop-shop for Stremio metadata.
          </p>
        </div>
      </div>

      {/* Theme Toggle and persistent Install button */}
      <div className="flex items-center gap-3">
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
                // Refresh the page to ensure clean state
                window.location.reload();
              }, 300);
            }}
            variant="outline"
            size="icon"
            aria-label="Sign out"
          >
            <LogOut className="h-5 w-5" />
          </Button>
        ) : (
          <Button onClick={() => { if (!authTransitioning) setIsLoginOpen(true); }} variant="outline" size="icon" aria-label="Log in">
            <LogIn className="h-5 w-5" />
          </Button>
        )}
        <ThemeToggle />
      </div>

      {/* InstallDialog removed from header; it now lives in Configuration tab */}

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
              <Button variant="outline" onClick={() => setIsLoginOpen(false)}>Cancel</Button>
              <Button onClick={handleLogin} disabled={isLoading}>{isLoading ? 'Loading…' : 'Load'}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </header>
  );
}
