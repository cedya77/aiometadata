import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { searchSettings } from '@/lib/settingsSearch';
import { SETTINGS_SEARCH_INDEX } from '@/lib/settingsSearchIndex';
import { SETTINGS_SECTIONS, type SettingsSection, type SettingsSectionId } from '@/lib/settingsRoute';
import { cn } from '@/lib/utils';

const SECTION_TITLES = new Map(SETTINGS_SECTIONS.map((s) => [s.id, s.title]));

export function SettingsSearch({
  onSelect,
  sections = SETTINGS_SECTIONS,
}: {
  onSelect: (section: SettingsSectionId, anchor: string | null) => void;
  sections?: SettingsSection[];
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const usingPointerRef = useRef(false);
  const scrollActiveIntoViewRef = useRef(false);
  const optionRefs = useRef<Array<HTMLLIElement | null>>([]);
  const listId = useId();

  const results = useMemo(() => searchSettings(query, SETTINGS_SEARCH_INDEX, sections), [query, sections]);
  const expanded = open && results.length > 0;

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    if (!scrollActiveIntoViewRef.current) return;
    scrollActiveIntoViewRef.current = false;
    optionRefs.current[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, []);

  const choose = (index: number) => {
    const entry = results[index];
    if (!entry) return;
    setOpen(false);
    onSelect(entry.section, entry.anchor);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      usingPointerRef.current = false;
      scrollActiveIntoViewRef.current = true;
      setOpen(true);
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      usingPointerRef.current = false;
      scrollActiveIntoViewRef.current = true;
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (event.key === 'Enter') {
      if (expanded) { event.preventDefault(); choose(active); }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (open) setOpen(false);
      else setQuery('');
    }
  };

  return (
    <div
      ref={rootRef}
      className="relative"
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node)) setOpen(false);
      }}
    >
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={expanded ? `${listId}-${active}` : undefined}
          aria-label="Search settings"
          placeholder="Search settings..."
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="pl-8 pr-8"
        />
        {query ? (
          <button
            type="button"
            onClick={() => { setQuery(''); inputRef.current?.focus(); }}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {expanded ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Settings search results"
          className="absolute z-50 mt-1 max-h-[60vh] w-full min-w-0 overflow-y-auto rounded-lg border border-white/[0.06] bg-popover p-1 shadow-lg md:w-[420px]"
          onPointerMove={() => { usingPointerRef.current = true; }}
        >
          {results.map((entry, index) => (
            <li
              key={entry.id}
              id={`${listId}-${index}`}
              ref={(el) => { optionRefs.current[index] = el; }}
              role="option"
              aria-selected={index === active}
              onPointerEnter={() => { if (usingPointerRef.current) setActive(index); }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
              className={cn(
                'cursor-pointer rounded-md px-3 py-2',
                index === active && 'bg-accent'
              )}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-sm font-medium">{entry.label}</span>
                <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
                  {SECTION_TITLES.get(entry.section)}
                </span>
              </div>
              {entry.description !== results[index - 1]?.description ? (
                <p className="truncate text-xs text-muted-foreground">{entry.description}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {open && query.trim() && results.length === 0 ? (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-white/[0.06] bg-popover px-3 py-2 text-sm text-muted-foreground shadow-lg md:w-[420px]">
          No settings match "{query}".
        </div>
      ) : null}
    </div>
  );
}
