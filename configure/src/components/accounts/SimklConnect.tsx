// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useEffect, useState } from "react";
import { DeviceAuthCard } from "@/components/DeviceAuthCard";
import { useDeviceAuth } from "@/hooks/useDeviceAuth";
import { OAuthTokenConnect } from "./OAuthTokenConnect";

export function SimklConnect({ onConnected }: { onConnected: (tokenId: string, username: string) => void }) {
  const [clientId, setClientId] = useState('');
  const [mode, setMode] = useState<'oauth' | 'pin' | 'both'>('oauth');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (data.simkl) setClientId(data.simkl);
        if (data.simklAuthMode === 'pin' || data.simklAuthMode === 'both' || data.simklAuthMode === 'oauth') setMode(data.simklAuthMode);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const pin = useDeviceAuth({
    startPath: '/api/auth/simkl/pin',
    statusPath: '/api/auth/simkl/pin/status',
    cancelPath: '/api/auth/simkl/pin/cancel',
    active: true,
    providerLabel: 'Simkl',
    onAuthorized: onConnected,
  });

  return (
    <div className="space-y-3">
      {mode !== 'oauth' ? (
        <DeviceAuthCard
          code={pin.code}
          requesting={pin.requesting}
          disabled={!clientId}
          startLabel="Get a Simkl PIN"
          hint="They enter the code at simkl.com/pin, on any device."
          onStart={pin.start}
          onCancel={pin.cancel}
        />
      ) : null}
      {mode !== 'pin' ? <OAuthTokenConnect provider="simkl" authUrl="/api/auth/simkl/authorize" label="Simkl" onConnected={onConnected} /> : null}
    </div>
  );
}
