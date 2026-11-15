// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

/** A code the user enters on the provider's site, and the session this browser polls it by. */
export interface DeviceAuthCode {
  sessionId: string;
  userCode: string;
  verificationUrl: string;
  /** Seconds between status checks. */
  interval: number;
  /** Seconds the code stays valid. */
  expiresIn: number;
}

interface UseDeviceAuthOptions {
  startPath: string;
  statusPath: string;
  cancelPath: string;
  /** Status checks only run while this is true, such as while the dialog is open. */
  active: boolean;
  providerLabel: string;
  onAuthorized: (tokenId: string, username: string) => void;
}

const MIN_INTERVAL_SECONDS = 2;
const DEFAULT_INTERVAL_SECONDS = 5;
const SLOW_DOWN_STEP_SECONDS = 2;

/** Drives a code sign-in: request a code, poll until it is approved, or cancel it. */
export function useDeviceAuth({ startPath, statusPath, cancelPath, active, providerLabel, onAuthorized }: UseDeviceAuthOptions) {
  const [code, setCode] = useState<DeviceAuthCode | null>(null);
  const [requesting, setRequesting] = useState(false);
  const onAuthorizedRef = useRef(onAuthorized);
  onAuthorizedRef.current = onAuthorized;

  const start = useCallback(async () => {
    if (requesting) return;
    // Opened before any await: a tab opened later is no longer part of the
    // click and browsers block it.
    let tab: Window | null = null;
    try {
      tab = window.open('about:blank', '_blank');
      if (tab) tab.opener = null;
    } catch {
      tab = null;
    }

    setRequesting(true);
    try {
      const response = await fetch(startPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.sessionId || !data?.userCode) {
        tab?.close();
        toast.error(data?.error || `Could not start the ${providerLabel} authorization`);
        return;
      }

      const next: DeviceAuthCode = {
        sessionId: String(data.sessionId),
        userCode: String(data.userCode),
        verificationUrl: String(data.verificationUrl || ''),
        interval: Math.max(MIN_INTERVAL_SECONDS, Number(data.interval) || DEFAULT_INTERVAL_SECONDS),
        expiresIn: Number(data.expiresIn) || 0,
      };
      setCode(next);

      if (!next.verificationUrl) {
        tab?.close();
      } else if (tab) {
        tab.location.href = next.verificationUrl;
      } else {
        // The card shows the link as well, in case this is blocked too.
        window.open(next.verificationUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (error) {
      console.error(`${providerLabel} authorization start failed:`, error);
      tab?.close();
      toast.error(`Could not start the ${providerLabel} authorization`);
    } finally {
      setRequesting(false);
    }
  }, [requesting, startPath, providerLabel]);

  const sessionId = code?.sessionId ?? null;
  const interval = code?.interval ?? null;

  useEffect(() => {
    if (!sessionId || !interval || !active) return;
    let stopped = false;
    let inFlight = false;

    const check = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(`${statusPath}?sessionId=${encodeURIComponent(sessionId)}`);
        if (stopped) return;
        // Over the server's rate limit: wait for the next tick.
        if (response.status === 429) return;
        const data = await response.json().catch(() => null);
        if (stopped) return;

        if (!response.ok && response.status !== 404) {
          toast.error(data?.error || `Could not check the ${providerLabel} authorization`);
          setCode(null);
          return;
        }
        if (data?.status === 'authorized' && data.tokenId) {
          setCode(null);
          onAuthorizedRef.current(String(data.tokenId), String(data.username ?? ''));
          return;
        }
        if (data?.status === 'slow_down') {
          setCode((prev) => (prev && prev.sessionId === sessionId ? { ...prev, interval: prev.interval + SLOW_DOWN_STEP_SECONDS } : prev));
          return;
        }
        if (data?.status === 'expired') {
          setCode(null);
          toast.error(`The ${providerLabel} code expired. Request a new one to connect.`);
          return;
        }
        if (response.status === 404) {
          // A 404 without a status: the code flow is not offered here any more.
          setCode(null);
          toast.error(data?.error || `Could not check the ${providerLabel} authorization`);
        }
      } catch (error) {
        console.error(`${providerLabel} authorization status check failed, retrying:`, error);
      } finally {
        inFlight = false;
      }
    };

    const timer = window.setInterval(check, interval * 1000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [sessionId, interval, active, statusPath, providerLabel]);

  const cancel = useCallback(() => {
    if (code) {
      void fetch(cancelPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: code.sessionId }),
      }).catch(() => undefined);
    }
    setCode(null);
  }, [code, cancelPath]);

  return { code, requesting, start, cancel };
}
