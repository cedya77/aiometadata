import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ExternalLink, Key, Loader2, Eye, EyeOff } from 'lucide-react';

interface MDBListAPIKeyModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (apiKey: string) => void;
  isLoading?: boolean;
}

export function MDBListAPIKeyModal({
  open,
  onOpenChange,
  onSubmit,
  isLoading = false,
}: MDBListAPIKeyModalProps) {
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [showKey, setShowKey] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Basic validation
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      setError('API key is required');
      return;
    }

    // Clear error and submit
    setError('');
    onSubmit(trimmedKey);
  };

  const handleCancel = () => {
    setApiKey('');
    setError('');
    onOpenChange(false);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && !isLoading) {
      handleCancel();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            MDBList API Key Required
          </DialogTitle>
          <DialogDescription>
            To import popular lists, you need to provide your MDBList API key.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="mdblist-api-key">
                API Key
              </Label>
              <div className="flex items-center space-x-2">
                <Input
                  id="mdblist-api-key"
                  type={showKey ? 'text' : 'password'}
                  placeholder="Enter your MDBList API key"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    if (error) setError('');
                  }}
                  disabled={isLoading}
                  className={error ? 'border-destructive' : ''}
                  autoComplete="off"
                  autoFocus
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowKey(!showKey)}
                  aria-label={showKey ? 'Hide key' : 'Show key'}
                  className="text-muted-foreground hover:text-foreground flex-shrink-0"
                  disabled={isLoading}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}
            </div>

            <div className="rounded-lg border border-muted bg-muted/30 p-3">
              <p className="text-sm text-muted-foreground mb-2">
                Don't have an API key yet?
              </p>
              <a
                href="https://mdblist.com/preferences/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                Get your API key from MDBList
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={handleCancel}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading || !apiKey.trim()}>
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Validating...
                </>
              ) : (
                'Continue'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
