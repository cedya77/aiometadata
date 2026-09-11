import { lazy, Suspense, useState, useEffect, useMemo } from "react";
import { useConfig } from "@/contexts/ConfigContext";
import { useSave } from "@/contexts/SaveContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Copy, Loader2, Save, Key, User, Download, List } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { TagChip } from "@/components/TagChip";
import { AGE_RATING_ORDER } from "@/lib/ageRatings";
import type { TagDef } from "@/contexts/config";
import { ManagerSync } from "@/components/ManagerSync";
import { JellyfinDialog } from "@/components/JellyfinDialog";
import { cn } from "@/lib/utils";
import { keyStatuses } from "@/lib/configStatus";
import { Callout } from "@/components/settings/Callout";
import { ConfigStatusPanel, CONFIG_STATUS_SUMMARY_ID } from "@/components/settings/ConfigStatusPanel";
import { SettingRow } from "@/components/settings/SettingRow";

interface SavedConfig {
  userUUID: string;
  installUrl: string;
}

const LazyConfigImportExport = lazy(() =>
  import("@/components/ConfigImportExport").then((module) => ({ default: module.ConfigImportExport }))
);


/** Past this many, names stop being scannable and a count reads better. */
const MAX_NAMED_TAGS = 4;

function joinTagNames(names: string[]) {
  return names.map((name, i) => (
    <span key={name}>
      {i > 0 && (i === names.length - 1 ? ' or ' : ', ')}
      <span className="font-medium">{name}</span>
    </span>
  ));
}

function ConfigurationSectionFallback() {
  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-5">
      <div className="text-sm font-medium text-muted-foreground">Loading configuration tools...</div>
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

export function ConfigurationManager() {
  const { config, setConfig, auth, setAuth, hasBuiltInTvdb, hasBuiltInTmdb, hasBuiltInGemini, isLoading: contextLoading, manifestChangedSinceInstall, markManifestInstalled } = useConfig();
  const { requestSave, isSaving, error, savedConfig, canSave, missingKeys, openInstall } = useSave();
  const [selectedTagNames, setSelectedTagNames] = useState<string[]>([]);

  const [requireAddonPassword, setRequireAddonPassword] = useState(false);
  const [showLoadDialog, setShowLoadDialog] = useState(false);
  const [loadPassword, setLoadPassword] = useState("");
  const [loadAddonPassword, setLoadAddonPassword] = useState("");
  const [loadError, setLoadError] = useState("");
  const [isLoadingLoad, setIsLoadingLoad] = useState(false);
  const [isUUIDTrusted, setIsUUIDTrusted] = useState<boolean | null>(null);

  const caps = { hasBuiltInTmdb, hasBuiltInTvdb, hasBuiltInGemini };
  const statuses = useMemo(
    () => keyStatuses(config, caps),
    [config, hasBuiltInTmdb, hasBuiltInTvdb, hasBuiltInGemini] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const identity: SavedConfig | null = useMemo(
    () => savedConfig
      ?? (auth.authenticated && auth.userUUID && auth.installUrl
        ? { userUUID: auth.userUUID, installUrl: auth.installUrl }
        : null),
    [savedConfig, auth.authenticated, auth.userUUID, auth.installUrl],
  );

  useEffect(() => {
    fetch("/api/config/addon-info")
      .then(res => res.json())
      .then(data => setRequireAddonPassword(!!data.requiresAddonPassword))
      .catch(() => setRequireAddonPassword(false));
  }, []);

  useEffect(() => {
    const uuid = savedConfig?.userUUID ?? (auth.authenticated ? auth.userUUID : null);
    if (uuid && /^[A-Za-z0-9_-]{3,}$/.test(uuid)) {
      fetch(`/api/config/is-trusted/${encodeURIComponent(uuid)}`)
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
  }, [savedConfig?.userUUID, auth.authenticated, auth.userUUID]);

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied to clipboard!`);
    } catch (err) {
      console.error('Copy failed:', err);
      toast.error('Failed to copy to clipboard');
    }
  };

  const handleLoadConfiguration = async () => {
    if (!identity?.userUUID) return;
    setIsLoadingLoad(true);
    setLoadError("");
    try {
      const response = await fetch(`/api/config/load/${encodeURIComponent(identity.userUUID)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: loadPassword, addonPassword: loadAddonPassword })
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to load configuration');
      }
      const result = await response.json();
      if (!result?.success || !result?.config) {
        throw new Error('Invalid response from server');
      }
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
        userUUID: result.userUUID || identity.userUUID,
        password: loadPassword,
        installUrl: result.installUrl ?? null,
      });
      toast.success("Configuration loaded successfully!");
      setShowLoadDialog(false);
      setLoadPassword("");
      setLoadAddonPassword("");
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load configuration');
    } finally {
      setIsLoadingLoad(false);
    }
  };

  // Linking needs the password once, so it is only offered while the
  // configuration is open with one in hand.
  const [ssoState, setSsoState] = useState<{ signedIn: boolean; saved: boolean; label: string }>({
    signedIn: false,
    saved: false,
    label: "",
  });
  const [linking, setLinking] = useState(false);
  const [labelInput, setLabelInput] = useState("");
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await fetch('/api/auth/status').then(r => (r.ok ? r.json() : null));
        if (cancelled || !status?.signedIn) return;
        const saved = await fetch('/api/profiles').then(r => (r.ok ? r.json() : null));
        const uuid = identity?.userUUID;
        if (cancelled) return;
        const mine = uuid ? (saved?.profiles || []).find((p: any) => p.userUUID === uuid) : null;
        setSsoState({ signedIn: true, saved: Boolean(mine), label: mine?.label || "" });
        setLabelInput(mine?.label || "");
      } catch {
        if (!cancelled) setSsoState({ signedIn: false, saved: false, label: "" });
      }
    })();
    return () => { cancelled = true; };
  }, [identity?.userUUID]);

  const handleSaveToAccount = async () => {
    if (!identity?.userUUID || !auth.password) return;
    const label = labelInput.trim() || config.addonName?.trim() || identity.userUUID.slice(0, 8);
    setLinking(true);
    try {
      const response = await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userUUID: identity.userUUID,
          password: auth.password,
          label,
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || 'Could not save this configuration');
      setSsoState(prev => ({ ...prev, saved: true, label: result?.label || label }));
      setLabelInput(result?.label || label);
      toast.success('Saved to your account', {
        description: 'Sign in and pick it from the list instead of typing its UUID and password.',
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save this configuration');
    } finally {
      setLinking(false);
    }
  };

  const handleRenameProfile = async () => {
    const label = labelInput.trim();
    if (!identity?.userUUID || !label || label === ssoState.label) return;
    setRenaming(true);
    try {
      const response = await fetch(`/api/profiles/${encodeURIComponent(identity.userUUID)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || 'Could not rename this configuration');
      setSsoState(prev => ({ ...prev, label: result?.label || label }));
      setLabelInput(result?.label || label);
      toast.success('Name updated');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not rename this configuration');
    } finally {
      setRenaming(false);
    }
  };

  const saveHint = auth.authenticated
    ? "Updates your saved configuration in the database."
    : "You'll create a password, then get a UUID and install URL.";

  const profileTags = useMemo(() => config.tags ?? [], [config.tags]);

  // Registry order rather than click order, so the URL and the addon name read the
  // same way the chips do. Renamed or deleted tags drop out on their own.
  const selectedTags = useMemo(
    () => profileTags.map(t => t.name).filter(name => selectedTagNames.includes(name)),
    [profileTags, selectedTagNames],
  );

  const enabledTagCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const catalog of config.catalogs ?? []) {
      if (!catalog.enabled) continue;
      for (const tag of catalog.tags ?? []) {
        const key = tag.toLowerCase();
        counts[key] = (counts[key] || 0) + 1;
      }
    }
    return counts;
  }, [config.catalogs]);

  const emptyTags = selectedTags.filter(name => !enabledTagCounts[name.toLowerCase()]);

  // A limit rides along with the profile that carries it, so the URL never has to name
  // one. Each catalog answers to the profiles it is in, so a mixed install caps only
  // part of itself. Rows in no profile, search among them, take the strictest of all.
  const profileLimit = useMemo(() => {
    const selected = selectedTags
      .map(name => profileTags.find(t => t.name === name))
      .filter((t): t is TagDef => !!t);
    const capped = selected.filter(t => !!t.ageRating && t.ageRating !== 'None');
    if (capped.length === 0) return null;
    const strictest = capped.reduce((a, b) =>
      AGE_RATING_ORDER.indexOf(a.ageRating as never) <= AGE_RATING_ORDER.indexOf(b.ageRating as never) ? a : b
    ).ageRating!;
    const hiding = capped.filter(t => t.allowUnratedContent === false).length;
    return {
      strictest,
      uniform: capped.length === selected.length && capped.every(t => t.ageRating === strictest),
      hidesUnrated: hiding > 0,
      allHideUnrated: hiding === capped.length,
    };
  }, [selectedTags, profileTags]);

  // One tag per param. A tag name can hold any character, so a separator would be
  // ambiguous for the addon to split back apart.
  const taggedInstallUrl = useMemo(() => {
    if (!identity) return "";
    const params = selectedTags.map(name => `tag=${encodeURIComponent(name)}`);
    if (params.length === 0) return identity.installUrl;
    return `${identity.installUrl}?${params.join('&')}`;
  }, [identity, selectedTags]);

  const [jellyfinEnabled, setJellyfinEnabled] = useState(false);
  const [showJellyfin, setShowJellyfin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (!cancelled) setJellyfinEnabled(Boolean(data?.jellyfinEnabled)); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const toggleTag = (name: string) => {
    setSelectedTagNames(prev =>
      prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name]
    );
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <List className="h-5 w-5" />
            Addon Resources
          </CardTitle>
          <CardDescription>What your addon exposes to your client.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <SettingRow
              htmlFor="catalog-mode-only"
              label="Catalog Mode Only"
              description="Catalogs only, no Meta. Use when another addon supplies it: a second AIOMetadata instance, or a different meta provider."
              control={
                <Switch
                  id="catalog-mode-only"
                  checked={config.catalogModeOnly ?? false}
                  onCheckedChange={(checked) => {
                    setConfig(prev => ({
                      ...prev,
                      catalogModeOnly: checked
                    }));
                  }}
                />
              }
              note={config.catalogModeOnly ? (
                <Callout variant="warn">
                  Meta will come from another addon. AIOMetadata's meta and art provider settings won't apply.
                </Callout>
              ) : null}
            />

            <SettingRow
              htmlFor="hide-stremio-catalogs"
              label="Hide Stremio-Specific Catalogs"
              description="Leaves catalogs only Stremio uses, such as Calendar videos, out of the manifest. Clients that don't use them can flicker while they render them and then drop them."
              control={
                <Switch
                  id="hide-stremio-catalogs"
                  checked={config.hideStremioCatalogs ?? false}
                  onCheckedChange={(checked) => {
                    setConfig(prev => ({
                      ...prev,
                      hideStremioCatalogs: checked
                    }));
                  }}
                />
              }
              note={config.hideStremioCatalogs ? (
                <Callout variant="warn">
                  Clients that do use the Calendar will lose it.
                </Callout>
              ) : null}
            />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            Configuration Status
          </CardTitle>
          <CardDescription>
            Check your configuration status and save it to the database
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ConfigStatusPanel
            statuses={statuses}
            missingKeys={missingKeys}
            loading={contextLoading}
          />

          <div className="space-y-3">
            {error && <Callout variant="danger">{error}</Callout>}
          </div>
        </CardContent>
        <CardFooter className="border-t pt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">{saveHint}</p>
          <Button
            size="lg"
            disabled={!canSave || isSaving}
            aria-describedby={CONFIG_STATUS_SUMMARY_ID}
            className="w-full sm:w-auto flex items-center gap-2"
            onClick={requestSave}
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save Configuration
          </Button>
        </CardFooter>
      </Card>
      {identity && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              Your Configuration
            </CardTitle>
            <CardDescription>
              Save these credentials to access your configuration later
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {ssoState.signedIn && (
              ssoState.saved ? (
                <div className="space-y-2 rounded-md border p-3">
                  <p className="text-[11px] text-emerald-500">
                    Saved to your account. Signing in is enough to open it from now on.
                  </p>
                  <div>
                    <Label htmlFor="profile-label" className="text-sm font-medium">Name in your account</Label>
                    <div className="flex items-center gap-2 mt-1">
                      <Input
                        id="profile-label"
                        value={labelInput}
                        maxLength={64}
                        placeholder={identity.userUUID.slice(0, 8)}
                        onChange={e => setLabelInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleRenameProfile(); } }}
                        className="text-sm"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={renaming || !labelInput.trim() || labelInput.trim() === ssoState.label}
                        onClick={handleRenameProfile}
                      >
                        {renaming ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Rename'}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      How this configuration is listed when you sign in.
                    </p>
                  </div>
                </div>
              ) : auth.password ? (
                <div className="space-y-2 rounded-md border p-3">
                  <p className="text-[11px] text-muted-foreground">
                    Save this to your account and you will not need its UUID or password again.
                  </p>
                  <div className="flex items-center gap-2">
                    <Input
                      value={labelInput}
                      maxLength={64}
                      placeholder={config.addonName?.trim() || identity.userUUID.slice(0, 8)}
                      onChange={e => setLabelInput(e.target.value)}
                      aria-label="Name in your account"
                      className="text-sm"
                    />
                    <Button size="sm" variant="outline" disabled={linking} onClick={handleSaveToAccount}>
                      {linking ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                      Save to my account
                    </Button>
                  </div>
                </div>
              ) : null
            )}
            <div className="space-y-3">
              <div>
                <Label className="text-sm font-medium">Your UUID</Label>
                <div className="flex items-center gap-2 mt-1">
                  <Input 
                    value={identity.userUUID} 
                    readOnly 
                    className="font-mono text-sm"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyToClipboard(identity.userUUID, 'UUID')}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div>
                <Label className="text-sm font-medium">Install URL</Label>
                {profileTags.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                    <span className="text-xs text-muted-foreground mr-1">Profile:</span>
                    <button
                      type="button"
                      onClick={() => setSelectedTagNames([])}
                      aria-pressed={selectedTags.length === 0}
                      className={cn(
                        'rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
                        selectedTags.length === 0
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-muted-foreground/30 text-muted-foreground hover:text-foreground',
                      )}
                    >
                      All catalogs
                    </button>
                    {profileTags.map((t) => (
                      <TagChip
                        key={t.name}
                        name={t.name}
                        color={t.color}
                        suffix={t.ageRating && t.ageRating !== 'None'
                          ? <span title={`Content rating ${t.ageRating} and lower`}>{t.ageRating}</span>
                          : undefined}
                        onClick={() => toggleTag(t.name)}
                        pressed={selectedTags.includes(t.name)}
                        dimmed={selectedTags.length > 0 && !selectedTags.includes(t.name)}
                      />
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2 mt-1">
                  <Input
                    value={taggedInstallUrl}
                    readOnly
                    className="font-mono text-sm"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { markManifestInstalled(); copyToClipboard(taggedInstallUrl, 'Install URL'); }}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                {selectedTags.length > 0 && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {selectedTags.length > MAX_NAMED_TAGS ? (
                      <>Installs only catalogs carrying any of the <span className="font-medium">{selectedTags.length} selected tags</span>, as a separate addon profile.</>
                    ) : (
                      <>Installs only catalogs tagged {joinTagNames(selectedTags)} as a separate addon profile.</>
                    )}
                  </p>
                )}
                {emptyTags.length > 0 && (
                  <p className="text-xs text-amber-400 mt-1">
                    {emptyTags.length > MAX_NAMED_TAGS ? (
                      <><span className="font-medium">{emptyTags.length} of the selected tags</span> have no enabled catalog, so nothing will install from them.</>
                    ) : (
                      <>No enabled catalog is tagged {joinTagNames(emptyTags)}, so nothing will install from it.</>
                    )}
                  </p>
                )}
                {profileLimit && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {profileLimit.uniform ? (
                      <>Shows only titles rated <span className="font-medium">{profileLimit.strictest}</span> or lower, the content rating this profile installs with.</>
                    ) : (
                      <>Each profile shows only titles within the content rating on its chip. Search belongs to no profile, so it uses the strictest of them, <span className="font-medium">{profileLimit.strictest}</span>.</>
                    )}
                  </p>
                )}
                {profileLimit?.hidesUnrated && (
                  <p className="text-xs text-amber-400 mt-1">
                    {profileLimit.allHideUnrated
                      ? 'It also hides titles with no rating, search included.'
                      : 'Profiles that hide titles with no rating hide them from search too.'}{' '}
                    Search results rarely carry a rating, so expect search to return very little.
                  </p>
                )}
              </div>
            </div>
            <Callout variant="info">
              <strong>Important:</strong> Save your UUID and password. You'll need both to access your configuration later.
            </Callout>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {identity && jellyfinEnabled ? (
                <JellyfinDialog open={showJellyfin} onOpenChange={setShowJellyfin} userUUID={identity.userUUID} />
              ) : null}
              <Dialog open={showLoadDialog} onOpenChange={setShowLoadDialog}>
                <Button
                  variant="outline"
                  className="w-full sm:w-auto"
                  onClick={() => setShowLoadDialog(true)}
                  disabled={isLoadingLoad}
                >
                  Load Configuration
                </Button>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Load Configuration</DialogTitle>
                    <DialogDescription>
                      Enter your password{requireAddonPassword && isUUIDTrusted === false ? ' and addon password' : ''} to load your configuration.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    {loadError && <Callout variant="danger">{loadError}</Callout>}
                    <div className="space-y-2">
                      <Label htmlFor="cfgmgr-load-password">Password</Label>
                      <Input
                        id="cfgmgr-load-password"
                        type="password"
                        value={loadPassword}
                        onChange={e => setLoadPassword(e.target.value)}
                        placeholder="Enter your password"
                        minLength={6}
                      />
                      <p className="text-xs text-muted-foreground mt-1">Password must be at least 6 characters long.</p>
                    </div>
                    {requireAddonPassword && isUUIDTrusted === false && (
                      <div className="space-y-2">
                        <Label htmlFor="cfgmgr-load-addon-password">Addon Password</Label>
                        <Input
                          id="cfgmgr-load-addon-password"
                          type="password"
                          value={loadAddonPassword}
                          onChange={e => setLoadAddonPassword(e.target.value)}
                          placeholder="Enter the addon password"
                          minLength={6}
                        />
                        <p className="text-xs text-muted-foreground mt-1">Required by the addon administrator.</p>
                      </div>
                    )}
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        onClick={() => {
                          setShowLoadDialog(false);
                          setLoadPassword("");
                          setLoadAddonPassword("");
                          setLoadError("");
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        onClick={handleLoadConfiguration}
                        disabled={isLoadingLoad || loadPassword.length < 6}
                      >
                        {isLoadingLoad ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Loading...
                          </>
                        ) : (
                          'Load Configuration'
                        )}
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
              <Button className="w-full sm:w-auto" onClick={() => openInstall(taggedInstallUrl)}>
                <Download className="h-4 w-4 mr-2" /> Install
              </Button>
              <ManagerSync
                baseInstallUrl={identity.installUrl}
                currentProfileTags={selectedTags}
                onSynced={() => { markManifestInstalled(); }}
              />
              {jellyfinEnabled ? (
                <Button variant="outline" className="w-full sm:w-auto" onClick={() => setShowJellyfin(true)}>
                  <img src="/jellyfin_icon.svg" alt="" aria-hidden="true" className="h-4 w-4 mr-2 object-contain" /> Jellyfin
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      )}
      
      {/* Import/Export Section */}
      <Suspense fallback={<ConfigurationSectionFallback />}>
        <LazyConfigImportExport />
      </Suspense>

    </div>
  );
}
