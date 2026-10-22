import { lazy, Suspense, useEffect, useRef, useState, type ComponentType, type LazyExoticComponent } from "react";
import { motion } from "framer-motion";
import {
  ChevronLeft, ChevronRight,
  Sparkles, SlidersHorizontal, KeyRound, Film, Paintbrush,
  Filter, Search, LayoutGrid, Settings2,
} from "lucide-react";
import { SectionSkeleton } from '@/components/settings/SectionSkeleton';
import { SectionErrorBoundary } from '@/components/settings/SectionErrorBoundary';
import { SECTION_SKELETONS, GENERIC_SKELETON } from '@/lib/sectionSkeletons';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useBreakpoint } from '@/hooks/use-breakpoint';
import { useSettingsRoute } from '@/hooks/useSettingsRoute';
import { useAnchorFocus } from '@/hooks/useAnchorFocus';
import { SettingsSearch } from '@/components/settings/SettingsSearch';
import { useConfig } from '@/contexts/ConfigContext';
import { MobileSaveBar } from '@/components/layout/MobileSaveBar';
import { SidebarSaveButton } from '@/components/layout/SidebarSaveButton';
import { SupportLink } from '@/components/layout/SupportLink';
import {
  SETTINGS_SECTIONS,
  adjacentSections,
  hasExplicitSection,
  hashFor,
  isExistingConfigUrl,
  isSettingsSectionId,
  parseRoute,
  type SettingsSectionId,
} from '@/lib/settingsRoute';
import { cn } from '@/lib/utils';

const SECTION_IMPORTS: Record<SettingsSectionId, () => Promise<{ default: ComponentType }>> = {
  'presets': () => import('./setup/SetupPage').then((m) => ({ default: m.SetupPage as ComponentType })),
  'general': () => import('./sections/GeneralSettings').then((m) => ({ default: m.GeneralSettings as ComponentType })),
  'integrations': () => import('./sections/IntegrationsSettings').then((m) => ({ default: m.IntegrationsSettings as ComponentType })),
  'providers': () => import('./sections/ProvidersSettings').then((m) => ({ default: m.ProvidersSettings as ComponentType })),
  'art-providers': () => import('./sections/ArtProviderSettings').then((m) => ({ default: m.ArtProviderSettings as ComponentType })),
  'filters': () => import('./sections/FiltersSettings').then((m) => ({ default: m.FiltersSettings as ComponentType })),
  'search': () => import('./sections/SearchSettings').then((m) => ({ default: m.SearchSettings as ComponentType })),
  'catalogs': () => import('./sections/CatalogsSettings').then((m) => ({ default: m.CatalogsSettings as ComponentType })),
  'configuration': () => import('./ConfigurationManager').then((m) => ({ default: m.ConfigurationManager as ComponentType })),
};

function preloadSection(id: SettingsSectionId): void {
  void SECTION_IMPORTS[id]().catch(() => {});
}

const LazyDashboard = lazy(() =>
  import('./dashboard/Dashboard').then((module) => ({ default: module.Dashboard }))
);
const LazyRatingPage = lazy(() => import('./RatingPage'));
const LazySetupPage = lazy(() => import('./setup/SetupPage').then((m) => ({ default: m.SetupPage })));

const SETTINGS_LAYOUT_NAVIGATE_EVENT = 'settings-layout:navigate';

const SECTION_SCROLL_MARGIN = 24;

/** Joined to SETTINGS_SECTIONS by id — the route model cannot hold components. */
const SECTION_VIEWS: Record<SettingsSectionId, {
  Component: LazyExoticComponent<ComponentType>;
  icon: typeof Sparkles;
}> = {
  'presets': { Component: lazy(SECTION_IMPORTS['presets']), icon: Sparkles },
  'general': { Component: lazy(SECTION_IMPORTS['general']), icon: SlidersHorizontal },
  'integrations': { Component: lazy(SECTION_IMPORTS['integrations']), icon: KeyRound },
  'providers': { Component: lazy(SECTION_IMPORTS['providers']), icon: Film },
  'art-providers': { Component: lazy(SECTION_IMPORTS['art-providers']), icon: Paintbrush },
  'filters': { Component: lazy(SECTION_IMPORTS['filters']), icon: Filter },
  'search': { Component: lazy(SECTION_IMPORTS['search']), icon: Search },
  'catalogs': { Component: lazy(SECTION_IMPORTS['catalogs']), icon: LayoutGrid },
  'configuration': { Component: lazy(SECTION_IMPORTS['configuration']), icon: Settings2 },
};

export function SettingsLayout() {
  const { isMobile } = useBreakpoint();
  const { section, anchor, navigate, focusNonce, refocus } = useSettingsRoute();
  const { config } = useConfig();
  const [setupDismissed, setSetupDismissed] = useState(false);
  // Latched once the user applies, because that flips catalogSetupComplete and would
  // otherwise unmount the page they are still standing on.
  const [setupEngaged, setSetupEngaged] = useState(false);
  const eligibleForSetup =
    !hasExplicitSection(window.location.hash) && !isExistingConfigUrl(window.location.pathname);
  // Reads the flag live so a config arriving from sign-in dismisses the takeover.
  const isFirstRun =
    !setupDismissed && (setupEngaged || (eligibleForSetup && config.catalogSetupComplete === false));
  const isFirstRender = useRef(true);
  const mainRef = useRef<HTMLElement | null>(null);
  useAnchorFocus(anchor, focusNonce, mainRef);

  const handleSearchSelect = (target: SettingsSectionId, targetAnchor: string | null) => {
    navigate(target, targetAnchor);
    refocus();
  };

  useEffect(() => {
    // Writing a section into the URL during first run would make a refresh look like an
    // explicit request for that section, skipping setup.
    if (isFirstRun || (window as Window & { DASHBOARD_MODE?: boolean }).DASHBOARD_MODE) return;
    const route = parseRoute(window.location.hash);
    const canonical = hashFor(route.section, route.anchor);
    if (window.location.hash !== canonical) {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}${canonical}`
      );
    }
  }, [isFirstRun]);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (parseRoute(window.location.hash).anchor) return;
    const main = mainRef.current;
    const top = main
      ? Math.max(0, main.getBoundingClientRect().top + window.scrollY - SECTION_SCROLL_MARGIN)
      : 0;
    window.scrollTo({ top, behavior: 'auto' });
  }, [section]);

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const tab = (event as CustomEvent<{ tab?: string }>).detail?.tab;
      if (tab && isSettingsSectionId(tab)) navigate(tab);
    };
    window.addEventListener(SETTINGS_LAYOUT_NAVIGATE_EVENT, handleNavigate as EventListener);
    return () => window.removeEventListener(SETTINGS_LAYOUT_NAVIGATE_EVENT, handleNavigate as EventListener);
  }, [navigate]);

  const windowFlags = typeof window !== 'undefined'
    ? (window as Window & { DASHBOARD_MODE?: boolean; RATING_MODE?: boolean })
    : undefined;
  const isDashboardMode = !!windowFlags?.DASHBOARD_MODE;
  const isRatingMode = !!windowFlags?.RATING_MODE;

  if (isRatingMode) {
    const skeleton = <SectionSkeleton spec={GENERIC_SKELETON} label="ratings" />;
    return (
      <div className="w-full">
        <SectionErrorBoundary label="Ratings" fallback={skeleton}>
          <Suspense fallback={skeleton}>
            <LazyRatingPage />
          </Suspense>
        </SectionErrorBoundary>
      </div>
    );
  }

  if (isDashboardMode) {
    const skeleton = <SectionSkeleton spec={GENERIC_SKELETON} label="dashboard" />;
    return (
      <div className="w-full">
        <SectionErrorBoundary label="Dashboard" fallback={skeleton}>
          <Suspense fallback={skeleton}>
            <LazyDashboard />
          </Suspense>
        </SectionErrorBoundary>
      </div>
    );
  }

  if (isFirstRun) {
    const skeleton = <SectionSkeleton spec={SECTION_SKELETONS['presets'] ?? GENERIC_SKELETON} label="setup" />;
    return (
      <div className="w-full">
        <SectionErrorBoundary label="Setup" fallback={skeleton}>
          <Suspense fallback={skeleton}>
            <LazySetupPage
              variant="fullscreen"
              onApplied={() => setSetupEngaged(true)}
              onExit={(target) => { setSetupDismissed(true); navigate(target); }}
            />
          </Suspense>
        </SectionErrorBoundary>
      </div>
    );
  }

  const current = SETTINGS_SECTIONS.find(s => s.id === section)!;
  const { Component } = SECTION_VIEWS[section];
  const { prev, next } = adjacentSections(section);

  const sectionSkeleton = <SectionSkeleton spec={SECTION_SKELETONS[section]} label={current.title} />;

  const sectionContent = (
    <SectionErrorBoundary key={section} label={current.title} fallback={sectionSkeleton}>
      <Suspense fallback={sectionSkeleton}>
        <Component />
      </Suspense>
    </SectionErrorBoundary>
  );

  if (isMobile) {
    return (
      <div ref={(el) => { mainRef.current = el; }} className="w-full">
        <div className="mb-3">
          <SettingsSearch onSelect={handleSearchSelect} />
        </div>

        <div className="mb-4">
          <Select value={section} onValueChange={(value) => navigate(value as SettingsSectionId)}>
            <SelectTrigger aria-label="Settings section" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SETTINGS_SECTIONS.map(s => (
                <SelectItem key={s.id} value={s.id}>{s.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {sectionContent}

        <div className="mt-8 flex items-stretch gap-2">
          <button
            onClick={() => prev && navigate(prev.id)}
            disabled={!prev}
            className="flex-1 min-w-0 flex items-center gap-2 rounded-xl border border-white/[0.06] bg-card/80 backdrop-blur-sm px-3 py-3 text-left transition-colors active:bg-white/[0.04] disabled:opacity-40 disabled:active:bg-transparent"
            aria-label={prev ? `Previous: ${prev.title}` : 'No previous section'}
          >
            <ChevronLeft className="h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground/70">Previous</div>
              <div className="truncate text-sm font-medium text-foreground">{prev?.title ?? '—'}</div>
            </div>
          </button>
          <button
            onClick={() => next && navigate(next.id)}
            disabled={!next}
            className="flex-1 min-w-0 flex items-center gap-2 rounded-xl border border-white/[0.06] bg-card/80 backdrop-blur-sm px-3 py-3 text-right transition-colors active:bg-white/[0.04] disabled:opacity-40 disabled:active:bg-transparent"
            aria-label={next ? `Next: ${next.title}` : 'No next section'}
          >
            <div className="min-w-0 flex-1">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground/70">Next</div>
              <div className="truncate text-sm font-medium text-foreground">{next?.title ?? '—'}</div>
            </div>
            <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
          </button>
        </div>

        <SupportLink className="mt-6 w-full" />

        <MobileSaveBar />
      </div>
    );
  }

  return (
    <div className="w-full flex gap-10">
      <aside className="w-52 shrink-0">
        <nav className="sticky top-6 z-50 space-y-1 py-2" aria-label="Settings sections">
          <div className="mb-3">
            <SettingsSearch onSelect={handleSearchSelect} />
          </div>

          {SETTINGS_SECTIONS.map((s) => {
            const Icon = SECTION_VIEWS[s.id].icon;
            const isActive = section === s.id;
            return (
              <button
                key={s.id}
                onClick={() => navigate(s.id)}
                onPointerEnter={() => preloadSection(s.id)}
                onFocus={() => preloadSection(s.id)}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  "relative flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm transition-colors",
                  isActive
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                )}
              >
                {isActive && (
                  <motion.div
                    layoutId="activeSidebarItem"
                    className="absolute inset-0 rounded-lg bg-accent border border-white/[0.06]"
                    transition={{ type: "spring", stiffness: 400, damping: 28 }}
                  />
                )}
                <Icon className="relative z-10 h-4 w-4 shrink-0" />
                <span className="relative z-10 font-medium">{s.title}</span>
              </button>
            );
          })}

          <SidebarSaveButton />

          <SupportLink className="mt-3 w-full" />
        </nav>
      </aside>

      <main ref={mainRef} className="flex-1 min-w-0 pb-32">
        {sectionContent}
      </main>
    </div>
  );
}
