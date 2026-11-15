// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface OAuthTokenConnectProps {
  provider: 'simkl' | 'anilist' | 'mal';
  authUrl: string;
  label: string;
  onConnected: (tokenId: string, username: string) => void;
}

export function OAuthTokenConnect({ provider, authUrl, label, onConnected }: OAuthTokenConnectProps) {
  const [tokenId, setTokenId] = useState('');
  const [checking, setChecking] = useState(false);

  const check = async () => {
    const value = tokenId.trim();
    if (!value) return;
    setChecking(true);
    try {
      const response = await fetch('/api/oauth/token/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenId: value }),
      });
      const data = response.ok ? await response.json() : null;
      if (data?.provider !== provider) throw new Error(`That is not a ${label} token ID`);
      onConnected(value, String(data.username ?? ''));
      setTokenId('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not check the ${label} token`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button size="sm" variant="outline" onClick={() => window.open(authUrl, '_blank', 'width=600,height=700')}>
        <ExternalLink className="mr-1.5 h-4 w-4" /> Authorize {label}
      </Button>
      <div className="flex items-center gap-2">
        <Input
          value={tokenId}
          onChange={(e) => setTokenId(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') check(); }}
          placeholder="Token ID shown after authorizing"
          className="h-8 font-mono text-xs"
          aria-label={`${label} token ID`}
        />
        <Button size="sm" disabled={checking || !tokenId.trim()} onClick={check}>
          {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Connect'}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">Sign in as this user in the window that opens, then paste the Token ID it shows.</p>
    </div>
  );
}
