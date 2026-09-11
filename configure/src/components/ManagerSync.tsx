import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { RefreshCw, Loader2, ChevronDown, Plus, Trash2, Pencil, Check, X } from "lucide-react";
import { useConfig } from "@/contexts/ConfigContext";
import type { ManagerAccount } from "@/contexts/config";
import { accountsFor, describeProfile, normalizeInstanceUrl, profileUrlFor } from "@/lib/managerAccounts";

interface ManagerDef {
  id: string;
  name: string;
  endpoint: string;
  urlPlaceholder: string;
  keyHint: string;
  description: string;
  publicInstances?: { name: string; url: string }[];
  statusEndpoint?: string;
}

const MANAGERS: ManagerDef[] = [
  {
    id: 'aiomanager',
    name: 'AIOManager',
    endpoint: '/api/aiomanager/reinstall',
    urlPlaceholder: 'https://aio.example.com',
    keyHint: 'Accounts > Connections > API key',
    description: 'Installs or updates this addon in your AIOManager accounts and propagates it to all their connected platforms.',
    publicInstances: [
      { name: "Kuu's (beta)", url: 'https://aiomanager-beta.stremio.ru' },
      { name: "Yeb's (beta)", url: 'https://aiomanager-beta.fortheweak.cloud' },
      { name: "Ibby's", url: 'https://aiomanager.ibbylabs.dev' },
      { name: 'Elfhosted', url: 'https://aiomanager.elfhosted.com' },
      { name: "Midnight's", url: 'https://aiomanagerfortheweebs.midnightignite.me' },
      { name: "Yeb's", url: 'https://aiomanager.fortheweak.cloud' },
      { name: "Kuu's", url: 'https://aiomanager.stremio.ru' },
    ],
    statusEndpoint: '/api/aiomanager/status',
  },
];

const CUSTOM_INSTANCE = 'custom';

const SYNC_BUTTON_CLASSES = "w-full sm:w-auto border-violet-400/30 bg-violet-500/15 text-violet-600 dark:text-violet-300 hover:bg-violet-500/25 hover:text-violet-700 dark:hover:text-violet-200";

interface ManagerSyncProps {
  /** Install URL without a tag query. Each account appends the profile it is bound to. */
  baseInstallUrl: string;
  /** Tags being viewed on the install card, used to prefill a new account's profile. */
  currentProfileTags?: string[];
  onSynced?: () => void;
}

interface SyncResult {
  accountId: string;
  label?: string;
  ok: boolean;
  error?: string;
}

export function ManagerSync({ baseInstallUrl, currentProfileTags, onSynced }: ManagerSyncProps) {
  const { config, setConfig, auth } = useConfig();
  const [activeManager, setActiveManager] = useState<ManagerDef | null>(null);
  const [editing, setEditing] = useState<'new' | string | null>(null);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [results, setResults] = useState<SyncResult[]>([]);
  const [instanceSupport, setInstanceSupport] = useState<Record<string, boolean>>({});

  const [selectedInstance, setSelectedInstance] = useState(CUSTOM_INSTANCE);
  const [instanceUrl, setInstanceUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [label, setLabel] = useState('');
  const [profileTags, setProfileTags] = useState<string[]>([]);
  const [autoSync, setAutoSync] = useState(true);
  const [remember, setRemember] = useState(true);
  const [support, setSupport] = useState<'unknown' | 'checking' | 'yes' | 'no'>('unknown');

  const accounts = useMemo(
    () => (activeManager ? accountsFor(config, activeManager.id) : []),
    [config, activeManager]
  );
  const availableTags = useMemo(() => config.tags ?? [], [config.tags]);
  const canPersist = auth.authenticated && !!auth.userUUID;

  const resetForm = useCallback((account?: ManagerAccount | null) => {
    const manager = activeManager;
    const savedUrl = account?.instanceUrl || '';
    const publicMatch = manager?.publicInstances?.find(i => i.url === savedUrl);
    setSelectedInstance(publicMatch ? publicMatch.url : CUSTOM_INSTANCE);
    setInstanceUrl(publicMatch ? '' : savedUrl);
    setApiKey('');
    setLabel(account?.label || '');
    setProfileTags(account?.profileTags ?? currentProfileTags ?? []);
    setAutoSync(account ? account.autoSync !== false : true);
    setRemember(true);
    setSupport('unknown');
  }, [activeManager, currentProfileTags]);

  // A pre-account config keeps its credentials in the old inline map. Writing them
  // through the legacy route is what moves them onto the account list and out of the
  // config body, so it runs once as soon as the dialog is opened.
  useEffect(() => {
    if (!activeManager || !canPersist) return;
    const legacy = config.managers?.[activeManager.id];
    if (!legacy?.instanceUrl || !legacy?.apiKey) return;
    if ((config.managerAccounts || []).length > 0) return;
    fetch('/api/managers/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userUUID: auth.userUUID,
        password: auth.password,
        managerId: activeManager.id,
        instanceUrl: legacy.instanceUrl,
        apiKey: legacy.apiKey,
      }),
    })
      .then(response => response.json())
      .then(data => {
        if (!data?.managerAccounts) return;
        setConfig(prev => ({ ...prev, managers: undefined, managerAccounts: data.managerAccounts }));
      })
      .catch(() => { /* the user can re-enter the key */ });
  }, [activeManager, canPersist, config.managers, config.managerAccounts, auth.userUUID, auth.password, setConfig]);

  useEffect(() => {
    const endpoint = activeManager?.statusEndpoint;
    const listed = activeManager?.publicInstances;
    if (!endpoint || !listed?.length) return;
    let cancelled = false;
    Promise.all(listed.map(async instance => {
      try {
        const response = await fetch(`${endpoint}?instanceUrl=${encodeURIComponent(instance.url)}`);
        const data = await response.json();
        return [instance.url, !!data?.supported] as const;
      } catch {
        return [instance.url, false] as const;
      }
    })).then(pairs => { if (!cancelled) setInstanceSupport(Object.fromEntries(pairs)); });
    return () => { cancelled = true; };
  }, [activeManager]);

  const probeUrl = normalizeInstanceUrl(selectedInstance === CUSTOM_INSTANCE ? instanceUrl : selectedInstance);

  useEffect(() => {
    const endpoint = activeManager?.statusEndpoint;
    if (!activeManager || !endpoint || !probeUrl || editing === null) {
      setSupport('unknown');
      return;
    }
    let cancelled = false;
    setSupport('checking');
    const timer = setTimeout(() => {
      fetch(`${endpoint}?instanceUrl=${encodeURIComponent(probeUrl)}`)
        .then(response => response.json())
        .then(data => { if (!cancelled) setSupport(data?.supported ? 'yes' : 'no'); })
        .catch(() => { if (!cancelled) setSupport('unknown'); });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [activeManager, probeUrl, editing]);

  const openManager = (manager: ManagerDef) => {
    setActiveManager(manager);
    setResults([]);
    setEditing(null);
  };

  const closeManager = () => {
    setActiveManager(null);
    setEditing(null);
    setResults([]);
  };

  const applyAccounts = (next: ManagerAccount[] | undefined) => {
    if (!next) return;
    setConfig(prev => ({ ...prev, managers: undefined, managerAccounts: next }));
  };

  const saveAccount = async () => {
    if (!activeManager) return;
    const url = normalizeInstanceUrl(selectedInstance === CUSTOM_INSTANCE ? instanceUrl : selectedInstance);
    const key = apiKey.trim();
    const isNew = editing === 'new';
    if (!url) {
      toast.error(`Enter your ${activeManager.name} instance URL.`);
      return;
    }
    if (isNew && !key) {
      toast.error('Enter the account API key.');
      return;
    }

    if (isNew && !remember) {
      await syncAdHoc(url, key);
      return;
    }
    if (!canPersist) {
      toast.error('Save your configuration first so the account can be stored.');
      return;
    }

    setBusyIds(prev => [...prev, 'form']);
    try {
      const response = await fetch('/api/managers/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userUUID: auth.userUUID,
          password: auth.password,
          accountId: isNew ? undefined : editing,
          managerId: activeManager.id,
          label: label.trim() || undefined,
          instanceUrl: url,
          apiKey: key || undefined,
          profileTags,
          autoSync,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || `Save failed (${response.status})`);
      applyAccounts(data.managerAccounts);
      toast.success(isNew ? 'Account added' : 'Account updated');
      setEditing(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save the account');
    } finally {
      setBusyIds(prev => prev.filter(id => id !== 'form'));
    }
  };

  /** One-off push with a key the user asked not to keep. */
  const syncAdHoc = async (url: string, key: string) => {
    if (!activeManager) return;
    setBusyIds(prev => [...prev, 'form']);
    try {
      const addonUrl = profileUrlFor(baseInstallUrl, { profileTags });
      const response = await fetch(activeManager.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceUrl: url, apiKey: key, addonUrl }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || `Sync failed (${response.status})`);
      toast.success(`Addon synced to ${activeManager.name}`);
      setEditing(null);
      onSynced?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setBusyIds(prev => prev.filter(id => id !== 'form'));
    }
  };

  const removeAccount = async (account: ManagerAccount) => {
    if (!canPersist) return;
    setBusyIds(prev => [...prev, account.id]);
    try {
      const response = await fetch('/api/managers/accounts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userUUID: auth.userUUID, password: auth.password, accountId: account.id }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || `Remove failed (${response.status})`);
      applyAccounts(data.managerAccounts ?? []);
      toast.success(`Removed ${account.label}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove the account');
    } finally {
      setBusyIds(prev => prev.filter(id => id !== account.id));
    }
  };

  const syncAccounts = async (targets: ManagerAccount[]) => {
    if (!targets.length || !canPersist) return;
    const ids = targets.map(a => a.id);
    setBusyIds(prev => [...prev, ...ids]);
    setResults([]);
    try {
      const response = await fetch('/api/managers/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userUUID: auth.userUUID,
          password: auth.password,
          targets: targets.map(account => ({
            accountId: account.id,
            addonUrl: profileUrlFor(baseInstallUrl, account),
          })),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || `Sync failed (${response.status})`);
      applyAccounts(data.managerAccounts);
      setResults(data.results || []);
      if (data.failed === 0) {
        toast.success(targets.length === 1 ? `Synced to ${targets[0].label}` : `Synced to ${data.synced} accounts`);
        onSynced?.();
      } else if (data.synced > 0) {
        toast.warning(`Synced ${data.synced}, ${data.failed} failed`);
        onSynced?.();
      } else {
        toast.error('No account could be synced');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setBusyIds(prev => prev.filter(id => !ids.includes(id)));
    }
  };

  const toggleTag = (name: string) => {
    setProfileTags(prev => prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name]);
  };

  const busy = (id: string) => busyIds.includes(id);
  const editingAccount = editing && editing !== 'new' ? accounts.find(a => a.id === editing) || null : null;

  const renderForm = () => (
    <div className="space-y-3 rounded-md border border-border/60 p-3">
      <div className="space-y-1.5">
        <Label htmlFor="manager-instance">Instance</Label>
        {activeManager?.publicInstances?.length ? (
          <Select value={selectedInstance} onValueChange={setSelectedInstance}>
            <SelectTrigger id="manager-instance">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {activeManager.publicInstances.map((instance) => {
                const unsupported = instanceSupport[instance.url] === false;
                return (
                  <SelectItem key={instance.url} value={instance.url} disabled={unsupported}>
                    {instance.name} <span className="text-muted-foreground">({instance.url.replace('https://', '')})</span>
                    {unsupported && <span className="text-muted-foreground"> · no Hydra API</span>}
                  </SelectItem>
                );
              })}
              <SelectItem value={CUSTOM_INSTANCE}>Custom URL…</SelectItem>
            </SelectContent>
          </Select>
        ) : null}
        {(selectedInstance === CUSTOM_INSTANCE || !activeManager?.publicInstances?.length) && (
          <Input
            id="manager-url"
            name="manager-instance-url"
            placeholder={activeManager?.urlPlaceholder}
            value={instanceUrl}
            onChange={(e) => setInstanceUrl(e.target.value)}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            data-form-type="other"
          />
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="manager-key">Account API key</Label>
        <Input
          id="manager-key"
          name="manager-api-key"
          type="password"
          placeholder={editingAccount ? 'Leave blank to keep the stored key' : activeManager?.keyHint}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
        />
        <p className="text-xs text-muted-foreground">
          One key is one account, so add a separate entry for each account you want this addon in.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="manager-label">Name</Label>
        <Input
          id="manager-label"
          name="manager-account-label"
          placeholder="Main, Kids, Test…"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
        />
      </div>

      <div className="space-y-1.5">
        <Label>Profile this account receives</Label>
        {availableTags.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No tags yet. This account gets your full install.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {availableTags.map(tag => (
                <button
                  key={tag.name}
                  type="button"
                  aria-pressed={profileTags.includes(tag.name)}
                  onClick={() => toggleTag(tag.name)}
                  className={`rounded-full border px-2.5 py-1 text-xs transition ${
                    profileTags.includes(tag.name)
                      ? 'border-primary bg-primary/15 text-primary'
                      : 'border-border/60 text-muted-foreground hover:border-border'
                  }`}
                >
                  {tag.name}
                  {tag.ageRating && tag.ageRating !== 'None' ? ` · ${tag.ageRating}` : ''}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {profileTags.length === 0
                ? 'No tags selected, so this account gets your full install.'
                : 'Only catalogs carrying these tags are sent, with the content rating they install with.'}
            </p>
          </>
        )}
      </div>

      <div className="flex items-center justify-between">
        <Label htmlFor="manager-autosync" className="text-sm text-muted-foreground">
          Include when syncing everything
        </Label>
        <Switch id="manager-autosync" checked={autoSync} onCheckedChange={setAutoSync} />
      </div>

      {editing === 'new' && (
        <div className="flex items-center justify-between">
          <Label htmlFor="manager-remember" className="text-sm text-muted-foreground">
            Save this account
          </Label>
          <Switch id="manager-remember" checked={remember} onCheckedChange={setRemember} />
        </div>
      )}

      {support === 'no' && (
        <p className="text-xs text-amber-500">
          This instance does not serve the Hydra API, so it cannot accept a sync. It needs a
          newer {activeManager?.name} release.
        </p>
      )}
      {support === 'yes' && (
        <p className="text-xs text-emerald-500">Hydra API available on this instance.</p>
      )}

      <div className="flex items-center gap-2">
        <Button
          className="flex-1"
          onClick={saveAccount}
          disabled={busy('form') || support === 'checking' || support === 'no'}
        >
          {busy('form') ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Working…</>
          ) : editing === 'new' ? (
            remember ? <><Check className="h-4 w-4 mr-2" /> Add account</> : <><RefreshCw className="h-4 w-4 mr-2" /> Sync once</>
          ) : (
            <><Check className="h-4 w-4 mr-2" /> Save changes</>
          )}
        </Button>
        <Button variant="outline" onClick={() => setEditing(null)} disabled={busy('form')}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );

  const autoSyncAccounts = accounts.filter(a => a.autoSync !== false && !!a.keyId);

  return (
    <>
      {MANAGERS.length === 1 ? (
        <Button variant="outline" className={SYNC_BUTTON_CLASSES} onClick={() => openManager(MANAGERS[0])}>
          <RefreshCw className="h-4 w-4 mr-2" /> Sync to {MANAGERS[0].name}
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className={SYNC_BUTTON_CLASSES}>
              <RefreshCw className="h-4 w-4 mr-2" /> Sync to Manager <ChevronDown className="h-4 w-4 ml-2" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {MANAGERS.map((manager) => (
              <DropdownMenuItem key={manager.id} onClick={() => openManager(manager)}>
                {manager.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <Dialog open={!!activeManager} onOpenChange={(open) => { if (!open) closeManager(); }}>
        <DialogContent className="sm:max-w-lg max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Sync to {activeManager?.name}</DialogTitle>
            <DialogDescription>{activeManager?.description}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            {accounts.length > 0 && (
              <div className="space-y-2">
                {accounts.map(account => {
                  const result = results.find(r => r.accountId === account.id);
                  return (
                    <div key={account.id} className="rounded-md border border-border/60 p-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{account.label}</span>
                            <Badge variant="secondary" className="shrink-0 text-[10px]">
                              {describeProfile(account)}
                            </Badge>
                            {!account.keyId && (
                              <Badge variant="outline" className="shrink-0 border-amber-400/40 text-[10px] text-amber-500">
                                Needs key
                              </Badge>
                            )}
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {account.instanceUrl.replace(/^https?:\/\//, '')}
                          </p>
                          {result && (
                            <p className={`mt-1 text-xs ${result.ok ? 'text-emerald-500' : 'text-red-500'}`}>
                              {result.ok ? 'Synced' : result.error}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => syncAccounts([account])}
                            disabled={busy(account.id) || !canPersist || !account.keyId}
                            aria-label={`Sync ${account.label}`}
                          >
                            {busy(account.id)
                              ? <Loader2 className="h-4 w-4 animate-spin" />
                              : <RefreshCw className="h-4 w-4" />}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => { setEditing(account.id); resetForm(account); }}
                            aria-label={`Edit ${account.label}`}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => removeAccount(account)}
                            disabled={busy(account.id) || !canPersist}
                            aria-label={`Remove ${account.label}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      {editing === account.id && <div className="mt-3">{renderForm()}</div>}
                    </div>
                  );
                })}
              </div>
            )}

            {accounts.length === 0 && editing !== 'new' && (
              <p className="text-sm text-muted-foreground">
                No {activeManager?.name} accounts yet. Add one for each account you want this addon in.
              </p>
            )}

            {editing === 'new' && renderForm()}

            {editing === null && (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={() => { setEditing('new'); resetForm(null); }}>
                  <Plus className="h-4 w-4 mr-2" /> Add account
                </Button>
                {autoSyncAccounts.length > 0 && (
                  <Button
                    className="flex-1"
                    onClick={() => syncAccounts(autoSyncAccounts)}
                    disabled={!canPersist || autoSyncAccounts.some(a => busy(a.id))}
                  >
                    {autoSyncAccounts.some(a => busy(a.id))
                      ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Syncing…</>
                      : <><RefreshCw className="h-4 w-4 mr-2" /> Sync {autoSyncAccounts.length === 1 ? 'account' : `all ${autoSyncAccounts.length}`}</>}
                  </Button>
                )}
              </div>
            )}

            {!canPersist && (
              <p className="text-xs text-amber-500">
                Save your configuration first, then accounts can be stored and synced.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
