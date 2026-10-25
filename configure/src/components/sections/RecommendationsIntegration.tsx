import { useEffect, useState } from 'react';
import { Check, Clapperboard, Clock, Plus, Sparkles, Tv, TriangleAlert, Wand2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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

const TRAY = 'flex w-full flex-wrap gap-1 rounded-xl bg-white/[0.03] p-1 sm:w-fit';
const PANEL = 'rounded-xl border border-white/[0.08] bg-white/[0.02]';
const EYEBROW = 'text-xs font-semibold uppercase tracking-[0.08em]';

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
  'reading-history': 'Reading the history…',
  'building-profile': 'Working out the taste…',
  choosing: 'Choosing titles…',
  'fetching-art': 'Fetching artwork…',
  done: 'Ready',
  error: 'Failed',
};

const STAGE_PROGRESS: Record<JobStage, number> = {
  queued: 6, 'reading-history': 22, 'building-profile': 48, choosing: 72, 'fetching-art': 90, done: 100, error: 100,
};

type Source = 'same' | 'both' | 'simkl' | 'mdblist' | 'local';

const SOURCE_NAME: Record<string, string> = { both: 'All', simkl: 'Simkl', mdblist: 'MDBList', local: 'Jellyfin history' };

interface Status {
  sources: string;
  connected: { simkl: boolean; mdblist: boolean; local?: boolean };
  available?: { simkl: boolean; mdblist: boolean };
  provider: { provider: string; model: string } | null;
  counts: { total: number; movies: number; series: number; anime: number; rated: number; meanRating?: number };
  profile: { summary: string; builtAt: string; builtFrom: number } | null;
  profiles?: Array<{ id: string; name: string; avatar?: string; linked: string[] }>;
}

interface Viewer {
  id: string | null;
  name: string;
  avatar?: string;
  note: string;
}

const IMAGE_URL = /^(https?:\/\/|data:image\/)/i;
const TINTS = ['bg-sky-300', 'bg-amber-300', 'bg-violet-300', 'bg-emerald-300', 'bg-rose-300', 'bg-teal-300'];

function segment(active: boolean): string {
  return `min-h-[40px] flex-1 rounded-lg px-4 text-sm transition-colors sm:flex-none ${
    active ? 'bg-white/[0.08] text-foreground shadow-sm' : 'text-muted-foreground hover:bg-white/[0.04]'
  }`;
}

function Avatar({ viewer, index }: { viewer: Viewer; index: number }) {
  if (viewer.avatar && IMAGE_URL.test(viewer.avatar)) {
    return <img src={viewer.avatar} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" />;
  }
  return (
    <span aria-hidden="true"
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-slate-950 ${TINTS[index % TINTS.length]}`}>
      {viewer.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function RecommendationsIntegration({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { config, setConfig, auth } = useConfig();
  const { models: openRouterModels, loading: openRouterModelsLoading } =
    useOpenRouterModels(config.apiKeys?.openrouter);

  const [status, setStatus] = useState<Status | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [viewing, setViewing] = useState<string | null>(null);

  const configId = auth.userUUID || (() => {
    const parts = window.location.pathname.split('/');
    const at = parts.findIndex(part => part === 'stremio');
    return at !== -1 ? parts[at + 1] : null;
  })();

  const viewers: Viewer[] = [
    { id: null, name: config.jellyfinUserName?.trim() || 'You', avatar: config.jellyfinUserAvatar, note: 'Main profile' },
    ...(status?.profiles ?? []).map(profile => ({
      id: profile.id,
      name: profile.name,
      avatar: profile.avatar,
      note: profile.linked.length ? `Own history, ${profile.linked.join(' and ')} linked` : 'Own history, no trackers',
    })),
  ];
  const viewer = viewers.find(entry => entry.id === viewing) ?? viewers[0];
  const isMain = viewer.id === null;
  const viewerKey = viewer.id ?? '';

  // Any build at all, including one whose settings have since been edited: work
  // is still in flight, and that is what the footer waits on.
  const anyRunning = Object.values(jobs).some(job => job.stage !== 'done' && job.stage !== 'error');

  const hasSimkl = status?.available ? status.available.simkl : isMain && !!config.apiKeys?.simklTokenId;
  const hasMdblist = status?.available ? status.available.mdblist : isMain && !!config.apiKeys?.mdblist;
  const hasPlays = (status?.counts?.total ?? 0) > 0;
  const hasHistory = hasSimkl || hasMdblist || hasPlays;
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

  const mainSource: Source = draft.sources || 'both';
  const source: Source = isMain ? mainSource : draft.profiles?.[viewerKey]?.sources || 'same';
  const preferred = draft.provider;
  const webSearch = draft.web_search === true;
  const thinking = draft.reasoning_effort || 'low';
  const stalled = draft.stalled_weight || 'note';
  const staleDays = draft.stale_after_days || 180;
  const refreshHours = draft.refresh_hours || 24;
  const refreshCustom = ![6, 12, 24].includes(refreshHours);
  const order = draft.order || 'balanced';
  const usingOpenRouter = preferred === 'openrouter'
    ? hasOpenRouter
    : preferred === 'gemini' ? false : !hasGemini && hasOpenRouter;

  // Reads what is already known; never triggers a build, so opening this panel
  // cannot spend a model call.
  const draftKey = JSON.stringify(draft);
  useEffect(() => {
    if (!isOpen || !hasModel || !configId) return;
    let cancelled = false;
    setLoadingStatus(true);
    fetch(`/api/recommendations/status?userUUID=${encodeURIComponent(configId)}`
      + `&recommendations=${encodeURIComponent(draftKey)}`
      + (viewerKey ? `&profile=${encodeURIComponent(viewerKey)}` : ''), {
      headers: auth.password ? { 'x-config-password': auth.password } : undefined,
    })
      .then(response => (response.ok ? response.json() : null))
      .then(payload => { if (!cancelled) setStatus(payload); })
      .catch(() => { if (!cancelled) setStatus(null); })
      .finally(() => { if (!cancelled) setLoadingStatus(false); });
    return () => { cancelled = true; };
  }, [isOpen, hasModel, configId, anyRunning, draftKey, viewerKey, auth.password]);

  // Polled only while something is running, and stopped as soon as nothing is.
  useEffect(() => {
    if (!isOpen || !configId || !anyRunning) return;
    let cancelled = false;
    const keys = [...new Set(Object.keys(jobs).map(key => key.split('|')[0]))];
    const tick = () => {
      for (const key of keys) {
        fetch(`/api/recommendations/jobs?userUUID=${encodeURIComponent(configId)}`
          + (key ? `&profile=${encodeURIComponent(key)}` : ''))
          .then(response => (response.ok ? response.json() : null))
          .then(payload => {
            if (cancelled || !payload?.jobs) return;
            setJobs(existing => {
              const next = { ...existing };
              // Server-side jobs outlive the dialog by half an hour, so adopting all
              // of them reported kinds built earlier, under other settings, as though
              // they had just been built here.
              for (const job of payload.jobs as Job[]) {
                const mine = existing[`${key}|${job.catalogId}`];
                if (mine) next[`${key}|${job.catalogId}`] = { ...job, stamp: mine.stamp };
              }
              return next;
            });
          })
          .catch(() => undefined);
      }
    };
    const timer = setInterval(tick, 1500);
    tick();
    return () => { cancelled = true; clearInterval(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, configId, anyRunning]);

  // A build carries the settings it was started with, so changing them retires
  // its result without throwing away a run that is still going.
  const current = Object.fromEntries(
    Object.entries(jobs)
      .filter(([key, job]) => key.startsWith(`${viewerKey}|`) && job.stamp === draftKey)
      .map(([, job]) => [job.catalogId, job]),
  ) as Record<string, Job>;
  const mainJobs = Object.fromEntries(
    Object.entries(jobs)
      .filter(([key, job]) => key.startsWith('|') && job.stamp === draftKey)
      .map(([, job]) => [job.catalogId, job]),
  ) as Record<string, Job>;

  const added = new Set(config.catalogs.map(catalog => catalog.id));

  const patch = (fields: Record<string, unknown>) => setDraft(current => ({ ...current, ...fields }));
  const pickSource = (id: Source) => {
    if (isMain) {
      patch({ sources: id });
      return;
    }
    setDraft(current => ({ ...current, profiles: { ...(current.profiles ?? {}), [viewerKey]: { sources: id } } }));
  };

  /**
   * Builds a row without touching the configuration.
   *
   * Applying is a separate, deliberate action: a build takes half a minute and
   * can fail, and a catalog that appears in the list before it has anything in
   * it is a row the user has to remember to remove.
   */
  const generate = (id: string, force: boolean) => {
    if (!configId) return;
    const key = `${viewerKey}|${id}`;
    setJobs(existing => ({ ...existing, [key]: { catalogId: id, stage: 'queued', picks: 0, stamp: draftKey } }));
    fetch('/api/recommendations/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userUUID: configId,
        catalogId: id,
        recommendations: draft,
        password: auth.password,
        force,
        ...(viewerKey ? { profile: viewerKey } : {}),
      }),
    }).catch(() => {
      setJobs(existing => ({
        ...existing,
        [key]: { catalogId: id, stage: 'error', picks: 0, error: 'Could not start', stamp: draftKey },
      }));
    });
  };

  const readyToAdd = OFFERED.filter(({ id }) => (current[id]?.stage === 'done' || mainJobs[id]?.stage === 'done') && !added.has(id));

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

  const possessive = isMain ? 'your' : `${viewer.name}'s`;
  const counts = status?.counts;

  const tiles: Array<{ id: Source; title: string; description: string; available: boolean; tag: string }> = [
    ...(isMain ? [] : [{
      id: 'same' as Source,
      title: 'Same as you',
      description: `Follows your choice, ${SOURCE_NAME[mainSource] ?? 'All'}, using only what ${viewer.name} has of their own.`,
      available: true,
      tag: 'Default',
    }]),
    {
      id: 'both',
      title: 'All',
      description: 'Every history this profile has, each title counted once.',
      available: true,
      tag: 'Recommended',
    },
    {
      id: 'simkl',
      title: 'Simkl',
      description: hasSimkl ? 'Ratings and finished shows from the Simkl account.'
        : isMain ? 'Connect Simkl in Integrations to read it here.' : `Link a Simkl account to ${viewer.name} in Jellyfin profiles.`,
      available: hasSimkl,
      tag: hasSimkl ? 'Connected' : 'Not connected',
    },
    {
      id: 'mdblist',
      title: 'MDBList',
      description: hasMdblist ? 'Watch history from the MDBList key.'
        : isMain ? 'Add an MDBList key in Integrations to read it here.' : `Link an MDBList key to ${viewer.name} in Jellyfin profiles.`,
      available: hasMdblist,
      tag: hasMdblist ? 'Connected' : 'Not connected',
    },
    {
      id: 'local',
      title: 'Jellyfin history',
      description: 'Everything the Jellyfin server holds as watched, including what trackers synced in.',
      available: true,
      tag: 'Always available',
    },
  ];

  const share = (value?: number) => (counts?.total ? `${Math.round(((value ?? 0) / counts.total) * 100)}%` : '0%');
  const split = [
    { label: 'Films', value: counts?.movies, bar: 'bg-sky-400' },
    { label: 'Series', value: counts?.series, bar: 'bg-emerald-400' },
    { label: 'Anime', value: counts?.anime, bar: 'bg-violet-400' },
  ];

  const selected = tiles.find(tile => tile.id === source);
  const missing = tiles.filter(tile => !tile.available).map(tile => tile.title);

  return (
    <Dialog open={isOpen} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="@container h-[100dvh] max-h-[100dvh] w-screen max-w-none gap-0 overflow-hidden rounded-none border-0 p-0 shadow-none sm:h-[92vh] sm:max-h-[92vh] sm:w-[min(96vw,120rem)] sm:rounded-2xl sm:border sm:p-0 sm:shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
        <div className="flex h-full min-h-0 flex-col @3xl:flex-row">
        <aside className="flex shrink-0 flex-col gap-3 border-b border-white/[0.08] bg-black/20 px-4 py-4 @3xl:w-72 @3xl:border-b-0 @3xl:border-r @3xl:px-3 @3xl:py-5">
          <DialogHeader className="space-y-0 px-1 text-left @3xl:px-2 @3xl:pb-3">
            <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
              <Sparkles className="h-5 w-5" />
              Recommendations
            </DialogTitle>
            <DialogDescription className="sr-only">
              Rows picked for each person from what they have watched.
            </DialogDescription>
          </DialogHeader>
          <span className={`${EYEBROW} hidden px-3 text-muted-foreground @3xl:block`}>Profiles</span>
          <div role="group" aria-label="Profiles" className="-mx-1 flex gap-1 overflow-x-auto px-1 @3xl:mx-0 @3xl:flex-col @3xl:overflow-visible @3xl:px-0">
            {viewers.map((entry, index) => {
              const on = entry.id === viewer.id;
              return (
                <button key={entry.id ?? 'main'} type="button" onClick={() => setViewing(entry.id)} aria-pressed={on}
                  className={`flex shrink-0 items-center gap-3 rounded-xl p-2 pr-4 text-left transition-colors @3xl:pr-2 ${
                    on ? 'bg-white/[0.06] shadow-[inset_2px_0_0_theme(colors.sky.400)]' : 'hover:bg-white/[0.03]'
                  }`}>
                  <Avatar viewer={entry} index={index} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-semibold text-foreground">{entry.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{entry.note}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <p className="hidden px-3 pt-2 text-xs leading-relaxed text-muted-foreground @3xl:mt-auto @3xl:block">
            Profiles that share your history use your rows. The settings under How it is built apply to every profile.
          </p>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex flex-col gap-0.5 border-b border-white/[0.08] px-5 py-4 pr-14 @3xl:px-7">
            <h2 className="text-xl font-semibold">{viewer.name}</h2>
            <p className="text-sm text-muted-foreground">
              {viewer.note}
              {status?.sources ? ` · reads ${SOURCE_NAME[status.sources] ?? status.sources}` : ''}
              {status?.provider?.model ? ` · written by ${status.provider.model}` : ''}
            </p>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 @3xl:px-7">
            <div className="space-y-8">
              {!ready && (
                <div className={`${PANEL} flex items-start gap-4 border-amber-400/20 bg-amber-500/[0.06] p-5`}>
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/20">
                    <Wand2 className="h-5 w-5" />
                  </span>
                  <div className="space-y-1.5">
                    <p className="font-semibold">{loadingStatus ? `Reading ${possessive} history…` : 'Two things are needed first'}</p>
                    {!loadingStatus && (
                      <p className="text-sm text-muted-foreground">
                        {!hasHistory && (isMain
                          ? 'Connect Simkl, add an MDBList key, or watch something through Jellyfin so there is a watch history to read. '
                          : `${viewer.name} has nothing watched yet. Their rows come from their own Jellyfin history and any tracker linked to them. `)}
                        {!hasModel && 'Add a Gemini or OpenRouter key so there is a model to read it with.'}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {ready && (
                <section aria-label="Taste profile" className="grid gap-7 @4xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
                  <div className="space-y-2.5">
                    <span className={`${EYEBROW} text-sky-300`}>Taste profile</span>
                    <p className="text-base leading-relaxed text-foreground/90 @3xl:text-lg">
                      {loadingStatus ? `Reading ${possessive} history…`
                        : status?.profile?.summary
                          || `Not written yet. It is worked out the first time ${isMain ? 'you open' : `${viewer.name} opens`} a row, or when you build one below.`}
                    </p>
                    {status?.profile?.builtAt && (
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Clock className="h-3.5 w-3.5" />
                        Written {new Date(status.profile.builtAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                        {status.profile.builtFrom ? ` from ${status.profile.builtFrom} titles` : ''}
                      </p>
                    )}
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-baseline gap-2">
                      <span className="text-4xl font-bold tabular-nums tracking-tight">{counts?.total ?? '-'}</span>
                      <span className="text-sm text-muted-foreground">titles read</span>
                    </div>
                    <div className="flex h-1.5 overflow-hidden rounded-full bg-white/[0.06]" aria-hidden="true">
                      {split.map(part => (
                        <div key={part.label} className={part.bar} style={{ width: share(part.value) }} />
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                      {split.map(part => (
                        <span key={part.label} className="flex items-center gap-1.5">
                          <span className={`h-2 w-2 rounded-full ${part.bar}`} aria-hidden="true" />
                          <span className="font-semibold tabular-nums text-foreground">{part.value ?? '-'}</span>
                          {part.label.toLowerCase()}
                        </span>
                      ))}
                    </div>
                  </div>
                </section>
              )}

              <section aria-label="Reads from" className="space-y-2.5">
                <h3 className="text-sm font-semibold">Reads from</h3>
                <div className={TRAY}>
                  {tiles.map(tile => (
                    <button key={tile.id} type="button" disabled={!tile.available} aria-pressed={source === tile.id}
                      title={tile.description}
                      onClick={() => tile.available && pickSource(tile.id)}
                      className={`${segment(source === tile.id)} disabled:cursor-not-allowed disabled:opacity-40`}>
                      {tile.title}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {selected?.description}
                  {missing.length > 0 && !isMain ? ` ${missing.join(' and ')} can be linked to ${viewer.name} in Jellyfin profiles.` : ''}
                </p>
              </section>

              <section aria-label="How it is built" className="space-y-4">
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold">How it is built</h3>
                  <p className="text-xs text-muted-foreground">
                    Shared by every profile. A profile is written rarely and reused for a week, so a
                    stronger model here costs very little.
                  </p>
                </div>
                <div className="max-w-3xl space-y-4">
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
                              <SelectItem value="none">Off</SelectItem>
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
                        ) : thinking === 'none' ? (
                          <Callout variant="info" className="text-xs">
                            A few models cannot turn thinking off and will refuse the request. If that
                            happens, pick the lowest level instead.
                          </Callout>
                        ) : undefined}
                      />
                    )}

                    <div className="space-y-2 border-t border-white/[0.06] pt-5">
                      <Label className="text-sm font-medium">Order</Label>
                      <div className={TRAY}>
                        {([
                          ['suggested', 'As suggested'],
                          ['popular', 'Most watched'],
                          ['balanced', 'Well liked'],
                          ['acclaimed', 'Highest rated'],
                        ] as const).map(([id, label]) => (
                          <button key={id} type="button" onClick={() => patch({ order: id })}
                            aria-pressed={order === id} className={segment(order === id)}>
                            {label}
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {order === 'suggested'
                          ? 'Best fit first, as the model scored them. Nothing is weighed by how well a title was received, so a row can open on titles few people rated highly.'
                          : order === 'popular'
                            ? 'Biggest audience first. Easy to browse, though it buries the unfamiliar picks the profile worked to find.'
                            : order === 'balanced'
                              ? 'Rating weighted by audience, so a title needs both to lead the row.'
                              : 'Highest rated first, whether ten thousand people have seen it or two hundred.'}
                        {' '}Rearranging is free; it does not rebuild the row.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label className="text-sm font-medium">Write new rows</Label>
                      <div className={TRAY}>
                        {([[6, 'Every 6 hours'], [12, 'Every 12 hours'], [24, 'Once a day']] as const).map(([id, label]) => (
                          <button key={id} type="button" onClick={() => patch({ refresh_hours: id })}
                            aria-pressed={refreshHours === id} className={segment(refreshHours === id)}>
                            {label}
                          </button>
                        ))}
                        <button type="button" onClick={() => patch({ refresh_hours: refreshCustom ? refreshHours : 48 })}
                          aria-pressed={refreshCustom} className={segment(refreshCustom)}>
                          Custom
                        </button>
                      </div>
                      {refreshCustom && (
                        <div className="flex items-center gap-2">
                          <Input
                            id="recommendation-refresh-hours"
                            type="number"
                            min={1}
                            className="w-28"
                            value={refreshHours}
                            onChange={(e) => {
                              const next = Math.round(Number(e.target.value));
                              if (Number.isFinite(next) && next > 0) patch({ refresh_hours: next });
                            }}
                          />
                          <span className="text-xs text-muted-foreground">hours between rewrites</span>
                        </div>
                      )}
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
                </div>
              </section>

              <section aria-label="Rows" className="space-y-3 border-t border-white/[0.06] pt-7">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold">Rows</h3>
                  <span className="text-xs text-muted-foreground">Added once for everyone, filled for each profile</span>
                </div>
                <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-3">
                  {OFFERED.map(({ id, name, icon: Icon, blurb }) => {
                    const job = current[id];
                    const working = !!job && job.stage !== 'done' && job.stage !== 'error';
                    const failed = job?.stage === 'error';
                    const built = job?.stage === 'done';
                    const inList = added.has(id);
                    return (
                      <div key={id} className={`${PANEL} flex flex-col gap-3 p-4`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-2 font-semibold">
                            <Icon className="h-4 w-4 text-sky-300" />
                            {name}
                          </span>
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            failed ? 'bg-amber-500/10 text-amber-300'
                              : built ? 'bg-emerald-500/10 text-emerald-300'
                              : working ? 'bg-sky-500/10 text-sky-300'
                              : inList ? 'bg-white/[0.06] text-foreground/80'
                              : 'bg-white/[0.04] text-muted-foreground'
                          }`}>
                            {failed ? 'Failed' : built ? `${job.picks} picks` : working ? 'Building' : inList ? 'In your list' : 'Not added'}
                          </span>
                        </div>
                        <p className={`text-xs ${failed ? 'text-amber-300' : 'text-muted-foreground'}`}>
                          {failed ? (job.error || 'Failed') : built ? (inList ? 'Rebuilt.' : 'Ready to add below.') : working ? STAGE_LABEL[job.stage] : blurb}
                        </p>
                        {working ? (
                          <div className="mt-auto flex h-9 items-center">
                            <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
                              <div className="h-full rounded-full bg-sky-400 transition-all" style={{ width: `${STAGE_PROGRESS[job.stage]}%` }} />
                            </div>
                          </div>
                        ) : (
                          <Button variant="outline" size="sm" className="mt-auto h-9" disabled={!ready} onClick={() => generate(id, built || inList)}>
                            {failed ? <TriangleAlert className="mr-1.5 h-4 w-4" />
                              : built || inList ? <Check className="mr-1.5 h-4 w-4" />
                              : <Plus className="mr-1.5 h-4 w-4" />}
                            {built || inList ? (isMain ? 'Rebuild' : `Rebuild for ${viewer.name}`) : (isMain ? 'Build' : `Build for ${viewer.name}`)}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          </div>

          <footer className="flex flex-col gap-3 border-t border-white/[0.08] bg-background/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-sm @2xl:flex-row @2xl:items-center @2xl:justify-end @2xl:bg-transparent @2xl:px-7 @2xl:py-4 @2xl:backdrop-blur-none">
            <p className="text-xs text-muted-foreground @2xl:mr-auto">
              {anyRunning
                ? 'Building. Nothing can be applied until it finishes.'
                : readyToAdd.length
                  ? 'Built and ready. Applying puts the rows in your catalog list.'
                  : dirty
                    ? 'Building uses these settings whether or not they are applied.'
                    : 'Applied changes still need the configuration saved to reach your clients.'}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose}>Close</Button>
              <Button className="shrink-0" disabled={!pending} onClick={apply}>
                {readyToAdd.length
                  ? <><Plus className="mr-1.5 h-4 w-4" />
                    {readyToAdd.length > 1 ? `Add ${readyToAdd.length} catalogs` : `Add ${readyToAdd[0].name}`}</>
                  : 'Apply settings'}
              </Button>
            </div>
          </footer>
        </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
