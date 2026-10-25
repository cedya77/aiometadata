import { useEffect, useState } from "react";
import { useConfig } from "@/contexts/ConfigContext";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Info, Loader2, Plus } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { CardService, CatalogConfig, JellyfinUser } from "@/contexts/config";
import { disconnectCardAccount, persistIntegrationCredential } from "@/lib/integrationCredentials";
import { CARD_SERVICES, CARD_SERVICE_ORDER, cardAccount, missingWatchlistSlots, withAccount, withTracking } from "@/lib/cardAccounts";
import { ApiKeyConnect } from "@/components/accounts/ApiKeyConnect";
import { OAuthTokenConnect } from "@/components/accounts/OAuthTokenConnect";
import { SimklConnect } from "@/components/accounts/SimklConnect";
import { ProfilePicks } from "@/components/jellyfin/ProfilePicks";

interface UserAccountsProps {
  user: JellyfinUser;
  catalogs: CatalogConfig[];
  onChange: (next: JellyfinUser) => void;
  onAddCatalogs: (entries: CatalogConfig[]) => void;
  onRemoveCatalogs: (ids: string[]) => void;
}

export function UserAccounts({ user, catalogs, onChange, onAddCatalogs, onRemoveCatalogs }: UserAccountsProps) {
  const { auth, config } = useConfig();
  const [open, setOpen] = useState<CardService | null>(null);
  const [busy, setBusy] = useState<CardService | null>(null);
  const [stale, setStale] = useState<Partial<Record<CardService, boolean>>>({});

  const simklToken = user.accounts?.apiKeys?.simklTokenId;
  const anilistToken = user.accounts?.apiKeys?.anilistTokenId;
  const malToken = user.accounts?.apiKeys?.malTokenId;
  useEffect(() => {
    let cancelled = false;
    const tokens: Array<[CardService, string | undefined]> = [['simkl', simklToken], ['anilist', anilistToken], ['mal', malToken]];
    for (const [service, tokenId] of tokens) {
      if (!tokenId) continue;
      fetch('/api/oauth/token/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tokenId }) })
        .then((res) => { if (!cancelled) setStale((prev) => ({ ...prev, [service]: !res.ok })); })
        .catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [simklToken, anilistToken, malToken]);

  const connected = (service: CardService, value: string, extra: { label?: string; publicmetadbWatchlist?: string }) => {
    onChange(withAccount(user, service, value, extra));
    toast.success(`${user.name} connected to ${CARD_SERVICES[service].label}${extra.label ? ` as ${extra.label}` : ''}`);
    if (service === 'simkl' || service === 'anilist' || service === 'mal') {
      void persistIntegrationCredential({ provider: service, tokenId: value, userUUID: auth.userUUID, password: auth.password, authenticated: auth.authenticated, profile: user.id })
        .then((result) => { if (result.error) toast.warning(`Connected; save the configuration to keep it (${result.error})`); });
    }
  };

  const disconnect = async (service: CardService) => {
    const path = CARD_SERVICES[service].disconnectPath;
    if (path && auth.userUUID) {
      setBusy(service);
      const result = await disconnectCardAccount(path, auth.userUUID, user.id, auth.password);
      setBusy(null);
      if (!result.ok) {
        toast.error(result.error ?? 'Disconnect failed');
        return;
      }
    }
    onChange(withAccount(user, service, undefined));
    if (service === 'publicmetadb') {
      onRemoveCatalogs(catalogs.filter((c) => c.metadata?.accountOwner === user.id).map((c) => c.id));
    }
  };

  const selected = open;
  const selectedInfo = selected ? CARD_SERVICES[selected] : null;
  const selectedAccount = selected ? cardAccount(user, selected) : null;
  const missing = selected && selectedAccount?.connected ? missingWatchlistSlots(catalogs, selected, config.displayTypeOverrides) : [];

  return (
    <div className="space-y-2.5 border-t pt-3">
      <div className="flex items-center gap-1.5">
        <Label className="text-xs font-medium">Accounts</Label>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="About accounts">
                <Info className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs">
              None of your Simkl, MDBList, PublicMetaDB, AniList or MyAnimeList accounts is used for {user.name}. Catalogs of your other accounts, such as Trakt or TMDB, still show your lists if their tags include them. When plays are recorded follows Watch Tracking in General, for every user.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {user.name}'s own trackers. Once one is connected, what they play, mark or heart goes there, and their shelves and watchlist read from it.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {CARD_SERVICE_ORDER.map((service) => {
          const info = CARD_SERVICES[service];
          const account = cardAccount(user, service);
          const status = !account.connected ? 'Connect'
            : stale[service] ? 'Sign in again'
            : !account.enabled ? 'Tracking off'
            : account.label ?? 'Connected';
          return (
            <button
              key={service}
              type="button"
              onClick={() => setOpen(open === service ? null : service)}
              aria-expanded={open === service}
              className={cn(
                'flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors hover:bg-accent/50',
                open === service ? 'border-primary/60 bg-accent/40' : account.connected ? 'border-emerald-500/30' : 'border-border',
              )}
            >
              <img src={info.icon} alt="" className={cn('h-7 w-7 shrink-0 rounded-md object-contain', !account.connected && 'opacity-60 grayscale')} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{info.label}</span>
                <span className={cn(
                  'flex items-center gap-1 truncate text-[11px]',
                  !account.connected ? 'text-muted-foreground' : stale[service] ? 'text-amber-400' : account.enabled ? 'text-emerald-400' : 'text-muted-foreground',
                )}>
                  {account.connected && !stale[service] && account.enabled ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" /> : null}
                  <span className="truncate">{status}</span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {selected && selectedInfo && selectedAccount ? (
        <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <img src={selectedInfo.icon} alt="" className="h-5 w-5 rounded object-contain" />
            <span className="text-xs font-medium">
              {selectedAccount.connected ? (selectedAccount.label ? `${selectedInfo.label} as ${selectedAccount.label}` : selectedInfo.label) : `Connect ${user.name}'s ${selectedInfo.label}`}
            </span>
            {selectedAccount.connected ? (
              <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs text-muted-foreground hover:text-destructive" disabled={busy === selected} onClick={() => disconnect(selected)}>
                {busy === selected ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Disconnect'}
              </Button>
            ) : null}
          </div>
          {stale[selected] ? <p className="text-[11px] text-amber-400">This sign-in no longer works; disconnect and connect again.</p> : null}
          {!selectedAccount.connected ? (
            selected === 'simkl' ? <SimklConnect onConnected={(tokenId, username) => connected('simkl', tokenId, { label: username })} />
            : selected === 'anilist' ? <OAuthTokenConnect provider="anilist" authUrl="/anilist/auth" label="AniList" onConnected={(tokenId, username) => connected('anilist', tokenId, { label: username })} />
            : selected === 'mal' ? <OAuthTokenConnect provider="mal" authUrl="/mal/auth" label="MyAnimeList" onConnected={(tokenId, username) => connected('mal', tokenId, { label: username })} />
            : <ApiKeyConnect service={selected} onConnected={(key, found) => connected(selected, key, found)} />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
                <label className="flex items-center gap-1.5">
                  <Switch checked={selectedAccount.enabled} onCheckedChange={(next) => onChange(withTracking(user, selected, { enabled: next }))} aria-label={`Watch tracking on ${selectedInfo.label} for ${user.name}`} />
                  Watch tracking
                </label>
                <label className={cn('flex items-center gap-1.5', !selectedAccount.enabled && 'opacity-50')}>
                  <Switch checked={selectedAccount.movie} disabled={!selectedAccount.enabled} onCheckedChange={(next) => onChange(withTracking(user, selected, { movie: next }))} aria-label={`Track movies on ${selectedInfo.label}`} />
                  Movies
                </label>
                <label className={cn('flex items-center gap-1.5', !selectedAccount.enabled && 'opacity-50')}>
                  <Switch checked={selectedAccount.series} disabled={!selectedAccount.enabled} onCheckedChange={(next) => onChange(withTracking(user, selected, { series: next }))} aria-label={`Track series on ${selectedInfo.label}`} />
                  Series
                </label>
              </div>
              {selected === 'publicmetadb' && !user.accounts?.publicmetadbWatchlist ? (
                <p className="text-[11px] text-amber-400">No watchlist list on this account, so PublicMetaDB is not one of their watchlist shelves.</p>
              ) : null}
              {missing.length ? (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onAddCatalogs(missing)}>
                  <Plus className="mr-1 h-3 w-3" /> Add {selectedInfo.label} watchlist to the catalogs
                </Button>
              ) : null}
              {selected === 'publicmetadb' ? (
                <ProfilePicks user={user} catalogs={catalogs} onAddCatalogs={onAddCatalogs} onRemoveCatalogs={onRemoveCatalogs} />
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
