// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { DeviceAuthCode } from '@/hooks/useDeviceAuth';

interface DeviceAuthCardProps {
  code: DeviceAuthCode | null;
  requesting: boolean;
  disabled?: boolean;
  startLabel: string;
  hint?: string;
  onStart: () => void;
  onCancel: () => void;
}

/** The button that requests a sign-in code, then the code itself while it waits for approval. */
export function DeviceAuthCard({ code, requesting, disabled, startLabel, hint, onStart, onCancel }: DeviceAuthCardProps) {
  if (!code) {
    return (
      <div className="space-y-2">
        <Button className="w-full" onClick={() => onStart()} disabled={disabled || requesting}>
          {requesting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}
          {startLabel}
        </Button>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    );
  }

  const shownUrl = code.verificationUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');

  return (
    <div className="space-y-3 rounded-lg border p-4">
      {code.verificationUrl ? (
        <p className="text-center text-sm text-muted-foreground">
          Enter this code at{' '}
          <a
            href={code.verificationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary hover:underline"
          >
            {shownUrl}
          </a>
        </p>
      ) : null}
      <p className="select-all text-center font-mono text-3xl font-semibold tracking-[0.3em]">{code.userCode}</p>
      <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Waiting for you to approve the code...
      </div>
      <Button variant="ghost" className="w-full" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
