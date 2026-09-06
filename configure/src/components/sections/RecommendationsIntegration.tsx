import { useEffect, useState } from 'react';
import { Check, Clapperboard, Clock, Loader2, Plus, Sparkles, Tv, TriangleAlert, Wand2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Callout } from '@/components/settings/Callout';
import { SettingRow } from '@/components/settings/SettingRow';
import { useConfig } from '@/contexts/ConfigContext';
import type { AppConfig, CatalogConfig } from '@/contexts/config';
import { GEMINI_MODELS, resolveGeminiModel } from '@/data/ai-models';
import { useOpenRouterModels } from '@/hooks/useOpenRouterModels';

/**
 * One catalog per kind. A mixed row is not offered on purpose: nothing in the
 * metadata separates anime from live-action, so a single pass returns the same
 * title twice, and one row cannot be weighted for a library that is a third
 * anime and a third film.
 */
const OFFERED: Array<{ id: string; name: string; type: CatalogConfig['type']; icon: typeof Tv; blurb: string }> = [
  { id: 'recommendations.movies', name: 'Films For You', type: 'movie', icon: Clapperboard, blurb: 'Films only, anime excluded' },
  { id: 'recommendations.series', name: 'Series For You', type: 'series', icon: Tv, blurb: 'Live action, anime excluded' },
  { id: 'recommendations.anime', name: 'Anime For You', type: 'anime', icon: Sparkles, blurb: 'Anime series and films' },
];

const SKY_CARD = 'bg-gradient-to-br from-sky-500/10 via-card/80 to-card/80 border-sky-400/20';
const SKY_TILE = 'shrink-0 h-10 w-10 rounded-lg bg-sky-500/15 text-sky-300 flex items-center justify-center ring-1 ring-sky-400/20';
const STAT = 'flex items-center justify-between p-2 rounded-lg bg-muted/40';
const TRAY = 'flex w-full gap-1 rounded-xl bg-white/[0.02] p-1 sm:w-fit';

type JobStage = 'queued' | 'reading-history' | 'building-profile' | 'choosing' | 'fetching-art' | 'done' | 'error';

interface Job {
  catalogId: string;
  stage: JobStage;
  picks: number;
  error?: string;
  /** The settings it was started under, so a later change retires it. */
  stamp?: string;
}

const STAGE_LABEL: Record<JobStage, string> = {
  queued: 'Queued…',
  'reading-history': 'Reading your history…',
  'building-profile': 'Working out your taste…',
  choosing: 'Choosing titles…',
  'fetching-art': 'Fetching artwork…',
  done: 'Ready',
  error: 'Failed',
};

interface Status {
  sources: string;
  connected: { simkl: boolean; mdblist: boolean };
  provider: { provider: string; model: string } | null;
  counts: { total: number; movies: number; series: number; anime: number; rated: number; meanRating?: number };
  profile: { summary: string; builtAt: string; builtFrom: number } | null;
}

function segment(active: boolean): string {
  return `min-h-[40px] flex-1 rounded-lg px-4 text-sm transition-colors sm:flex-none ${
    active ? 'bg-white/[0.08] text-foreground shadow-sm' : 'text-muted-foreground hover:bg-white/[0.04]'
  }`;
}

export function RecommendationsIntegration({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { config, setConfig, auth } = useConfig();
  const { models: openRouterModels, loading: openRouterModelsLoading } =
    useOpenRouterModels(config.apiKeys?.openrouter);

  const [status, setStatus] = useState<Status | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [jobs, setJobs] = useState<Record<string, Job>>({});

  const configId = auth.userUUID || (() => {
    const parts = window.location.pathname.split('/');
    const at = parts.findIndex(part => part === 'stremio');
    return at !== -1 ? parts[at + 1] : null;
  })();

  // Any build at all, including one whose settings have since been edited: work
  // is still in flight, and that is what the footer waits on.
  const anyRunning = Object.values(jobs).some(job => job.stage !== 'done' && job.stage !== 'error');

  const hasSimkl = !!config.apiKeys?.simklTokenId;
  const hasMdblist = !!config.apiKeys?.mdblist;
  const hasHistory = hasSimkl || hasMdblist;
  const hasGemini = !!config.apiKeys?.gemini;
  const hasOpenRouter = !!config.apiKeys?.openrouter;
  const hasModel = hasGemini || hasOpenRouter;
  const ready = hasHistory && hasModel;

  // Held here rather than written straight through, so the configuration is not
  // marked unsaved on every keystroke of an edit still being made.
  const saved = config.recommendations;
  const [draft, setDraft] = useState<NonNullable<AppConfig['recommendations']>>(saved || {});
  // Opening reloads from the configuration; a later change to it must not
  // overwrite an edit in progress, so it is deliberately not a dependency.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (isOpen) setDraft(saved || {}); }, [isOpen]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved || {});

  const sources = draft.sources || 'both';
  const preferred = draft.provider;
  const webSearch = draft.web_search === true;
  const thinking = draft.reasoning_effort || 'low';
  const stalled = draft.stalled_weight || 'note';
  const staleDays = draft.stale_after_days || 180;
  const refreshHours = draft.refresh_hours || 24;
  const usingOpenRouter = preferred === 'openrouter'
    ? hasOpenRouter
    : preferred === 'gemini' ? false : !hasGemini && hasOpenRouter;

  // Reads what is already known; never triggers a build, so opening this panel
  // cannot spend a model call.
  const draftKey = JSON.stringify(draft);
  useEffect(() => {
    if (!isOpen || !ready || !configId) return;
    let cancelled = false;
    setLoadingStatus(true);
    fetch(`/api/recommendations/status?userUUID=${encodeURIComponent(configId)}`
      + `&recommendations=${encodeURIComponent(draftKey)}`)
      .then(response => (response.ok ? response.json() : null))
      .then(payload => { if (!cancelled) setStatus(payload); })
      .catch(() => { if (!cancelled) setStatus(null); })
      .finally(() => { if (!cancelled) setLoadingStatus(false); });
    return () => { cancelled = true; };
  }, [isOpen, ready, configId, anyRunning, draftKey]);

  // Polled only while something is running, and stopped as soon as nothing is.
  useEffect(() => {
    if (!isOpen || !configId || !anyRunning) return;
    let cancelled = false;
    const tick = () => {
      fetch(`/api/recommendations/jobs?userUUID=${encodeURIComponent(configId)}`)
        .then(response => (response.ok ? response.json() : null))
        .then(payload => {
          if (cancelled || !payload?.jobs) return;
          setJobs(existing => {
            const next = { ...existing };
            // Server-side jobs outlive the dialog by half an hour, so adopting all
            // of them reported kinds built earlier, under other settings, as though
            // they had just been built here.
            for (const job of payload.jobs as Job[]) {
              const mine = existing[job.catalogId];
              if (mine) next[job.catalogId] = { ...job, stamp: mine.stamp };
            }
            return next;
          });
        })
        .catch(() => undefined);
    };
    const timer = setInterval(tick, 1500);
    tick();
    return () => { cancelled = true; clearInterval(timer); };
  }, [isOpen, configId, anyRunning]);

  // A build carries the settings it was started with, so changing them retires
  // its result without throwing away a run that is still going.
  const current = Object.fromEntries(
    Object.entries(jobs).filter(([, job]) => job.stamp === draftKey),
  ) as Record<string, Job>;

  const added = new Set(config.catalogs.map(catalog => catalog.id));

  const patch = (fields: Record<string, unknown>) => setDraft(current => ({ ...current, ...fields }));

  /**
   * Builds a row without touching the configuration.
   *
   * Applying is a separate, deliberate action: a build takes half a minute and
   * can fail, and a catalog that appears in the list before it has anything in
   * it is a row the user has to remember to remove.
   */
  const generate = (id: string) => {
    if (!configId) return;
    setJobs(existing => ({ ...existing, [id]: { catalogId: id, stage: 'queued', picks: 0, stamp: draftKey } }));
    fetch('/api/recommendations/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userUUID: configId,
        catalogId: id,
        recommendations: draft,
      }),
    }).catch(() => {
      setJobs(existing => ({
        ...existing,
        [id]: { catalogId: id, stage: 'error', picks: 0, error: 'Could not start', stamp: draftKey },
      }));
    });
  };

  const readyToAdd = OFFERED.filter(({ id }) => current[id]?.stage === 'done' && !added.has(id));

  // Nothing is applied mid-build: a row committed now would be one whose picks
  // are still being chosen, and the settings behind them can still change.
  const pending = (readyToAdd.length > 0 || dirty) && !anyRunning;

  /**
   * Rows and settings are committed together. They were two buttons, which made
   * a reader work out which of them their change belonged to, and adding a row
   * built under settings that were not kept would rebuild it as something else.
   */
  const apply = () => {
    if (!pending) return;
    setConfig(prev => ({
      ...prev,
      recommendations: { ...draft },
      catalogs: [
        ...prev.catalogs,
        ...readyToAdd.map(({ id, name, type }) => ({
          id, name, type, enabled: true, showInHome: true, source: 'recommendations',
        }) as unknown as CatalogConfig),
      ],
    }));
    toast.success(readyToAdd.length
      ? readyToAdd.length === 1 ? `Added ${readyToAdd[0].name}` : `Added ${readyToAdd.length} catalogs`
      : 'Settings kept');
  };

  const currentModel = usingOpenRouter
    ? draft.openrouter_model || ''
    : draft.gemini_model || '';

  return (
    <Dialog open={isOpen} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Recommendations</DialogTitle>
          <DialogDescription>
            Reads what you have watched, works out what you reach for, and suggests things you have
            not seen. Your history goes only to the model you have already configured.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {!ready && (
            <Card className="bg-gradient-to-br from-amber-500/10 via-card/80 to-card/80 border-amber-400/20">
              <CardHeader className="flex-row items-start gap-3 sm:gap-4 space-y-0 p-4 sm:p-6">
                <div className="shrink-0 h-10 w-10 rounded-lg bg-amber-500/15 text-amber-300 flex items-center justify-center ring-1 ring-amber-400/20">
                  <Wand2 className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0 space-y-1.5">
                  <CardTitle>Two things are needed first</CardTitle>
                  <CardDescription>
                    {!hasHistory && 'Connect Simkl or add an MDBList key so there is a watch history to read. '}
                    {!hasModel && 'Add a Gemini or OpenRouter key so there is a model to read it with.'}
                  </CardDescription>
                </div>
              </CardHeader>
            </Card>
          )}

          {ready && (
            <Card className={SKY_CARD}>
              <CardHeader className="flex-row items-start gap-3 sm:gap-4 space-y-0 p-4 sm:p-6">
                <div className={SKY_TILE}><Sparkles className="h-5 w-5" /></div>
                <div className="flex-1 min-w-0 space-y-1.5">
                  <CardTitle>Your taste profile</CardTitle>
                  <CardDescription className="line-clamp-3">
                    {loadingStatus ? 'Reading your history…'
                      : status?.profile?.summary
                        || 'Not built yet. It is written the first time a row loads, or when you save.'}
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {hasSimkl && hasMdblist && (
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">Watch history</Label>
                    <div className={TRAY}>
                      {([['both', 'Both'], ['simkl', 'Simkl'], ['mdblist', 'MDBList']] as const).map(([id, label]) => (
                        <button key={id} type="button" onClick={() => patch({ sources: id })}
                          aria-pressed={sources === id} className={segment(sources === id)}>
                          {label}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      The two rarely hold the same library; the one with more of your viewing
                      describes you better. The figures below follow this.
                    </p>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {[
                    ['Titles read', status?.counts?.total],
                    ['Films', status?.counts?.movies],
                    ['Series', status?.counts?.series],
                    ['Anime', status?.counts?.anime],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="rounded-lg bg-muted/40 p-2 text-center">
                      <div className="text-lg font-bold tabular-nums">{value ?? '—'}</div>
                      <div className="text-xs text-muted-foreground">{label}</div>
                    </div>
                  ))}
                </div>
                <div className="space-y-2">
                  <div className={STAT}>
                    <span className="text-xs text-muted-foreground">Reading from</span>
                    <span className="text-sm font-medium capitalize">
                      {status?.connected?.simkl && status?.connected?.mdblist ? status.sources
                        : status?.connected?.simkl ? 'Simkl' : status?.connected?.mdblist ? 'MDBList' : '—'}
                    </span>
                  </div>
                  <div className={STAT}>
                    <span className="text-xs text-muted-foreground">Written by</span>
                    <span className="font-mono text-xs">{status?.provider?.model || '—'}</span>
                  </div>
                  {status?.profile?.builtAt && (
                    <div className={STAT}>
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Clock className="h-3.5 w-3.5" /> Written
                      </span>
                      <span className="text-sm font-medium">
                        {new Date(status.profile.builtAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                        {status.profile.builtFrom ? ` · ${status.profile.builtFrom} titles` : ''}
                      </span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex-row items-start gap-3 sm:gap-4 space-y-0 p-4 sm:p-6">
              <div className={SKY_TILE}><Wand2 className="h-5 w-5" /></div>
              <div className="flex-1 min-w-0 space-y-1.5">
                <CardTitle>How it is built</CardTitle>
                <CardDescription>
                  A profile is written rarely and reused for a week, so a stronger model here costs
                  very little.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {hasGemini && hasOpenRouter && (
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Provider</Label>
                  <div className={TRAY}>
                    {([['gemini', 'Gemini'], ['openrouter', 'OpenRouter']] as const).map(([id, label]) => (
                      <button key={id} type="button" onClick={() => patch({ provider: id })}
                        aria-pressed={usingOpenRouter === (id === 'openrouter')}
                        className={segment(usingOpenRouter === (id === 'openrouter'))}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="recommendation-model" className="text-sm font-medium">
                  {usingOpenRouter ? 'OpenRouter model' : 'Gemini model'}
                </Label>
                {usingOpenRouter ? (
                  <>
                    <Input
                      id="recommendation-model"
                      list="recommendation-openrouter-models"
                      value={currentModel}
                      onChange={event => patch({ openrouter_model: event.target.value.trim() })}
                      placeholder={openRouterModelsLoading ? 'Loading models…' : 'e.g. anthropic/claude-opus-5'}
                      className="w-full font-mono text-sm sm:w-[320px]"
                    />
                    <datalist id="recommendation-openrouter-models">
                      {openRouterModels.map(model => (
                        <option key={model.id} value={model.id}>{model.name}</option>
                      ))}
                    </datalist>
                  </>
                ) : (
                  <Select value={currentModel ? resolveGeminiModel(currentModel) : ''}
                    onValueChange={value => patch({ gemini_model: value })}>
                    <SelectTrigger id="recommendation-model" aria-label="Gemini model" className="w-full sm:w-[320px]">
                      <SelectValue placeholder="Same as the AI catalog builder" />
                    </SelectTrigger>
                    <SelectContent>
                      {GEMINI_MODELS.map(model => (
                        <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {currentModel && (
                  <button type="button"
                    onClick={() => patch(usingOpenRouter ? { openrouter_model: '' } : { gemini_model: '' })}
                    className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                    Use the AI catalog builder's model instead
                  </button>
                )}
              </div>

              <SettingRow
                htmlFor="recommendation-web-search"
                label="Web search"
                description={usingOpenRouter
                  ? 'Adds :online so the model sees live results. Billed by OpenRouter at roughly $0.005 per search, on top of the model.'
                  : 'Lets the model look up what has come out lately. Requires a paid Gemini API key; free keys will get 429 errors.'}
                control={
                  <Switch
                    id="recommendation-web-search"
                    className="shrink-0"
                    checked={webSearch}
                    onCheckedChange={checked => patch({ web_search: checked })}
                  />
                }
                note={!webSearch ? (
                  <Callout variant="info" className="text-xs">
                    Without it, nothing released after the model's training cut-off can be
                    recommended, however recent the rest of your library is.
                  </Callout>
                ) : undefined}
              />

              {usingOpenRouter && (
                <SettingRow
                  htmlFor="recommendation-thinking"
                  label="Thinking"
                  description="How long the model works before it writes the list. Thinking is billed like the answer and shares the same reply budget, so more of it costs more and leaves less room for the list itself."
                  control={
                    <Select value={thinking} onValueChange={value => patch({ reasoning_effort: value })}>
                      <SelectTrigger id="recommendation-thinking" aria-label="Thinking" className="w-full shrink-0 sm:w-[160px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="minimal">Minimal</SelectItem>
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                      </SelectContent>
                    </Select>
                  }
                  note={thinking === 'medium' || thinking === 'high' ? (
                    <Callout variant="warn" className="text-xs">
                      A long list can come back unfinished at this setting, because the thinking
                      uses up the reply before the recommendations are written.
                    </Callout>
                  ) : undefined}
                />
              )}

              <div className="space-y-2 border-t border-white/[0.06] pt-4">
                <Label className="text-sm font-medium">Write new rows</Label>
                <div className={TRAY}>
                  {([[6, 'Every 6 hours'], [12, 'Every 12 hours'], [24, 'Once a day']] as const).map(([id, label]) => (
                    <button key={id} type="button" onClick={() => patch({ refresh_hours: id })}
                      aria-pressed={refreshHours === id} className={segment(refreshHours === id)}>
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Each rewrite is a model call you are billed for, across every row you have
                  added. Your taste does not change by the hour, so a shorter setting mostly
                  buys different titles rather than better ones.
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium">Unfinished series</Label>
                <div className={TRAY}>
                  {([
                    ['ignore', 'Ignore'],
                    ['note', 'Note it'],
                    ['mild', 'Counts a little'],
                    ['dislike', 'Counts fully'],
                  ] as const).map(([id, label]) => (
                    <button key={id} type="button" onClick={() => patch({ stalled_weight: id })}
                      aria-pressed={stalled === id} className={segment(stalled === id)}>
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  A series you started and never went back to. People stop because a season
                  ended or because they forgot, so by default it is written down without being
                  held against the title.
                </p>
              </div>

              {stalled !== 'ignore' && (
                <div className="space-y-2">
                  <Label htmlFor="recommendation-stale" className="text-sm font-medium">
                    Counts as set aside after
                  </Label>
                  <Select value={String(staleDays)}
                    onValueChange={value => patch({ stale_after_days: Number(value) })}>
                    <SelectTrigger id="recommendation-stale" className="w-full sm:w-[220px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="90">3 months</SelectItem>
                      <SelectItem value="180">6 months</SelectItem>
                      <SelectItem value="365">1 year</SelectItem>
                      <SelectItem value="730">2 years</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    How long a series can sit untouched before it stops counting as something you
                    are still working through. Raise it if you watch several things slowly.
                  </p>
                </div>
              )}

            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex-row items-start gap-3 sm:gap-4 space-y-0 p-4 sm:p-6">
              <div className={SKY_TILE}><Plus className="h-5 w-5" /></div>
              <div className="flex-1 min-w-0 space-y-1.5">
                <CardTitle>Add catalogs</CardTitle>
                <CardDescription>
                  One per kind, kept apart so anime does not crowd out the rest. Build with the
                  settings above, then add what you want — nothing reaches your catalog list until
                  it has something in it.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {OFFERED.map(({ id, name, icon: Icon, blurb }) => {
                const job = current[id];
                const working = !!job && job.stage !== 'done' && job.stage !== 'error';
                const failed = job?.stage === 'error';
                const built = job?.stage === 'done';

                return (
                  <Button
                    key={id}
                    variant="outline"
                    className="h-auto flex-col items-start gap-1 py-3 text-left"
                    disabled={!ready || working}
                    onClick={() => generate(id)}
                  >
                    <span className="flex w-full items-center gap-2">
                      <Icon className="h-4 w-4 shrink-0 text-sky-300" />
                      <span className="font-medium">{name}</span>
                      {working ? <Loader2 className="ml-auto h-4 w-4 shrink-0 animate-spin text-sky-300" />
                        : failed ? <TriangleAlert className="ml-auto h-4 w-4 shrink-0 text-amber-400" />
                        : built || added.has(id) ? <Check className="ml-auto h-4 w-4 shrink-0 text-emerald-400" />
                        : <Plus className="ml-auto h-4 w-4 shrink-0" />}
                    </span>
                    <span className={`text-xs font-normal ${
                      failed ? 'text-amber-400' : built ? 'text-emerald-400' : 'text-muted-foreground'
                    }`}>
                      {job
                        ? failed ? (job.error || 'Failed')
                          : built ? `${job.picks} titles ready${added.has(id) ? '' : ' — add below'}`
                          : STAGE_LABEL[job.stage]
                        : added.has(id) ? 'Added — click to rebuild' : blurb}
                    </span>
                  </Button>
                );
              })}
              </div>

              <p className="border-t border-white/[0.06] pt-3 text-xs text-muted-foreground">
                {anyRunning
                  ? 'Building. It can be added as soon as it finishes.'
                  : 'Pick a kind to build it. Nothing is added until you apply, below.'}
              </p>
            </CardContent>
          </Card>

        </div>

        <div className="sticky bottom-0 -mx-4 -mb-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] bg-card/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 backdrop-blur-sm sm:-mx-6 sm:-mb-6 sm:px-6">
          <p className="text-xs text-muted-foreground">
            {anyRunning
              ? 'Building. Nothing can be applied until it finishes.'
              : readyToAdd.length
                ? 'Built and ready. Applying puts the rows in your catalog list.'
                : dirty
                  ? 'Building uses these settings whether or not they are applied.'
                  : 'Applied changes still need the configuration saved to reach your clients.'}
          </p>
          <Button className="shrink-0" disabled={!pending} onClick={apply}>
            {readyToAdd.length
              ? <><Plus className="mr-1.5 h-4 w-4" />
                {readyToAdd.length > 1 ? `Add ${readyToAdd.length} catalogs` : `Add ${readyToAdd[0].name}`}</>
              : 'Apply settings'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
