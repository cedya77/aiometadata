import { Copy, Download } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useConfig } from '@/contexts/ConfigContext';
import { useSave } from '@/contexts/SaveContext';
import { jellyfinServerAddress, useJellyfinServer } from '@/hooks/useJellyfinServer';
import { useStremioLinkStatus } from '@/hooks/useStremioLinkStatus';
import { scrobblesStremio, stremioLinkState, withViewer } from '@/lib/watchTracking';

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard!`);
  } catch {
    toast.error('Failed to copy to clipboard');
  }
}

/** The Jellyfin server address and each user's Stremio link, beside the main install URL. */
export function InstallLinks({ userUUID, installUrl }: { userUUID: string; installUrl: string }) {
  const { config } = useConfig();
  const { openInstall, isDirty } = useSave();
  const jellyfin = useJellyfinServer();
  const stremioOn = scrobblesStremio(config);
  const status = useStremioLinkStatus(stremioOn);
  const mainName = config.jellyfinUserName || config.addonName || userUUID.slice(0, 8);
  const people = [{ id: '', name: mainName }, ...(config.jellyfinUsers ?? []).map((u) => ({ id: u.id, name: u.name || 'Unnamed user' }))];
  const address = jellyfinServerAddress(jellyfin.baseUrl, userUUID);

  if (!jellyfin.enabled && !stremioOn) return null;

  return (
    <div className="space-y-4">
      {jellyfin.enabled ? (
        <div className="space-y-1">
          <Label htmlFor="jellyfin-server-address" className="text-sm font-medium">Jellyfin server address</Label>
          <div className="flex items-center gap-2">
            <Input id="jellyfin-server-address" value={address} readOnly className="font-mono text-sm" aria-label="Jellyfin server address" />
            <Button variant="outline" size="sm" onClick={() => copy(address, 'Jellyfin server address')}>
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Add this as a server in your Jellyfin client. Pick a user on its sign-in screen, then use this configuration's password, the client password in the Jellyfin settings, or Quick Connect.
          </p>
          <p className="text-xs text-amber-400">
            Anyone with this address and your password can browse your catalogs. Treat it like the install URL.
          </p>
        </div>
      ) : null}

      {stremioOn ? (
        <div className="space-y-2">
          <div>
            <Label className="text-sm font-medium">Stremio install links</Label>
            <p className="text-xs text-muted-foreground">
              One per user, for Stremio SDK scrobbling. Install each in that person's Stremio profile, so their plays reach their own trackers.
              {isDirty ? ' Save first: a user added since the last save is not known to the server yet.' : ''}
            </p>
          </div>
          {people.map((person) => {
            const url = person.id ? withViewer(installUrl, person.id) : installUrl;
            const state = status ? stremioLinkState(config.stremioScrobblingSince, status[person.id]) : null;
            return (
              <div key={person.id || 'main'} id={`install-link-${person.id || 'main'}`} className="scroll-mt-16 space-y-1 rounded-md border p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">{person.name}{person.id ? '' : ' (you)'}</span>
                  {state === 'reinstall' ? (
                    <span className="text-xs text-amber-400">Reinstall required</span>
                  ) : state === 'waiting' ? (
                    <span className="text-xs text-muted-foreground">No playback from Stremio yet</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Input value={url} readOnly className="h-8 font-mono text-xs" aria-label={`Stremio install link for ${person.name}`} />
                  <Button variant="outline" size="sm" className="h-8" onClick={() => copy(url, `${person.name}'s install link`)}>
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button size="sm" className="h-8 gap-1.5" disabled={Boolean(isDirty) && Boolean(person.id)} onClick={() => openInstall(url)}>
                    <Download className="h-4 w-4" /> Install
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
