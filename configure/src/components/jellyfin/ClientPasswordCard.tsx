import { useState } from 'react';
import { Copy, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useConfig } from '@/contexts/ConfigContext';
import { useSave } from '@/contexts/SaveContext';
import { newClientPassword } from '@/lib/jellyfinClient';

const MASK = '••••-••••-••••-••••';

export function ClientPasswordCard() {
  const { config, setConfig } = useConfig();
  const { persistedConfig } = useSave();
  const password = config.jellyfinAppPassword ?? '';
  const savedPassword = persistedConfig?.jellyfinAppPassword ?? '';
  const [revealed, setRevealed] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const generate = () => {
    setConfig((prev) => ({ ...prev, jellyfinAppPassword: newClientPassword() }));
    setRevealed(true);
  };
  const copy = () => {
    void navigator.clipboard.writeText(password)
      .then(() => toast.success('Client password copied to clipboard!'))
      .catch(() => toast.error('Failed to copy to clipboard'));
  };

  return (
    <div id="client-password" className="flex flex-col gap-3.5 rounded-lg border bg-card p-4">
      <div className="space-y-0.5">
        <p className="font-medium">Client password</p>
        <p className="text-sm text-muted-foreground">For apps without Quick Connect, used in place of the configuration password.</p>
      </div>

      {password ? (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <code
              id="client-password-value"
              tabIndex={0}
              aria-label={revealed ? 'Jellyfin client password' : 'Jellyfin client password, hidden'}
              className="flex h-10 min-w-0 flex-1 items-center truncate rounded-md border bg-background px-3 font-mono text-sm tracking-wide"
            >
              {revealed ? password : MASK}
            </code>
            <Button variant="outline" size="icon" className="h-10 w-10 shrink-0" aria-label={revealed ? 'Hide the client password' : 'Show the client password'} aria-pressed={revealed} onClick={() => setRevealed((v) => !v)}>
              {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <Button variant="outline" size="icon" className="h-10 w-10 shrink-0" aria-label="Copy the client password" onClick={copy}>
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {password !== savedPassword ? (
              <p className="text-xs text-amber-400">Save to start using it.</p>
            ) : (
              <p className="text-xs text-muted-foreground">Works only on this server address.</p>
            )}
            <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>Replace…</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">Accounts created through a sign-in provider never set a configuration password, so their apps need this one.</p>
          <Button variant="outline" size="sm" onClick={generate}>Generate</Button>
        </div>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the client password?</AlertDialogTitle>
            <AlertDialogDescription>Apps signed in with the current client password are signed out once you save.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={generate}>Replace</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
