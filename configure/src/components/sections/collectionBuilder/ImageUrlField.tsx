// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useEffect, useId, useState } from 'react';
import { Image as ImageIcon, ImageOff } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PREVIEW_BOX, type PreviewAspect } from './shared';

/** URL input with a live thumbnail, so art can be judged before exporting. */
export function ImageUrlField({
  label,
  value,
  aspect,
  placeholder = 'https://...',
  hint,
  onChange,
}: {
  label: string;
  value: string;
  aspect: PreviewAspect;
  placeholder?: string;
  hint?: string;
  onChange: (next: string) => void;
}) {
  const [debounced, setDebounced] = useState(value);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const fieldId = useId();

  // Wait for a pause in typing so a half-typed URL is not fetched on every key.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value.trim()), 400);
    return () => clearTimeout(timer);
  }, [value]);

  useEffect(() => {
    setStatus(debounced ? 'loading' : 'idle');
  }, [debounced]);

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={fieldId} className="text-sm font-medium">{label}</Label>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <div className="flex items-start gap-3">
        <div
          className={`relative shrink-0 overflow-hidden rounded-md border ${PREVIEW_BOX[aspect]} ${
            status === 'error' ? 'border-amber-600/60 bg-amber-950/20' : 'border-dashed bg-muted/40'
          }`}
        >
          {debounced && status !== 'error' && (
            <img
              key={debounced}
              src={debounced}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onLoad={() => setStatus('ok')}
              onError={() => setStatus('error')}
              className={`h-full w-full ${aspect === 'logo' ? 'object-contain p-1' : 'object-cover'} ${
                status === 'ok' ? 'opacity-100' : 'opacity-0'
              } transition-opacity`}
            />
          )}
          {status === 'loading' && <div className="absolute inset-0 animate-pulse bg-muted" />}
          {status === 'idle' && (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground/50">
              <ImageIcon className="h-4 w-4" />
            </div>
          )}
          {status === 'error' && (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-center text-amber-500">
              <ImageOff className="h-4 w-4" />
              <span className="text-[9px] leading-tight">won&rsquo;t load</span>
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <Input
            id={fieldId}
            value={value}
            onChange={event => onChange(event.target.value)}
            placeholder={placeholder}
            className="h-9"
          />
          {status === 'error' && (
            <p className="text-xs text-amber-500">
              The image did not load. Check the link is public and points straight at the file.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
