import { Copy, ExternalLink, LayoutDashboard } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useConfig } from '@/contexts/ConfigContext';
import { useOwnPageStatus } from '@/hooks/useOwnPageStatus';

export function OwnPageCard({ userUUID }: { userUUID: string }) {
  const { auth } = useConfig();
  const enabled = useOwnPageStatus();
  if (!enabled) return null;

  const link = `${window.location.origin}/jellyfin-page/${encodeURIComponent(userUUID)}`;
  const copyLink = () => {
    void navigator.clipboard.writeText(link).then(() => toast.success('Link copied')).catch(() => toast.error('The link could not be copied'));
  };
  // The session travels in the fragment, which no server sees.
  const open = async () => {
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
    const target = token ? `${link}#token=${encodeURIComponent(token)}` : link;
    if (opened) opened.location.href = target;
    else window.location.href = target;
  };

  return (
    <div id="own-page" className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border bg-card p-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40" aria-hidden="true">
        <LayoutDashboard className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-[12rem] flex-1 space-y-0.5">
        <p className="font-medium">Your viewing page</p>
        <p className="text-sm text-muted-foreground">Your watching, shows, calendar, year and trackers on one page. Anyone with the link still needs this configuration's password.</p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={copyLink}><Copy className="h-3.5 w-3.5" /> Copy link</Button>
        <Button size="sm" className="gap-1.5" onClick={() => void open()}>Open <ExternalLink className="h-3.5 w-3.5" /></Button>
      </div>
    </div>
  );
}
