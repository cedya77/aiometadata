import { useEffect, useState } from 'react';
import { useConfig } from '@/contexts/ConfigContext';

export type StremioLinkStatus = { manifestAt: number | null; eventAt: number | null };

/** What each install link last heard from Stremio, keyed '' for the main user and by card id. */
export function useStremioLinkStatus(enabled: boolean): Record<string, StremioLinkStatus> | null {
  const { auth } = useConfig();
  const [status, setStatus] = useState<Record<string, StremioLinkStatus> | null>(null);

  useEffect(() => {
    if (!enabled || !auth.userUUID) return;
    let cancelled = false;
    fetch(`/api/stremio/${encodeURIComponent(auth.userUUID)}/event-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: auth.password || undefined }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data || !Array.isArray(data.links)) return;
        setStatus(Object.fromEntries(data.links.map((link: { profile: string | null } & StremioLinkStatus) => [
          link.profile ?? '',
          { manifestAt: link.manifestAt ?? null, eventAt: link.eventAt ?? null },
        ])));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [enabled, auth.userUUID, auth.password]);

  return status;
}
