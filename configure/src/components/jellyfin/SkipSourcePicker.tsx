import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Segmented } from '@/components/settings/Segmented';
import type { SkipProvider, SkipSource } from '@/contexts/config';
import { cn } from '@/lib/utils';

const SKIP_PROVIDERS: Array<{ value: SkipProvider; label: string; note: string }> = [
  { value: 'publicmetadb', label: 'PublicMetaDB', note: 'Your key' },
  { value: 'aniskip', label: 'AniSkip', note: 'Anime only' },
  { value: 'introdb', label: 'IntroDB', note: 'No key needed' },
];

type SkipRow = { value: SkipProvider; on: boolean };

function skipRows(value: SkipSource, hasPmdb: boolean): SkipRow[] {
  const all = SKIP_PROVIDERS.map((p) => p.value);
  const picked = Array.isArray(value) ? value : value === 'off' ? [] : all.includes(value as SkipProvider) ? [value as SkipProvider] : all;
  const on = [...new Set(picked)].filter((p) => all.includes(p) && (p !== 'publicmetadb' || hasPmdb));
  return [...on.map((v) => ({ value: v, on: true })), ...all.filter((p) => !on.includes(p)).map((v) => ({ value: v, on: false }))];
}

function skipSourceOf(rows: SkipRow[], hasPmdb: boolean): SkipSource {
  const on = rows.filter((r) => r.on).map((r) => r.value);
  if (!on.length) return 'off';
  const auto = SKIP_PROVIDERS.map((p) => p.value).filter((p) => p !== 'publicmetadb' || hasPmdb);
  return on.join() === auto.join() ? 'auto' : on;
}

function orderText(rows: SkipRow[]): string {
  const on = rows.filter((r) => r.on).map((r) => SKIP_PROVIDERS.find((p) => p.value === r.value)!.label);
  if (!on.length) return 'Off, so apps show no skip button';
  return on.length === 1 ? `${on[0]} only` : on.join(', then ');
}

/** Undefined follows the main user; the main user's undefined is Automatic. */
export function SkipSourcePicker({ value, inherited, main, hasPmdb, onChange }: { value?: SkipSource; inherited: SkipSource; main?: boolean; hasPmdb: boolean; onChange: (next: SkipSource | undefined) => void }) {
  const stored = main ? value ?? 'auto' : value;
  const [customOpen, setCustomOpen] = useState(stored !== undefined && stored !== 'auto');
  const mode = customOpen ? 'custom' : stored === undefined ? 'follow' : 'auto';
  const rows = skipRows(stored ?? inherited, hasPmdb);
  const set = (next: SkipRow[]) => onChange(skipSourceOf(next, hasPmdb));
  const onCount = rows.filter((r) => r.on).length;
  const move = (i: number, by: number) => {
    const next = [...rows];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    set(next);
  };

  return (
    <div className="space-y-3">
      <Segmented
        label="Skip markers"
        value={mode}
        options={main ? [['auto', 'Automatic'], ['custom', 'Custom order']] : [['follow', 'Same as everyone'], ['auto', 'Automatic'], ['custom', 'Custom order']]}
        onChange={(next) => {
          setCustomOpen(next === 'custom');
          if (next === 'follow') onChange(undefined);
          else if (next === 'auto') onChange('auto');
          else if (stored === undefined) set(rows);
        }}
      />
      {mode !== 'custom' ? (
        <p className="text-sm text-muted-foreground">{orderText(rows)}.</p>
      ) : (
        <>
          <ol className="space-y-0.5 sm:max-w-md">
            {rows.map((row, i) => {
              const provider = SKIP_PROVIDERS.find((p) => p.value === row.value)!;
              const locked = row.value === 'publicmetadb' && !hasPmdb;
              return (
                <li key={row.value} className="flex items-center gap-3 py-1.5">
                  <Switch
                    checked={row.on}
                    disabled={locked}
                    onCheckedChange={(on) => set(rows.map((r) => (r.value === row.value ? { ...r, on } : r)))}
                    aria-label={`Use ${provider.label} for skip markers`}
                  />
                  <span className={cn('min-w-0 flex-1 truncate text-sm', !row.on && 'text-muted-foreground')}>
                    {provider.label}
                    <span className="ml-2 text-xs text-muted-foreground">{locked ? 'Needs a PublicMetaDB key' : provider.note}</span>
                  </span>
                  {row.on && onCount > 1 ? (
                    <span className="flex shrink-0 items-center">
                      <Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Ask ${provider.label} earlier`}>
                        <ChevronUp className="h-4 w-4" />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={i >= onCount - 1} onClick={() => move(i, 1)} aria-label={`Ask ${provider.label} later`}>
                        <ChevronDown className="h-4 w-4" />
                      </Button>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
          <p className="text-xs text-muted-foreground">{onCount ? 'Each marker comes from the first source on the list that has it.' : `${orderText(rows)}.`}</p>
        </>
      )}
    </div>
  );
}
