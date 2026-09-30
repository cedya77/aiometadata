import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useConfig, type AppConfig } from "@/contexts/ConfigContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Callout } from "@/components/settings/Callout";
import { ManagerSync } from "@/components/ManagerSync";
import { Switch } from "@/components/ui/switch";
import { missingRequiredKeys, type KeyStatus } from "@/lib/configStatus";
import { navigateToSettingsSection } from "@/lib/settingsRoute";

const LazyInstallDialog = lazy(() =>
  import("@/components/InstallDialog").then((module) => ({ default: module.InstallDialog }))
);

export interface SavedConfig {
  userUUID: string;
  installUrl: string;
}

interface SaveContextType {
  /** Saves straight away when authenticated, otherwise opens the password dialog. */
  requestSave: () => void;
  isSaving: boolean;
  error: string;
  savedConfig: SavedConfig | null;
  markConfigPersisted: (persisted: AppConfig) => void;
  /** Null until a save target exists, so callers can tell "unknown" from "no changes". */
  isDirty: boolean | null;
  canSave: boolean;
  missingKeys: KeyStatus[];
  /** Opens the install dialog and rebaselines the manifest. */
  openInstall: (manifestUrl?: string) => void;
  installUrl: string;
}

const SaveContext = createContext<SaveContextType | undefined>(undefined);

/**
 * Key order is insertion order, so a config rebuilt by a section's setConfig can
 * serialize differently while holding identical values. Sorting keys keeps the
 * dirty check from firing on that.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

const reinstallNoticeKey = (uuid?: string | null) => `aiometadata-reinstall-notice-dismissed-${uuid ?? 'anon'}`;

function reinstallNoticeSuppressed(uuid?: string | null): boolean {
  try {
    return localStorage.getItem(reinstallNoticeKey(uuid)) === 'true';
  } catch {
    return false;
  }
}

/** The blurb is instance-specific and stripped before saving, so it must not count as a change. */
/** Credential pointers, written and removed by their own endpoints rather than by Save. */
const SELF_PERSISTING_KEYS = [
  'traktTokenId',
  'simklTokenId',
  'anilistTokenId',
  'malTokenId',
  'movieLensCredId',
];

function fingerprintConfig(config: AppConfig): string {
  // Connecting, disconnecting and syncing all persist as they go, so counting what they
  // touch would report unsaved work for changes already on disk. Save owns the rest.
  const { apiKeys, managers: _managers, managerAccounts: _managerAccounts, ...rest } = config as any;
  const trimmedApiKeys = Object.fromEntries(
    Object.entries(apiKeys ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])
  );
  delete (trimmedApiKeys as any).customDescriptionBlurb;
  for (const key of SELF_PERSISTING_KEYS) delete (trimmedApiKeys as any)[key];
  return stableStringify({ ...rest, apiKeys: trimmedApiKeys });
}

export function SaveProvider({ children }: { children: ReactNode }) {
  const {
    config,
    auth,
    setAuth,
    hasBuiltInTmdb,
    hasBuiltInTvdb,
    hasBuiltInGemini,
    isLoading: contextLoading,
    manifestChangedSinceInstall,
    markManifestInstalled,
  } = useConfig();

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [addonPassword, setAddonPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [requireAddonPassword, setRequireAddonPassword] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedConfig, setSavedConfig] = useState<SavedConfig | null>(null);
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null);
  const [reinstallModalOpen, setReinstallModalOpen] = useState(false);
  const [suppressReinstallNotice, setSuppressReinstallNotice] = useState(false);
  const [isInstallOpen, setIsInstallOpen] = useState(false);
  const [installUrl, setInstallUrl] = useState("");

  const caps = { hasBuiltInTmdb, hasBuiltInTvdb, hasBuiltInGemini };
  const missingKeys = useMemo(
    () => (contextLoading ? [] : missingRequiredKeys(config, caps)),
    [config, hasBuiltInTmdb, hasBuiltInTvdb, hasBuiltInGemini, contextLoading] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const canSave = !contextLoading && missingKeys.length === 0;

  useEffect(() => {
    fetch("/api/config/addon-info")
      .then(res => res.json())
      .then(data => setRequireAddonPassword(!!data.requiresAddonPassword))
      .catch(() => setRequireAddonPassword(false));
  }, []);

  // Whatever the server just handed back is by definition saved, so it becomes the
  // baseline. Keyed on the uuid so logging in re-baselines, and signing out clears it.
  const baselineUuid = useRef<string | null>(null);
  const baseVersion = useRef<number | null>(null);
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    if (contextLoading) return;
    if (!auth.authenticated || !auth.userUUID) {
      baselineUuid.current = null;
      baseVersion.current = null;
      setSavedFingerprint(null);
      return;
    }
    if (baselineUuid.current === auth.userUUID) return;
    baselineUuid.current = auth.userUUID;
    baseVersion.current = Number((config as { configVersion?: number }).configVersion) || null;
    setSavedFingerprint(fingerprintConfig(config));
  }, [contextLoading, auth.authenticated, auth.userUUID, config]);

  const saves = useMemo(() => {
    try {
      return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('aiom-config-saves');
    } catch {
      return null;
    }
  }, []);
  useEffect(() => () => saves?.close(), [saves]);
  useEffect(() => {
    if (!saves) return;
    const onSave = (event: MessageEvent) => {
      const { uuid, version } = event.data || {};
      if (!uuid || uuid !== auth.userUUID || baseVersion.current === null) return;
      if (!(Number(version) > baseVersion.current)) return;
      toast.warning('This configuration was saved in another tab', {
        id: 'config-saved-elsewhere',
        description: 'Reload before saving here, or those changes are undone.',
        duration: Infinity,
        action: { label: 'Reload', onClick: () => window.location.reload() },
      });
    };
    saves.addEventListener('message', onSave);
    return () => saves.removeEventListener('message', onSave);
  }, [saves, auth.userUUID]);

  // handleSave is declared before openInstall, so the toast action reaches it by ref.
  const openInstallRef = useRef<(manifestUrl?: string) => void>(() => {});

  // A route that saves the configuration itself leaves the page holding exactly what
  // is on disk, so the baseline moves with it instead of reporting unsaved work.
  const markConfigPersisted = useCallback((persisted: AppConfig) => {
    setSavedFingerprint(fingerprintConfig(persisted));
  }, []);

  const currentFingerprint = useMemo(() => fingerprintConfig(config), [config]);
  const isDirty = savedFingerprint === null ? null : currentFingerprint !== savedFingerprint;

  const handleSave = useCallback(async (force = false) => {
    setIsSaving(true);
    setError("");
    const missing = missingRequiredKeys(config, caps);
    if (missing.length > 0) {
      setError(`Missing required API keys: ${missing.map(k => k.name).join(', ')}`);
      setIsSaving(false);
      return;
    }
    const isAuthenticated = Boolean(auth.authenticated && auth.userUUID);
    try {
      const trimmedApiKeys = Object.fromEntries(
        Object.entries(config.apiKeys).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])
      );
      const configToSave = {
        ...config,
        apiKeys: {
          ...trimmedApiKeys,
          customDescriptionBlurb: undefined
        }
      };

      const response = isAuthenticated
        ? await fetch(`/api/config/update/${encodeURIComponent(auth.userUUID!)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              config: configToSave,
              password: auth.password,
              addonPassword,
              baseVersion: baseVersion.current ?? undefined,
              force,
            })
          })
        : await fetch('/api/config/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: configToSave, password, addonPassword })
          });
      if (response.status === 409) {
        const data = await response.clone().json().catch(() => null);
        if (data?.code === 'CONFIG_CHANGED') {
          setConflict(true);
          return;
        }
      }
      if (!response.ok) {
        let message = 'Failed to save configuration';
        try {
          const errorData = await response.json();
          message = errorData?.error || message;
        } catch (_) {
          const text = await response.text();
          if (text) message = text;
        }
        throw new Error(message);
      }
      let result: any;
      try {
        result = await response.json();
      } catch (_) {
        const text = await response.text();
        throw new Error(text || 'Invalid JSON response from server');
      }
      setSavedConfig(result);
      setSavedFingerprint(fingerprintConfig(config));
      const savedVersion = Number(result?.configVersion);
      if (Number.isFinite(savedVersion) && savedVersion > 0) {
        baseVersion.current = savedVersion;
        saves?.postMessage({ uuid: auth.userUUID ?? result?.userUUID, version: savedVersion });
      }
      if (!isAuthenticated && result?.userUUID) {
        setAuth({ authenticated: true, userUUID: result.userUUID, password, installUrl: result.installUrl ?? null });
        try { sessionStorage.removeItem('fromStremioSettings'); } catch {}
      }
      setShowPasswordDialog(false);
      setPassword("");
      setConfirmPassword("");
      setAddonPassword("");

      toast.success("Configuration saved successfully!");
      if (manifestChangedSinceInstall() && !reinstallNoticeSuppressed(auth.userUUID ?? result?.userUUID)) {
        setSuppressReinstallNotice(false);
        setReinstallModalOpen(true);
      } else {
        markManifestInstalled();
      }
    } catch (err) {
      console.error('Save configuration error:', err);
      setError(err instanceof Error ? err.message : 'Failed to save configuration');
    } finally {
      setIsSaving(false);
    }
  }, [config, auth, setAuth, password, addonPassword, hasBuiltInTmdb, hasBuiltInTvdb, manifestChangedSinceInstall, saves]); // eslint-disable-line react-hooks/exhaustive-deps

  const defaultInstallUrl = savedConfig?.installUrl ?? auth.installUrl ?? "";

  // Rebaselining on open rather than on a confirmed install is deliberate: there is no
  // signal for the latter, and pasting the url into any client counts as installing.
  const openInstall = useCallback((manifestUrl?: string) => {
    const url = manifestUrl || defaultInstallUrl;
    if (!url) {
      navigateToSettingsSection('configuration');
      return;
    }
    markManifestInstalled();
    setInstallUrl(url);
    setIsInstallOpen(true);
  }, [defaultInstallUrl, markManifestInstalled]);
  openInstallRef.current = openInstall;

  const requestSave = useCallback(() => {
    if (!canSave || isSaving) return;
    setError("");
    if (auth.authenticated) {
      void handleSave();
    } else {
      setShowPasswordDialog(true);
    }
  }, [canSave, isSaving, auth.authenticated, handleSave]);

  const canSubmitPasswordDialog = password.length >= 6 && password === confirmPassword;

  const submitPasswordDialog = () => {
    if (isSaving || !canSubmitPasswordDialog) return;
    void handleSave();
  };

  const handlePasswordDialogKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    submitPasswordDialog();
  };

  // Acknowledging rebaselines the manifest so the same change is only ever raised once,
  // whether or not the user installed there and then.
  const closeReinstallModal = (install: boolean) => {
    if (suppressReinstallNotice) {
      try { localStorage.setItem(reinstallNoticeKey(auth.userUUID), 'true'); } catch {}
    }
    setReinstallModalOpen(false);
    if (install) {
      openInstall();
    } else {
      markManifestInstalled();
    }
  };

  const value: SaveContextType = {
    requestSave,
    isSaving,
    error,
    savedConfig,
    isDirty,
    markConfigPersisted,
    canSave,
    missingKeys,
    openInstall,
    installUrl: defaultInstallUrl,
  };

  return (
    <SaveContext.Provider value={value}>
      {children}
      <Dialog open={conflict} onOpenChange={setConflict}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Configuration changed elsewhere</DialogTitle>
            <DialogDescription>
              This configuration was saved from another tab or device after this page loaded. Saving here would undo
              those changes. Reloading brings in the latest, but loses what you changed on this page since.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload latest
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConflict(false);
                void handleSave(true);
              }}
            >
              Save anyway
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={reinstallModalOpen} onOpenChange={(next) => { if (!next) closeReinstallModal(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reinstall Required</DialogTitle>
            <DialogDescription>
              Your changes affect the addon manifest (catalogs, search, or resources). Clients do not
              auto-reload manifests, so reinstall the addon for them to take effect.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <Label htmlFor="suppress-reinstall-notice" className="text-sm font-normal">
                Don't show this again
                <span className="mt-1 block text-xs text-muted-foreground">
                  Skip this notice for all future manifest changes.
                </span>
              </Label>
              <Switch
                id="suppress-reinstall-notice"
                checked={suppressReinstallNotice}
                onCheckedChange={setSuppressReinstallNotice}
              />
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {defaultInstallUrl ? (
                <ManagerSync baseInstallUrl={defaultInstallUrl} onSynced={() => closeReinstallModal(false)} />
              ) : null}
              <Button variant="outline" onClick={() => closeReinstallModal(false)}>Later</Button>
              <Button onClick={() => closeReinstallModal(true)}>Install</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {isInstallOpen ? (
        <Suspense fallback={null}>
          <LazyInstallDialog isOpen={isInstallOpen} onClose={() => setIsInstallOpen(false)} manifestUrl={installUrl} />
        </Suspense>
      ) : null}
      <Dialog open={!auth.authenticated && showPasswordDialog} onOpenChange={setShowPasswordDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Password</DialogTitle>
            <DialogDescription>
              Create a password to protect your configuration. You'll need this password to access your configuration later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {error && <Callout variant="danger">{error}</Callout>}
            <div className="space-y-2">
              <Label htmlFor="cfgmgr-password">Password</Label>
              <div className="relative">
                <Input
                  id="cfgmgr-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={handlePasswordDialogKeyDown}
                  placeholder="Enter your password"
                  minLength={6}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute right-2 top-1/2 -translate-y-1/2"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Password must be at least 6 characters long.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cfgmgr-confirm-password">Confirm Password</Label>
              <div className="relative">
                <Input
                  id="cfgmgr-confirm-password"
                  type={showConfirmPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  onKeyDown={handlePasswordDialogKeyDown}
                  placeholder="Confirm your password"
                  minLength={6}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute right-2 top-1/2 -translate-y-1/2"
                  aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                >
                  {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Must match the password above and be at least 6 characters.</p>
            </div>
            {requireAddonPassword && (
              <div className="space-y-2">
                <Label htmlFor="cfgmgr-addon-password">Addon Password</Label>
                <Input
                  id="cfgmgr-addon-password"
                  type="password"
                  value={addonPassword}
                  onChange={e => setAddonPassword(e.target.value)}
                  onKeyDown={handlePasswordDialogKeyDown}
                  placeholder="Enter the addon password"
                  minLength={6}
                />
                <p className="text-xs text-muted-foreground mt-1">Required by the addon administrator.</p>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowPasswordDialog(false)}>
                Cancel
              </Button>
              <Button onClick={submitPasswordDialog} disabled={isSaving || !canSubmitPasswordDialog}>
                {isSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Save Configuration'
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </SaveContext.Provider>
  );
}

export const useSave = () => {
  const context = useContext(SaveContext);
  if (context === undefined) {
    throw new Error('useSave must be used within a SaveProvider');
  }
  return context;
};
