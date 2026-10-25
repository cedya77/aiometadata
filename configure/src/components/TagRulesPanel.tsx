import { useEffect, useState, type ReactNode } from 'react';
import { Ban, ChevronRight, Clock, Download, Minus, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { TmdbKeywordPicker } from '@/components/settings/TmdbKeywordPicker';
import { cn } from '@/lib/utils';
import { AGE_RATING_ORDER } from '@/lib/ageRatings';
import { TAG_COLORS, TAG_COLOR_KEYS } from '@/lib/tagColors';
import { HOUR_PRESETS, QUICK_HIDE_KEYWORDS, hiddenSummary, inWindow, nowMinute, samePreset, stepTime, type TagRules, type ViewingHours } from '@/lib/tagRules';
import { MAX_TAG_NAME_LENGTH, type TagColorKey, type TagDef } from '@/contexts/config';

const RATINGS = ['None', ...AGE_RATING_ORDER];
const SEGMENTS = Array.from({ length: 48 }, (_, i) => i);

type Section = 'rating' | 'hide' | 'hours';

interface TagRulesPanelProps {
  tag: TagDef;
  timezone: string;
  profiles: string[];
  onRename: (name: string) => void;
  onRecolor: (color: TagColorKey) => void;
  onFilters: (patch: Pick<TagDef, 'ageRating' | 'allowUnratedContent'>) => void;
  onRules: (patch: TagRules) => void;
  onDelete: () => void;
}

function useNow(timezone: string): number {
  const [now, setNow] = useState(() => nowMinute(timezone));
  useEffect(() => {
    setNow(nowMinute(timezone));
    const timer = setInterval(() => setNow(nowMinute(timezone)), 60000);
    return () => clearInterval(timer);
  }, [timezone]);
  return now;
}

function RuleRow({ icon, title, summary, jellyfin, open, onToggle, control, children }: {
  icon: ReactNode;
  title: string;
  summary: ReactNode;
  jellyfin?: boolean;
  open?: boolean;
  onToggle?: () => void;
  control?: ReactNode;
  children?: ReactNode;
}) {
  const head = (
    <>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
        <span className="flex shrink-0 items-center gap-1.5 text-sm font-semibold sm:w-36">
          {title}
          {jellyfin && <span className="rounded border border-border/80 px-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">JF</span>}
        </span>
        <span className="min-w-0 truncate text-xs text-muted-foreground sm:flex-1 sm:text-sm">{summary}</span>
      </span>
    </>
  );
  return (
    <div className={cn('overflow-hidden rounded-lg border bg-background/70 transition-colors', open ? 'border-border' : 'border-border/60')}>
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className={cn('flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', open && 'bg-muted/20')}
        >
          {head}
          <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        </button>
      ) : (
        <div className="flex w-full items-center gap-3 px-3 py-2.5">
          {head}
          {control}
        </div>
      )}
      {open && children ? <div className="space-y-3 px-3 pb-4 pt-1 sm:pl-[3.25rem]">{children}</div> : null}
    </div>
  );
}

function TimeStepper({ label, value, onStep }: { label: string; value: string; onStep: (by: number) => void }) {
  return (
    <div className="flex items-center justify-between rounded-lg border bg-card py-1.5 pl-3 pr-1.5">
      <span>
        <span className="block text-[11px] text-muted-foreground">{label}</span>
        <span className="block text-xl font-semibold tabular-nums tracking-tight">{value}</span>
      </span>
      <span className="flex gap-1">
        <Button type="button" variant="outline" size="icon" className="h-8 w-8" aria-label={`${label} 30 minutes earlier`} onClick={() => onStep(-1)}>
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="outline" size="icon" className="h-8 w-8" aria-label={`${label} 30 minutes later`} onClick={() => onStep(1)}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </span>
    </div>
  );
}

function ViewingHoursEditor({ hours, color, now, timezone, onChange }: { hours?: ViewingHours; color: TagColorKey; now: number; timezone: string; onChange: (hours: ViewingHours | undefined) => void }) {
  const step = (key: 'start' | 'end', by: number) => {
    if (!hours) return;
    const next = { ...hours, [key]: stepTime(hours[key], by) };
    if (next.start !== next.end) onChange(next);
  };

  return (
    <>
      {hours && (
        <>
          <div className="space-y-1.5">
            <div className="relative" aria-hidden="true">
              <div className="grid h-9 grid-cols-[repeat(48,minmax(0,1fr))] gap-[2px]">
                {SEGMENTS.map((i) => (
                  <span
                    key={i}
                    className={cn(
                      'rounded-[2px]',
                      i === 0 && 'rounded-l-md',
                      i === 47 && 'rounded-r-md',
                      inWindow(hours, i * 30) ? TAG_COLORS[color].swatch : i < 12 || i >= 42 ? 'bg-muted/50' : 'bg-muted',
                    )}
                  />
                ))}
              </div>
              <span className="absolute -bottom-1 -top-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground shadow-[0_0_0_2px_hsl(var(--background))]" style={{ left: `${(now / 1440) * 100}%` }} />
            </div>
            <div className="grid grid-cols-5 text-[11px] text-muted-foreground">
              <span>00:00</span>
              <span className="text-center">06:00</span>
              <span className="text-center">12:00</span>
              <span className="text-center">18:00</span>
              <span className="text-right">24:00</span>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <TimeStepper label="From" value={hours.start} onStep={(by) => step('start', by)} />
            <TimeStepper label="Until" value={hours.end} onStep={(by) => step('end', by)} />
          </div>
        </>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {HOUR_PRESETS.map((preset) => {
          const active = samePreset(hours, preset.hours);
          return (
            <button
              key={preset.label}
              type="button"
              title={preset.hours ? `${preset.hours.start} to ${preset.hours.end}` : undefined}
              aria-pressed={active}
              onClick={() => onChange(preset.hours ?? undefined)}
              className={cn(
                'h-7 rounded-full border px-3 text-xs font-medium transition-colors',
                active ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30 text-muted-foreground hover:text-foreground',
              )}
            >
              {preset.label}
            </button>
          );
        })}
        <span className="ml-auto text-[11px] text-muted-foreground">{timezone}, set in General</span>
      </div>
      <p className="text-xs text-muted-foreground">Browsing stays open; play only works inside the window.</p>
    </>
  );
}

function ListField({ id, label, placeholder, value, onChange }: { id: string; label: string; placeholder: string; value: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState(value.join(', '));
  useEffect(() => setDraft(value.join(', ')), [value]);
  const commit = () => {
    const next = [...new Set(draft.split(',').map((item) => item.trim()).filter(Boolean))];
    if (next.join(',') !== value.join(',')) onChange(next);
  };
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-semibold">{label}</Label>
      <Input
        id={id}
        value={draft}
        placeholder={placeholder}
        className="h-9 bg-card"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
      />
    </div>
  );
}

function HideTitlesEditor({ tag, onRules }: { tag: TagDef; onRules: (patch: TagRules) => void }) {
  const keywords = tag.hideKeywords ?? [];
  const missing = QUICK_HIDE_KEYWORDS.filter((keyword) => !keywords.some((held) => held.toLowerCase() === keyword));
  const listOrNothing = (list: string[]) => (list.length ? list : undefined);
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor={`hide-keywords-${tag.name}`} className="text-xs font-semibold">TMDB keywords</Label>
        <TmdbKeywordPicker id={`hide-keywords-${tag.name}`} value={keywords} onChange={(next) => onRules({ hideKeywords: listOrNothing(next) })} />
        {missing.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-[11px] text-muted-foreground">Common for kids:</span>
            {missing.map((keyword) => (
              <button
                key={keyword}
                type="button"
                onClick={() => onRules({ hideKeywords: [...keywords, keyword] })}
                className="h-6 rounded-full border border-dashed border-muted-foreground/40 px-2.5 text-[11px] text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground"
              >
                + {keyword}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <ListField
          id={`hide-words-${tag.name}`}
          label="Words in title or description"
          placeholder="naked, slasher"
          value={tag.hideWords ?? []}
          onChange={(next) => onRules({ hideWords: listOrNothing(next) })}
        />
        <ListField
          id={`hide-genres-${tag.name}`}
          label="Genres"
          placeholder="Horror, Thriller"
          value={tag.hideGenres ?? []}
          onChange={(next) => onRules({ hideGenres: listOrNothing(next) })}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Hidden on top of what Filters hides for everyone, on installs naming this tag and on Jellyfin. Titles TMDB has not tagged yet, mostly new anime, are only caught by the word list.
      </p>
    </>
  );
}

export function TagRulesPanel({ tag, timezone, profiles, onRename, onRecolor, onFilters, onRules, onDelete }: TagRulesPanelProps) {
  const [draft, setDraft] = useState(tag.name);
  const [open, setOpen] = useState<Section | null>(null);
  const now = useNow(timezone);
  useEffect(() => setDraft(tag.name), [tag.name]);
  const commitName = () => {
    const next = draft.trim();
    if (next && next.length <= MAX_TAG_NAME_LENGTH && next !== tag.name) onRename(next);
    else setDraft(tag.name);
  };
  const toggle = (section: Section) => setOpen((current) => (current === section ? null : section));

  const rating = tag.ageRating && tag.ageRating !== 'None' ? tag.ageRating : 'None';
  const downloads = tag.allowDownloads !== false;
  const hours = tag.viewingHours;
  const hoursSummary = hours
    ? `${hours.start}-${hours.end} · ${inWindow(hours, now) ? 'open now' : `closed, opens ${hours.start}`}`
    : 'Any time';

  return (
    <div className="space-y-2 border-t border-border/60 px-4 pb-4 pt-4">
      <div className="flex flex-wrap items-center gap-3 pb-1">
        <Input
          value={draft}
          maxLength={MAX_TAG_NAME_LENGTH}
          aria-label={`Name of ${tag.name}`}
          className="h-9 min-w-[10rem] flex-1"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitName();
            if (e.key === 'Escape') setDraft(tag.name);
          }}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          {TAG_COLOR_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => onRecolor(key)}
              aria-label={`Set ${tag.name} color ${key}`}
              aria-pressed={tag.color === key}
              className={cn(
                'h-5 w-5 rounded-full border transition-transform',
                TAG_COLORS[key].swatch,
                tag.color === key ? 'scale-110 ring-2 ring-foreground ring-offset-2 ring-offset-background' : 'border-transparent hover:scale-110',
              )}
            />
          ))}
        </div>
      </div>

      <RuleRow
        icon={<ShieldCheck className="h-3.5 w-3.5" />}
        title="Content rating"
        summary={rating === 'None' ? 'All ratings' : `${rating} and lower${tag.allowUnratedContent === false ? ', rated only' : ''}`}
        open={open === 'rating'}
        onToggle={() => toggle('rating')}
      >
        <div className="grid grid-cols-6 gap-1 rounded-lg border bg-muted/30 p-1">
          {RATINGS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={rating === value}
              onClick={() => onFilters(value === 'None' ? { ageRating: 'None', allowUnratedContent: undefined } : { ageRating: value })}
              className={cn(
                'h-8 rounded-md text-xs font-semibold transition-colors',
                rating === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {value === 'None' ? 'All' : value}
            </button>
          ))}
        </div>
        {rating !== 'None' && (
          <div className="flex items-center gap-2">
            <Switch
              id={`tag-unrated-${tag.name}`}
              checked={tag.allowUnratedContent === false}
              onCheckedChange={(checked) => onFilters({ allowUnratedContent: checked ? false : undefined })}
            />
            <Label className="text-xs" htmlFor={`tag-unrated-${tag.name}`}>Hide titles with no rating</Label>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {rating === 'None' ? 'Every title, whatever its rating.' : `Titles rated ${rating} and lower, in catalogs and search.`}
        </p>
      </RuleRow>

      <RuleRow
        icon={<Ban className="h-3.5 w-3.5" />}
        title="Hide titles"
        summary={hiddenSummary(tag)}
        open={open === 'hide'}
        onToggle={() => toggle('hide')}
      >
        <HideTitlesEditor tag={tag} onRules={onRules} />
      </RuleRow>

      <RuleRow
        icon={<Clock className="h-3.5 w-3.5" />}
        title="Viewing hours"
        jellyfin
        summary={hoursSummary}
        open={open === 'hours'}
        onToggle={() => toggle('hours')}
      >
        <ViewingHoursEditor hours={hours} color={tag.color} now={now} timezone={timezone} onChange={(viewingHours) => onRules({ viewingHours })} />
      </RuleRow>

      <RuleRow
        icon={<Download className="h-3.5 w-3.5" />}
        title="Downloads"
        jellyfin
        summary={downloads ? 'Allowed' : 'Off, stream only'}
        control={
          <Switch
            checked={downloads}
            aria-label={`Allow downloads for ${tag.name}`}
            onCheckedChange={(checked) => onRules({ allowDownloads: checked ? undefined : false })}
          />
        }
      />

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <span className="text-xs text-muted-foreground">{profiles.length ? 'Used by' : 'Not on a Jellyfin user yet'}</span>
        {profiles.map((name) => (
          <span key={name} className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 py-0.5 pl-0.5 pr-2.5 text-xs font-medium">
            <span className={cn('flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white', TAG_COLORS[tag.color].swatch)}>
              {name.slice(0, 1).toUpperCase()}
            </span>
            {name}
          </span>
        ))}
        <Button type="button" variant="outline" size="sm" className="ml-auto h-8 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={onDelete}>
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Delete tag
        </Button>
      </div>
    </div>
  );
}
