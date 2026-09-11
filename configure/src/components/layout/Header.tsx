import { lazy, Suspense, useEffect, useState } from 'react';
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
  const [profiles, setProfiles] = useState<Array<{ userUUID: string; label: string }>>([]);
  const [editingProfile, setEditingProfile] = useState<string | null>(null);
  const [profileLabel, setProfileLabel] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [autoLoadTried, setAutoLoadTried] = useState(false);
  const [saveToAccount, setSaveToAccount] = useState(true);
  /** The URL may name an alias, so ownership is settled by the auto-load, not a string match. */
  const [ownsUrlConfig, setOwnsUrlConfig] = useState(false);
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
        // May be a UUID or a user alias.
        const potentialId = pathParts[stremioIndex + 1];
        if (/^[A-Za-z0-9_-]{3,}$/.test(potentialId)) {
          setUuidFromUrl(potentialId);
          setUuidInput(potentialId);
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
    if (uuidInput && /^[A-Za-z0-9_-]{3,}$/.test(uuidInput)) {
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

  // Only meaningful while the dialog is open, and silent when the instance has
  // no identity provider.
  useEffect(() => {
    if (!isLoginOpen) return;
    let cancelled = false;

    (async () => {
      try {
        const status = await fetch('/api/auth/status').then(r => (r.ok ? r.json() : null));
        if (cancelled || !status) return;
        setSsoEnabled(Boolean(status.oidcEnabled));
        setSignedIn(Boolean(status.signedIn));
        if (!status.signedIn) {
          setProfiles([]);
          return;
        }
        const saved = await fetch('/api/profiles').then(r => (r.ok ? r.json() : null));
        if (!cancelled && saved) setProfiles(saved.profiles || []);
      } catch {
        if (!cancelled) setProfiles([]);
      }
    })();

    return () => { cancelled = true; };
  }, [isLoginOpen]);

  const applyLoadedConfig = (result: any, password: string, fallbackUUID: string) => {
    setConfig(prev => ({
      ...result.config,
      catalogSetupComplete: true,
      apiKeys: {
        ...result.config.apiKeys,
        customDescriptionBlurb: prev.apiKeys.customDescriptionBlurb,
      },
    }));
    setAuth({
      authenticated: true,
      userUUID: result.userUUID || fallbackUUID,
      password,
      installUrl: result.installUrl ?? null,
    });
    try { sessionStorage.removeItem('fromStremioSettings'); } catch {}
    toast.success('Configuration loaded');
    setIsLoginOpen(false);
    setUuidInput('');
    setPasswordInput('');
    setAddonPasswordInput('');
  };

  /**
   * Arriving at a configure URL for a configuration saved to your account opens
   * it straight away, which is the point of saving it. Anything not saved falls
   * through to the usual prompt.
   */
  useEffect(() => {
    if (!uuidFromUrl || auth.authenticated || autoLoadTried) return;
    setAutoLoadTried(true);

    (async () => {
      try {
        const status = await fetch('/api/auth/status').then(r => (r.ok ? r.json() : null));
        if (!status?.signedIn) return;
        // Just ask. The identifier in the URL may be an alias, which only the
        // server can match against what the account owns; a refusal falls
        // through to the usual prompt.
        const opened = await handleLoadProfile(uuidFromUrl, { quiet: true });
        setOwnsUrlConfig(opened);
      } catch {
        // Falls through to the normal prompt.
      }
    })();
  }, [uuidFromUrl, auth.authenticated, autoLoadTried]); // eslint-disable-line react-hooks/exhaustive-deps

  /** No password: the session already proved this configuration is theirs. */
  const handleLoadProfile = async (userUUID: string, options: { quiet?: boolean } = {}): Promise<boolean> => {
    // A configuration is only restored on refresh if the address bar names it.
    // Loading one in place while the URL names another leaves the two
    // disagreeing; loading one while the URL names nothing survives until the
    // next reload and then looks like being signed out. Either way, go to its
    // own URL, which opens it on arrival and keeps the section in view.
    if (uuidFromUrl !== userUUID) {
      const section = window.location.hash || '';
      window.location.href = `/stremio/${encodeURIComponent(userUUID)}/configure${section}`;
      return false;
    }

    setIsLoading(true);
    setLoginError('');
    try {
      const response = await fetch(`/api/config/load/${encodeURIComponent(userUUID)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => null);
        throw new Error(err?.error || 'Failed to load configuration');
      }
      const result = await response.json();
      if (!result?.success || !result?.config) throw new Error('Invalid response from server');
      applyLoadedConfig(result, '', userUUID);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load configuration';
      if (!options.quiet) {
        setLoginError(msg);
        toast.error(msg);
      }
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const startEditingProfile = (profile: { userUUID: string; label: string }) => {
    setEditingProfile(profile.userUUID);
    setProfileLabel(profile.label);
    setConfirmRemove(false);
  };

  const stopEditingProfile = () => {
    setEditingProfile(null);
    setProfileLabel('');
    setConfirmRemove(false);
  };

  const handleRenameProfile = async (userUUID: string) => {
    const label = profileLabel.trim();
    if (!label) return;
    setProfileBusy(true);
    try {
      const response = await fetch(`/api/profiles/${encodeURIComponent(userUUID)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || 'Could not rename this configuration');
      const next = result?.label || label;
      setProfiles(prev => prev.map(p => (p.userUUID === userUUID ? { ...p, label: next } : p)));
      stopEditingProfile();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not rename this configuration');
    } finally {
      setProfileBusy(false);
    }
  };

  /** Unlinks from the account. The configuration and its password are untouched. */
  const handleRemoveProfile = async (userUUID: string) => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setProfileBusy(true);
    try {
      const response = await fetch(`/api/profiles/${encodeURIComponent(userUUID)}`, { method: 'DELETE' });
      if (!response.ok) {
        const err = await response.json().catch(() => null);
        throw new Error(err?.error || 'Could not remove this configuration');
      }
      setProfiles(prev => prev.filter(p => p.userUUID !== userUUID));
      stopEditingProfile();
      toast.success('Removed from your account', {
        description: 'Its UUID and password still work.',
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove this configuration');
    } finally {
      setProfileBusy(false);
    }
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
      // The password is in hand and verified, so this is the moment to link it.
      // Making the user find another tab afterwards loses most of the benefit.
      if (signedIn && saveToAccount) {
        try {
          const linked = await fetch('/api/profiles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userUUID: result.userUUID || uuidInput,
              password: passwordInput,
              label: result.config?.addonName?.trim() || (result.userUUID || uuidInput).slice(0, 8),
            }),
          });
          if (linked.ok) {
            toast.success('Saved to your account', {
              description: 'Signing in is enough to open it from now on.',
            });
          }
        } catch {
          // The configuration still loaded; linking can be retried later.
        }
      }

      // Prefer the canonical UUID the server resolved, so an alias typed at
      // login does not propagate into later update calls and OAuth redirects.
      applyLoadedConfig(result, passwordInput, uuidInput);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load configuration';
      setLoginError(msg);
      toast.error(msg);
    } finally {
      setIsLoading(false);
    }
  };
  return (
    <header className="w-full py-6 sm:py-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex flex-col items-center sm:flex-row sm:items-center sm:space-x-4 gap-2 sm:gap-0">
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
          <div className="text-center sm:text-left">
            <div className="flex items-center justify-center sm:justify-start gap-2 flex-wrap">
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
                    className="p-1 text-muted-foreground hover:text-foreground shrink-0"
                    aria-label="Edit addon name"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <span className="text-sm text-muted-foreground shrink-0 max-w-[120px] sm:max-w-none truncate" title={`v${addonVersion}`}>v{addonVersion}</span>
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
        </div>
      </div>

      <Dialog
        open={isLoginOpen}
        onOpenChange={(next) => {
          if (authTransitioning) return;
          if (!next) stopEditingProfile();
          setIsLoginOpen(next);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Load Saved Configuration</DialogTitle>
            <DialogDescription>Enter your UUID and password{requireAddonPassword ? ' and addon password' : ''} to load your saved configuration.</DialogDescription>
          </DialogHeader>

          {/* The URL names one configuration; saved ones for anything else are a
              detour, so they are labelled as such rather than sitting on top. */}
          {signedIn && uuidFromUrl && !ownsUrlConfig && (
            <p className="rounded-md border bg-muted/30 p-2 text-[11px] text-muted-foreground">
              This configuration is not saved to your account yet. Enter its password once with the box below
              ticked and it will open on its own from now on.
            </p>
          )}

          {profiles.length > 0 && (
            <div className="space-y-2 border-b pb-4">
              <Label className="text-xs text-muted-foreground">
                {uuidFromUrl && !ownsUrlConfig
                  ? 'Or open a different one you saved'
                  : 'Saved to your account'}
              </Label>
              <div className="space-y-1">
                {profiles.map(profile => (
                  editingProfile === profile.userUUID ? (
                    <div key={profile.userUUID} className="space-y-1 rounded-md border p-2">
                      <div className="flex items-center gap-1">
                        <Input
                          value={profileLabel}
                          maxLength={64}
                          autoFocus
                          disabled={profileBusy}
                          onChange={e => setProfileLabel(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleRenameProfile(profile.userUUID);
                            } else if (e.key === 'Escape') {
                              stopEditingProfile();
                            }
                          }}
                          className="h-9 text-sm"
                          aria-label="Configuration name"
                        />
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-9 w-9 shrink-0"
                          aria-label="Save name"
                          disabled={profileBusy || !profileLabel.trim()}
                          onClick={() => handleRenameProfile(profile.userUUID)}
                        >
                          <Check className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-9 w-9 shrink-0"
                          aria-label="Cancel"
                          disabled={profileBusy}
                          onClick={stopEditingProfile}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                      <button
                        type="button"
                        disabled={profileBusy}
                        onClick={() => handleRemoveProfile(profile.userUUID)}
                        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-destructive hover:underline"
                      >
                        {confirmRemove
                          ? 'Click again to remove it from your account'
                          : 'Remove from your account'}
                      </button>
                    </div>
                  ) : (
                    <div key={profile.userUUID} className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        className="min-w-0 flex-1 justify-start"
                        disabled={isLoading}
                        onClick={() => handleLoadProfile(profile.userUUID)}
                      >
                        <span className="truncate">{profile.label}</span>
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-9 w-9 shrink-0"
                        aria-label={`Rename ${profile.label}`}
                        disabled={isLoading}
                        onClick={() => startEditingProfile(profile)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )
                ))}
              </div>
            </div>
          )}

          {signedIn && (
            <label className="flex items-start gap-2 rounded-md border bg-muted/30 p-2 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={saveToAccount}
                onChange={event => setSaveToAccount(event.target.checked)}
              />
              <span>
                Save this to your account. You are signed in, so after this you can open it without its UUID
                or password.
              </span>
            </label>
          )}

          {ssoEnabled && !signedIn && (
            <div className="border-b pb-4">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => {
                  const next = encodeURIComponent(window.location.pathname + window.location.search);
                  window.location.href = `/api/auth/oidc/start?next=${next}`;
                }}
              >
                Sign in with SSO
              </Button>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Sign in to pick a saved configuration instead of typing its UUID and password.
              </p>
            </div>
          )}

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
                  name="username"
                  autoComplete="username"
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
                    name="password"
                    autoComplete="current-password"
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
                    name="addon-password"
                    autoComplete="off"
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
