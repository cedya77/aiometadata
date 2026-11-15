// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

interface ApiKeyConnectProps {
  service: 'mdblist' | 'publicmetadb';
  onConnected: (key: string, found: { label: string; publicmetadbWatchlist?: string }) => void;
}

export function ApiKeyConnect({ service, onConnected }: ApiKeyConnectProps) {
  const [key, setKey] = useState('');
  const [checking, setChecking] = useState(false);

  const check = async () => {
    const value = key.trim();
    if (!value) return;
    setChecking(true);
    try {
      if (service === 'mdblist') {
        const response = await fetch(`/api/mdblist/user?apikey=${encodeURIComponent(value)}`);
        const data = response.ok ? await response.json() : null;
        if (!data) throw new Error('MDBList did not accept this key');
        onConnected(value, { label: data.username || 'MDBList' });
      } else {
        if (!value.startsWith('pm-')) throw new Error("PublicMetaDB keys start with 'pm-'");
        const validated = await fetch(`/api/publicmetadb/validate?apikey=${encodeURIComponent(value)}`).then((r) => r.json());
        if (!validated?.valid) throw new Error('PublicMetaDB did not accept this key');
        const lists = await fetch(`/api/publicmetadb/lists?apikey=${encodeURIComponent(value)}&perPage=500`).then((r) => r.json()).catch(() => null);
        const watchlist = (lists?.items ?? []).find((list: any) => list?.type === 'watchlist');
        onConnected(value, { label: 'PublicMetaDB', publicmetadbWatchlist: watchlist?.id != null ? String(watchlist.id) : undefined });
      }
      setKey('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not check the key');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Input
        value={key}
        type="password"
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') check(); }}
        placeholder={service === 'mdblist' ? 'Their MDBList API key' : 'Their PublicMetaDB key (pm-…)'}
        className="h-8 font-mono text-xs"
        aria-label={`${service === 'mdblist' ? 'MDBList' : 'PublicMetaDB'} API key`}
      />
      <Button size="sm" disabled={checking || !key.trim()} onClick={check}>
        {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Connect'}
      </Button>
    </div>
  );
}
