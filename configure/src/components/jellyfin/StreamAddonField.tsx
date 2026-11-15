import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { checkStreamManifest, isManifestUrl, normaliseStreamUrl } from '@/lib/jellyfinClient';
import { cn } from '@/lib/utils';

const CHECK_DELAY_MS = 600;
const CHECK_STALE_MS = 5 * 60_000;

export function StreamAddonField({ id, label, value, onChange, placeholder, emptyWarning, hint }: {
  id: string;
  label?: string;
  value: string;
  onChange: (next: string | undefined) => void;
  placeholder?: string;
  emptyWarning?: string;
  hint?: ReactNode;
}) {
  const url = value.trim();
  const [settled, setSettled] = useState(url);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(url), CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [url]);

  const check = useQuery({
    queryKey: ['stream-manifest', settled],
    queryFn: ({ signal }) => checkStreamManifest(settled, signal),
    enabled: settled === url && isManifestUrl(settled),
    staleTime: CHECK_STALE_MS,
    retry: false,
  });
  const current = settled !== url || !isManifestUrl(url) ? null : check.isFetching && !check.data ? 'checking' : check.data ?? null;

  let status: { tone: 'ok' | 'warn' | 'busy'; text: string } | null = null;
  if (!url) status = emptyWarning ? { tone: 'warn', text: emptyWarning } : null;
  else if (current === 'checking') status = { tone: 'busy', text: 'Checking the addon…' };
  else if (current && current.ok) {
    const name = [current.name, current.version].filter(Boolean).join(' ');
    status = current.streams
      ? { tone: 'ok', text: `${name} · offers streams` }
      : { tone: 'warn', text: `${name} · offers no streams, so titles won't play` };
  } else if (current) status = { tone: 'warn', text: "Couldn't reach this addon from your browser. It may still work for Jellyfin." };

  return (
    <div className="space-y-1.5">
      {label ? <Label htmlFor={id} className="text-sm font-medium">{label}</Label> : null}
      <Input
        id={id}
        value={value}
        inputMode="url"
        spellCheck={false}
        aria-label={label ? undefined : 'Stream addon'}
        placeholder={placeholder ?? 'https://your-aiostreams/stremio/<config>/manifest.json'}
        className="font-mono text-xs"
        onChange={(e) => {
          const next = normaliseStreamUrl(e.target.value);
          onChange(next.trim() ? next : undefined);
        }}
      />
      {status ? (
        <p className={cn('flex items-start gap-1.5 text-xs', status.tone === 'ok' ? 'text-emerald-400' : status.tone === 'warn' ? 'text-amber-400' : 'text-muted-foreground')}>
          {status.tone === 'ok' ? <Check className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
          {status.tone === 'busy' ? <Loader2 className="mt-px h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" /> : null}
          <span aria-live="polite">{status.text}</span>
        </p>
      ) : null}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
