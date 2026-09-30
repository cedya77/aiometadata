import { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useConfig } from '@/contexts/ConfigContext';

interface KeywordResult {
  id: number;
  name: string;
}

const SEARCH_DELAY_MS = 300;

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
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      setError('');
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams({ query: term });
        const key = config.apiKeys?.tmdb?.trim();
        if (key) params.set('apikey', key);
        if (auth.userUUID) params.set('userUUID', auth.userUUID);
        const response = await fetch(`/api/tmdb/discover/search/keyword?${params}`, { signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error || `Search failed (${response.status})`);
        setResults(Array.isArray(data?.results) ? data.results : []);
        setOpen(true);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setResults([]);
        setError(err instanceof Error ? err.message : 'Search failed');
      } finally {
        setLoading(false);
      }
    }, SEARCH_DELAY_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, config.apiKeys?.tmdb, auth.userUUID]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const chosen = new Set(value.map((name) => name.toLowerCase()));
  const add = (name: string) => {
    if (!chosen.has(name.toLowerCase())) onChange([...value, name]);
    setQuery('');
    setResults([]);
    setOpen(false);
  };
  const remove = (name: string) => onChange(value.filter((existing) => existing !== name));

  return (
    <div className="space-y-2" ref={box}>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((name) => (
            <Badge key={name} variant="secondary" className="gap-1 pr-1">
              {name}
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
          placeholder="Search TMDB keywords (e.g. christmas, stand-up comedy)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          autoComplete="off"
        />
        {loading && (
          <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
        {open && results.length > 0 && (
          <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
            {results.map((result) => {
              const taken = chosen.has(result.name.toLowerCase());
              return (
                <button
                  key={result.id}
                  type="button"
                  disabled={taken}
                  onClick={() => add(result.name)}
                  className="block w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-default disabled:opacity-50"
                >
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
