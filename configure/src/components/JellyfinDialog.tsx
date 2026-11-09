import { useEffect, useMemo, useState } from "react";
import { useConfig } from "@/contexts/ConfigContext";
import { useSave } from "@/contexts/SaveContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Copy, Loader2, Save, Users } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { navigateToSettingsSection } from "@/lib/settingsRoute";

/**
 * Typed by hand on a TV remote as often as pasted, so the alphabet leaves out
 * the characters that are read wrong and the groups keep the place visible.
 */
function newClientPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

async function copyToClipboard(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard!`);
  } catch (err) {
    console.error('Copy failed:', err);
    toast.error('Failed to copy to clipboard');
  }
}

interface JellyfinDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userUUID: string;
}

export function JellyfinDialog({ open, onOpenChange, userUUID }: JellyfinDialogProps) {
  const { config, setConfig, auth } = useConfig();
  const { requestSave, isSaving, isDirty, canSave } = useSave();
  const [ownPagesOn, setOwnPagesOn] = useState(false);
  useEffect(() => {
    if (!open) return;
    fetch('/api/own-page/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => setOwnPagesOn(Boolean(body?.enabled)))
      .catch(() => setOwnPagesOn(false));
  }, [open]);
  const ownPageLink = `${window.location.origin}/jellyfin-page/${encodeURIComponent(userUUID)}`;
  const copyOwnPageLink = () => {
    void navigator.clipboard.writeText(ownPageLink).then(() => toast.success('Link copied')).catch(() => toast.error('The link could not be copied'));
  };
  // Signed in here, the page needs no second sign-in: the session travels in the part of the address no server sees.
  const openOwnPage = async () => {
    const opened = window.open('', '_blank');
    let token: string | null = null;
    try {
      const response = await fetch(`/api/own-page/${encodeURIComponent(userUUID)}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(auth.password ? { password: auth.password } : {}),
      });
      token = response.ok ? (await response.json()).token ?? null : null;
    } catch {
      token = null;
    }
    const target = token ? `${ownPageLink}#token=${encodeURIComponent(token)}` : ownPageLink;
    if (opened) opened.location.href = target;
    else window.location.href = target;
  };
  const [resolveMode, setResolveMode] = useState<string>('user');
  const [upcomingMode, setUpcomingMode] = useState<string>('user');
  useEffect(() => {
    let cancelled = false;
    fetch('/api/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (data.jellyfinResolveOnOpen) setResolveMode(String(data.jellyfinResolveOnOpen));
        if (data.jellyfinUpcomingMode) setUpcomingMode(String(data.jellyfinUpcomingMode));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const resolveForced: boolean | null = resolveMode === 'always' ? true : resolveMode === 'never' ? false : null;
  const upcomingForced = upcomingMode === 'caught-up' || upcomingMode === 'airing' ? upcomingMode : null;
  const mainName = config.jellyfinUserName || config.addonName || userUUID.slice(0, 8);
  const users = useMemo(() => config.jellyfinUsers ?? [], [config.jellyfinUsers]);

  const [quickConnectCode, setQuickConnectCode] = useState('');
  const [quickConnectProfile, setQuickConnectProfile] = useState('');
  const [approving, setApproving] = useState(false);
  const approveQuickConnect = async () => {
    const code = quickConnectCode.replace(/\D/g, '');
    if (code.length !== 6) {
      toast.error('Enter the six digit code the client is showing');
      return;
    }
    setApproving(true);
    try {
      const response = await fetch(`/api/jellyfin/${encodeURIComponent(userUUID)}/quick-connect/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, password: auth.password || undefined, profile: quickConnectProfile || undefined }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || 'Could not approve the device');
      setQuickConnectCode('');
      toast.success(`${result?.app || 'Client'} signed in`, {
        description: result?.device ? `Approved ${result.device} as ${result?.profile || mainName}.` : undefined,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not approve the device');
    } finally {
      setApproving(false);
    }
  };

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,80rem)] overflow-y-auto sm:max-w-none">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <img src="/jellyfin_icon.svg" alt="" aria-hidden="true" className="h-5 w-5 object-contain" />
            Jellyfin
          </DialogTitle>
          <DialogDescription>
            Browse this configuration from any Jellyfin client. Its address is under Install in the Configuration tab.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {ownPagesOn && (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[#4b83f0]/40 bg-[#4b83f0]/10 p-4">
              <div className="min-w-0 flex-[1_1_20rem]">
                <p className="text-[15px] font-semibold">Your viewing page</p>
                <p className="mt-1 text-[13px] leading-[1.45] text-muted-foreground">Your watching, shows, calendar, year and trackers on one page. Anyone with the link still needs this configuration's password.</p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" className="h-10 gap-1.5 rounded-[10px] px-3.5" onClick={copyOwnPageLink}><Copy className="h-3.5 w-3.5" /> Copy link</Button>
                <Button className="h-10 rounded-[10px] px-4" onClick={() => void openOwnPage()}>Open</Button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed p-3">
            <p className="text-xs text-muted-foreground">The users on the sign-in screen, with their PINs, trackers and catalogs, are set up in Watch Tracking.</p>
            <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => { onOpenChange(false); navigateToSettingsSection('watch-tracking'); }}>
              <Users className="h-3.5 w-3.5" /> Set up users
            </Button>
          </div>
          <div className="grid gap-6 border-t pt-4 md:grid-cols-3">
            <div className="space-y-6">
              <div className="space-y-1.5">
                <Label htmlFor="jellyfin-quick-connect" className="text-sm font-medium">Quick Connect</Label>
                <div className="flex flex-col gap-2">
                  {users.length > 0 ? (
                    <Select value={quickConnectProfile || '__main__'} onValueChange={(v) => setQuickConnectProfile(v === '__main__' ? '' : v)}>
                      <SelectTrigger className="w-full" aria-label="Sign the device in as">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__main__">{mainName}</SelectItem>
                        {users.map((u) => (
                          <SelectItem key={u.id} value={u.id}>{u.name || 'Unnamed user'}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                  <div className="flex flex-1 items-center gap-2">
                  <Input
                    id="jellyfin-quick-connect"
                    value={quickConnectCode}
                    inputMode="numeric"
                    maxLength={7}
                    placeholder="000000"
                    className="font-mono text-sm tracking-widest"
                    onChange={(e) => setQuickConnectCode(e.target.value.replace(/[^\d ]/g, ''))}
                    onKeyDown={(e) => { if (e.key === 'Enter') approveQuickConnect(); }}
                    aria-label="Quick Connect code"
                  />
                  <Button size="sm" variant="outline" disabled={approving} onClick={approveQuickConnect}>
                    {approving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                    Approve
                  </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Pick Quick Connect on the client's sign-in screen and enter the code it shows here. The client signs in without a password{users.length > 0 ? ', as the user chosen here' : ''}.
                </p>
              </div>
  
              <div className="space-y-1.5">
                <Label htmlFor="jellyfin-client-password" className="text-sm font-medium">Client password</Label>
                {config.jellyfinAppPassword ? (
                  <div className="flex items-center gap-2">
                    <Input
                      id="jellyfin-client-password"
                      value={config.jellyfinAppPassword}
                      readOnly
                      className="font-mono text-sm"
                      aria-label="Jellyfin client password"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => copyToClipboard(config.jellyfinAppPassword ?? '', 'Client password')}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfig(prev => ({ ...prev, jellyfinAppPassword: newClientPassword() }))}
                    >
                      Replace
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={() => setConfig(prev => ({ ...prev, jellyfinAppPassword: newClientPassword() }))}
                  >
                    Generate
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">
                  For clients without Quick Connect. Sign in with this instead of the configuration password, which an account created through a sign-in provider never set. It works only on this address, and replacing it signs the clients out.
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="jellyfin-stream-url" className="text-sm font-medium">Playback</Label>
                <span className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                  config.jellyfinStreamUrl
                    ? 'border-emerald-500/40 text-emerald-400'
                    : 'border-amber-500/40 text-amber-400',
                )}>
                  {config.jellyfinStreamUrl ? 'Stream addon set' : 'Browse only'}
                </span>
              </div>
              <Input
                id="jellyfin-stream-url"
                value={config.jellyfinStreamUrl ?? ''}
                placeholder="https://your-aiostreams/stremio/<config>/manifest.json"
                className="font-mono text-xs"
                onChange={(e) => setConfig(prev => ({ ...prev, jellyfinStreamUrl: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                Paste a stream addon's install URL, such as your AIOStreams. Without one, titles browse but will not play. AIOMetadata never serves the video itself; the client fetches it from that addon directly.
              </p>
              <div className="flex items-center justify-between gap-3 pt-1">
                <div>
                  <Label className="text-xs font-medium">Wait for the streams when a title opens</Label>
                  <p className="text-[11px] text-muted-foreground">
                    {resolveForced === null
                      ? 'Off, a title opens at once and its versions load when the picker opens or play is pressed, the lightest on your stream addon. On, a title still opens at once while its streams load alongside, and the app gets the versions as soon as it asks again or opens the picker, usually with no wait. An app that asks for the versions with the title gets them either way.'
                      : 'Set by this server.'}
                  </p>
                </div>
                <Switch
                  checked={resolveForced ?? config.jellyfinResolveOnOpen ?? false}
                  disabled={resolveForced !== null}
                  onCheckedChange={(next) => setConfig(prev => ({ ...prev, jellyfinResolveOnOpen: next ? true : undefined }))}
                  aria-label="Wait for the streams when a title opens"
                />
              </div>
            </div>

            <div className="space-y-3">
              <Label className="text-sm font-medium">Browsing</Label>
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-0.5">
                  <Label className="text-xs font-medium">Show a Latest row per catalog</Label>
                  <p className="text-[11px] text-muted-foreground">
                    On by default. A client asks each catalog for its newest titles to fill a row per catalog on the home screen, which is one catalog read each and slow to draw when many are enabled. There is no date a title entered a catalog here, so the row is its first page rather than what is new. Some clients build their whole home screen from these rows, so off leaves them empty.
                  </p>
                </div>
                <Switch
                  checked={config.jellyfinLatestRows !== false}
                  onCheckedChange={(next) => setConfig(prev => ({ ...prev, jellyfinLatestRows: next ? undefined : false }))}
                  aria-label="Show a Latest row per catalog"
                />
              </div>
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-0.5">
                  <Label className="text-xs font-medium">Mark unaired episodes</Label>
                  <p className="text-[11px] text-muted-foreground">
                    On by default. Episodes that have not aired yet are sent as missing, so apps that support it show them as upcoming and do not offer to play them. Turn off to keep them playable, for when a stream addon has an episode early.
                  </p>
                </div>
                <Switch
                  checked={config.jellyfinMarkUnaired !== false}
                  onCheckedChange={(next) => setConfig(prev => ({ ...prev, jellyfinMarkUnaired: next ? undefined : false }))}
                  aria-label="Mark unaired episodes"
                />
              </div>
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-0.5">
                  <Label className="text-xs font-medium">Try to match releases across users</Label>
                  <p className="text-[11px] text-muted-foreground">
                    On by default. In a SyncPlay group, the release another member is playing is listed first when your stream addon offers it, which helps everyone play the same file. Turn off to keep your stream addon's order.
                  </p>
                </div>
                <Switch
                  checked={config.jellyfinMatchReleases !== false}
                  onCheckedChange={(next) => setConfig(prev => ({ ...prev, jellyfinMatchReleases: next ? undefined : false }))}
                  aria-label="Try to match releases across users"
                />
              </div>
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-0.5">
                  <Label className="text-xs font-medium">Upcoming row</Label>
                  <p className="text-[11px] text-muted-foreground">
                    {upcomingForced
                      ? 'Set by this server.'
                      : 'Caught up lists the next episode of the shows you have watched every aired episode of, so a show is in Upcoming or Next Up, never both. Everything airing lists the next episode of every show you follow, behind or not, so a show you are behind on can be in both. Watchlisted films that are not out yet are in it either way.'}
                  </p>
                </div>
                <Select
                  value={upcomingForced ?? config.jellyfinUpcomingMode ?? 'caught-up'}
                  disabled={upcomingForced !== null}
                  onValueChange={(v) => setConfig(prev => ({ ...prev, jellyfinUpcomingMode: v === 'airing' ? 'airing' : undefined }))}
                >
                  <SelectTrigger className="h-8 w-40 shrink-0 text-xs" aria-label="Upcoming row"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="caught-up">Caught up</SelectItem>
                    <SelectItem value="airing">Everything airing</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-0.5">
                  <Label className="text-xs font-medium">Similar titles</Label>
                  <p className="text-[11px] text-muted-foreground">
                    The titles an app shows as similar on a title's page. TMDB suggests from its own recommendations. Simkl suggests what its users recommend alongside the title, or titles in the same genres when there are none, and uses TMDB for a title it does not know. Also what the More Like This catalog returns to apps that ask for one.
                  </p>
                </div>
                <Select
                  value={config.jellyfinSimilarSource ?? 'tmdb'}
                  onValueChange={(v) => setConfig(prev => ({ ...prev, jellyfinSimilarSource: v === 'simkl' ? 'simkl' : undefined }))}
                >
                  <SelectTrigger className="h-8 w-40 shrink-0 text-xs" aria-label="Similar titles"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tmdb">TMDB</SelectItem>
                    <SelectItem value="simkl">Simkl</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </div>

        <div className="sticky bottom-0 -mx-4 -mb-4 mt-6 flex flex-col gap-2 border-t bg-card px-4 py-3 sm:-mx-6 sm:-mb-6 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className={cn('text-xs', isDirty ? 'text-amber-400' : 'text-muted-foreground')}>
            {isDirty
              ? 'Unsaved changes. Clients see users, passwords and settings only once saved.'
              : 'Everything here is saved.'}
          </p>
          <Button size="sm" disabled={!canSave || isSaving || !isDirty} onClick={requestSave} className="w-full sm:w-auto">
            {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save configuration
          </Button>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}
