// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useEffect, useRef, useState } from 'react';
import { Asterisk, Check, Loader2, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useConfig } from '@/contexts/ConfigContext';

interface KeywordResult {
  id: number;
  name: string;
}

interface PatternPreview {
  valid: boolean;
  count?: number | null;
  sample?: string[];
  problem?: string;
}

const SEARCH_DELAY_MS = 300;

const isPattern = (entry: string) => entry.includes('*');

/** What the user typed as a pattern, or the two patterns a plain word suggests. */
function patternsFor(term: string): Array<{ pattern: string; label: string; shown: string }> {
  if (isPattern(term)) return [{ pattern: term, label: 'Every keyword matching', shown: term }];
  return [
    { pattern: `${term}*`, label: 'Every keyword starting with', shown: term },
    { pattern: `*${term}*`, label: 'Every keyword containing', shown: term },
  ];
}

function previewText(preview: PatternPreview | undefined): string {
  if (!preview) return 'Counting…';
  if (!preview.valid) return preview.problem || 'Not a usable pattern';
  if (preview.count == null) return 'Also covers keywords TMDB adds later';
  if (preview.count === 0) return 'No keyword matches yet';
  const sample = preview.sample?.length ? `: ${preview.sample.slice(0, 4).join(', ')}${preview.count > 4 ? '…' : ''}` : '';
  return `${preview.count.toLocaleString()} keyword${preview.count === 1 ? '' : 's'}${sample}`;
}

export function TmdbKeywordPicker({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const { config, auth } = useConfig();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KeywordResult[]>([]);
  const [previews, setPreviews] = useState<Record<string, PatternPreview>>({});
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);

  const term = query.trim();
  const suggestions = term.replace(/\*/g, '').length >= 2 ? patternsFor(term) : [];

  useEffect(() => {
    if (term.replace(/\*/g, '').length < 2) {
      setResults([]);
      setError('');
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError('');
      // The pattern rows come from the server's keyword list, so they show even when the TMDB search fails.
      setOpen(true);
      const lookups = patternsFor(term).map(async ({ pattern }) => {
        const response = await fetch(`/api/tmdb/keyword-pattern?${new URLSearchParams({ pattern })}`, { signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        if (response.ok) setPreviews((prev) => ({ ...prev, [pattern]: data }));
      }).map((lookup) => lookup.catch(() => undefined));
      try {
        if (isPattern(term)) {
          setResults([]);
        } else {
          const params = new URLSearchParams({ query: term });
          const key = config.apiKeys?.tmdb?.trim();
          if (key) params.set('apikey', key);
          if (auth.userUUID) params.set('userUUID', auth.userUUID);
          const response = await fetch(`/api/tmdb/discover/search/keyword?${params}`, { signal: controller.signal });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data?.error || `Search failed (${response.status})`);
          setResults(Array.isArray(data?.results) ? data.results : []);
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setResults([]);
        setError(err instanceof Error ? err.message : 'Search failed');
      }
      await Promise.all(lookups);
      if (!controller.signal.aborted) setLoading(false);
    }, SEARCH_DELAY_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [term, config.apiKeys?.tmdb, auth.userUUID]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const chosen = new Set(value.map((name) => name.toLowerCase()));
  // The list stays open, so several keywords and patterns can be added from one search.
  const add = (name: string) => {
    if (!chosen.has(name.toLowerCase())) onChange([...value, name]);
  };
  const remove = (name: string) => onChange(value.filter((existing) => existing !== name));

  return (
    <div className="space-y-2" ref={box}>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((name) => (
            <Badge
              key={name}
              variant={isPattern(name) ? 'outline' : 'secondary'}
              className="gap-1 pr-1"
              title={isPattern(name) ? 'Pattern: hides every keyword that fits it, including ones TMDB adds later' : undefined}
            >
              {isPattern(name) && <Asterisk className="size-3 text-muted-foreground" aria-hidden />}
              <span className={isPattern(name) ? 'font-mono text-[11px]' : undefined}>{name}</span>
              <button
                type="button"
                aria-label={`Remove ${name}`}
                onClick={() => remove(name)}
                className="rounded-sm p-0.5 hover:bg-foreground/10"
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="relative">
        <Input
          id={id}
          placeholder="Search TMDB keywords, or type a pattern like christmas*"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => (results.length || suggestions.length) && setOpen(true)}
          autoComplete="off"
        />
        {loading && (
          <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
        {open && (suggestions.length > 0 || results.length > 0) && (
          <div className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
            {suggestions.map(({ pattern, label, shown }) => {
              const preview = previews[pattern];
              const taken = chosen.has(pattern.toLowerCase());
              return (
                <button
                  key={pattern}
                  type="button"
                  disabled={taken || preview?.valid === false}
                  onClick={() => add(pattern)}
                  className="flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-default disabled:opacity-60"
                >
                  {taken ? <Check className="mt-0.5 size-3.5 shrink-0" /> : <Asterisk className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0">
                    <span className="block">
                      {label} <span className="font-mono text-xs">{shown}</span>
                      {shown !== pattern && <span className="ml-1 font-mono text-[11px] text-muted-foreground">({pattern})</span>}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">{previewText(preview)}</span>
                  </span>
                </button>
              );
            })}
            {suggestions.length > 0 && results.length > 0 && <div className="my-1 border-t" />}
            {results.map((result) => {
              const taken = chosen.has(result.name.toLowerCase());
              return (
                <button
                  key={result.id}
                  type="button"
                  disabled={taken}
                  onClick={() => add(result.name)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-default disabled:opacity-60"
                >
                  <Check className={`size-3.5 shrink-0 ${taken ? '' : 'invisible'}`} />
                  {result.name}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
