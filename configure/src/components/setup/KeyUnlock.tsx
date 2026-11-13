// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useState } from 'react';
import { Check, ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { KEY_META } from '@/lib/setup/keyMeta';
import { testApiKey, type KeyTestResult } from '@/lib/setup/testKey';
import type { RequiredKeyId } from '@/lib/setup/types';
import { cn } from '@/lib/utils';

export function KeyUnlock({
  keyId,
  value,
  onChange,
  onValidated,
  note,
  submitLabel = 'Test',
  className,
}: {
  keyId: RequiredKeyId;
  value: string;
  onChange: (value: string) => void;
  onValidated?: (value: string) => void;
  note?: string;
  submitLabel?: string;
  className?: string;
}) {
  const meta = KEY_META[keyId];
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<KeyTestResult | null>(null);

  const submit = async () => {
    setTesting(true);
    setResult(null);
    const outcome = await testApiKey(keyId, value);
    setResult(outcome);
    setTesting(false);
    if (outcome.status === 'valid') onValidated?.(value.trim());
  };

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="password"
          value={value}
          placeholder={meta.placeholder}
          onChange={event => {
            onChange(event.target.value);
            setResult(null);
          }}
          onKeyDown={event => {
            if (event.key === 'Enter' && value.trim() && !testing) void submit();
          }}
          className="h-9 max-w-xs flex-1"
          aria-label={meta.label}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!value.trim() || testing}
          onClick={() => void submit()}
        >
          {testing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {testing ? 'Checking' : submitLabel}
        </Button>
        <a
          href={meta.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Get a key
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      </div>

      {note && !result && <p className="text-xs text-muted-foreground">{note}</p>}

      {result?.status === 'valid' && (
        <p className="flex items-center gap-1.5 text-xs text-emerald-400">
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
          Key accepted.
        </p>
      )}
      {result && result.status !== 'valid' && (
        <p className="text-xs text-red-400">{result.message}</p>
      )}
    </div>
  );
}
