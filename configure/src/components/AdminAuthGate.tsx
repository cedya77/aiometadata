import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAdmin } from '@/contexts/AdminContext';
import { Shield, Key, Users, AlertCircle, Loader2 } from 'lucide-react';

interface AdminAuthGateProps {
  mode: 'configure' | 'dashboard';
}

export function AdminAuthGate({ mode }: AdminAuthGateProps) {
  const { login, loginAsGuest, isLoading, adminKeyConfigured, guestModeEnabled } = useAdmin();
  const [inputAdminKey, setInputAdminKey] = useState('');
  const [error, setError] = useState('');
  const [showAdminInput, setShowAdminInput] = useState(false);

  const modeLabel = mode === 'dashboard' ? 'Dashboard' : 'Configure';

  const handleLogin = async () => {
    if (!inputAdminKey.trim()) {
      setError('Please enter an admin key');
      return;
    }
    setError('');
    const success = await login(inputAdminKey);
    if (!success) {
      setError('Invalid admin key. Please try again.');
    }
  };

  const handleGuestLogin = () => {
    loginAsGuest();
  };

  const handleGoBack = () => {
    window.location.href = '/';
  };

  const handleBackToOptions = () => {
    setShowAdminInput(false);
    setInputAdminKey('');
    setError('');
  };

  // ADMIN_KEY not configured and guest mode is off — nothing to do
  if (!adminKeyConfigured && !guestModeEnabled) {
    return (
      <Dialog open onOpenChange={() => {}}>
        <DialogContent
          className="sm:max-w-md"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-amber-500" />
              {modeLabel} Access Unavailable
            </DialogTitle>
            <DialogDescription>
              {modeLabel} access requires the ADMIN_KEY environment variable to be configured on the server.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="p-3 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-md text-sm text-amber-700 dark:text-amber-300">
              <p className="font-medium mb-1">Configuration Required</p>
              <p>Please set the ADMIN_KEY environment variable on your server to enable access.</p>
            </div>
            <div className="flex justify-end">
              <Button variant="outline" onClick={handleGoBack}>
                Go Back
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // Admin key input screen
  if (showAdminInput) {
    return (
      <Dialog open onOpenChange={() => {}}>
        <DialogContent
          className="sm:max-w-md"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Admin Authentication
            </DialogTitle>
            <DialogDescription>
              Enter your admin key to access {modeLabel.toLowerCase()}.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!isLoading) handleLogin();
            }}
          >
            {error && (
              <div className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-md text-sm text-red-700 dark:text-red-300">
                {error}
              </div>
            )}
            {!adminKeyConfigured && guestModeEnabled && (
              <div className="p-3 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-md text-sm text-amber-700 dark:text-amber-300">
                <p className="font-medium mb-1">Admin Access Unavailable</p>
                <p>ADMIN_KEY is not configured on the server. You can continue as a guest.</p>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="auth-gate-key">Admin Key</Label>
              <Input
                id="auth-gate-key"
                name="password"
                autoComplete="current-password"
                type="password"
                value={inputAdminKey}
                onChange={(e) => setInputAdminKey(e.target.value)}
                placeholder="Enter admin key"
                autoFocus
                disabled={!adminKeyConfigured}
              />
            </div>
            <div className="flex justify-between gap-2">
              <Button type="button" variant="outline" onClick={handleBackToOptions}>
                Back
              </Button>
              <Button type="submit" disabled={isLoading || !adminKeyConfigured}>
                {isLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Authenticating...
                  </>
                ) : (
                  'Login'
                )}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    );
  }

  // Options screen
  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        className="sm:max-w-md"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            {modeLabel} Access
          </DialogTitle>
          <DialogDescription>
            {guestModeEnabled
              ? `Choose how you'd like to access ${modeLabel.toLowerCase()}.`
              : `Enter your admin key to access ${modeLabel.toLowerCase()}.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Button
            className="w-full justify-start h-auto py-4"
            variant="outline"
            onClick={() => setShowAdminInput(true)}
          >
            <div className="flex items-center gap-3">
              <Key className="h-5 w-5 text-primary" />
              <div className="text-left">
                <p className="font-medium">Admin Login</p>
                <p className="text-xs text-muted-foreground">Full access to all features</p>
              </div>
            </div>
          </Button>

          {guestModeEnabled && (
            <Button
              className="w-full justify-start h-auto py-4"
              variant="outline"
              onClick={handleGuestLogin}
            >
              <div className="flex items-center gap-3">
                <Users className="h-5 w-5 text-muted-foreground" />
                <div className="text-left">
                  <p className="font-medium">Continue as Guest</p>
                  <p className="text-xs text-muted-foreground">View public metrics without authentication</p>
                </div>
              </div>
            </Button>
          )}

          <div className="flex justify-start pt-2">
            <Button variant="ghost" size="sm" onClick={handleGoBack}>
              Go Back
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
