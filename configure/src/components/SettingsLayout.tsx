import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentType, type LazyExoticComponent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronLeft, ChevronRight,
  Sparkles, SlidersHorizontal, KeyRound, Film, Paintbrush,
  Filter, Search, LayoutGrid, Settings2,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useBreakpoint } from '@/hooks/use-breakpoint';
import { cn } from '@/lib/utils';

const LazyPresetManager = lazy(() =>
  import('./sections/PresetManager').then((module) => ({ default: module.PresetManager }))
);
const LazyGeneralSettings = lazy(() =>
  import('./sections/GeneralSettings').then((module) => ({ default: module.GeneralSettings }))
);
const LazyIntegrationsSettings = lazy(() =>
  import('./sections/IntegrationsSettings').then((module) => ({ default: module.IntegrationsSettings }))
);
const LazyProvidersSettings = lazy(() =>
  import('./sections/ProvidersSettings').then((module) => ({ default: module.ProvidersSettings }))
);
const LazyArtProviderSettings = lazy(() =>
  import('./sections/ArtProviderSettings').then((module) => ({ default: module.ArtProviderSettings }))
);
const LazyFiltersSettings = lazy(() =>
  import('./sections/FiltersSettings').then((module) => ({ default: module.FiltersSettings }))
);
const LazyCatalogsSettings = lazy(() =>
  import('./sections/CatalogsSettings').then((module) => ({ default: module.CatalogsSettings }))
);
const LazySearchSettings = lazy(() =>
  import('./sections/SearchSettings').then((module) => ({ default: module.SearchSettings }))
);
const LazyConfigurationManager = lazy(() =>
  import('./ConfigurationManager').then((module) => ({ default: module.ConfigurationManager }))
);
const LazyDashboard = lazy(() =>
  import('./dashboard/Dashboard').then((module) => ({ default: module.Dashboard }))
);
const LazyRatingPage = lazy(() => import('./RatingPage'));

const settingsPages = [
  { value: 'presets', title: 'Presets', Component: LazyPresetManager, icon: Sparkles },
  { value: 'general', title: 'General', Component: LazyGeneralSettings, icon: SlidersHorizontal },
  { value: 'integrations', title: 'Integrations', Component: LazyIntegrationsSettings, icon: KeyRound },
  { value: 'providers', title: 'Meta Providers', Component: LazyProvidersSettings, icon: Film },
  { value: 'art-providers', title: 'Art Providers', Component: LazyArtProviderSettings, icon: Paintbrush },
  { value: 'filters', title: 'Filters', Component: LazyFiltersSettings, icon: Filter },
  { value: 'search', title: 'Search', Component: LazySearchSettings, icon: Search },
  { value: 'catalogs', title: 'Catalogs', Component: LazyCatalogsSettings, icon: LayoutGrid },
  { value: 'configuration', title: 'Configuration', Component: LazyConfigurationManager, icon: Settings2 },
] as const;
type SettingsPageValue = (typeof settingsPages)[number]['value'];
const SETTINGS_LAYOUT_NAVIGATE_EVENT = 'settings-layout:navigate';

function SectionFallback({ title }: { title: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-5 space-y-3">
      <div className="text-sm font-medium text-muted-foreground">Loading {title.toLowerCase()}...</div>
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

function renderPage(page: (typeof settingsPages)[number]) {
  const PageComponent = page.Component as LazyExoticComponent<ComponentType>;
  return (
    <Suspense fallback={<SectionFallback title={page.title} />}>
      <PageComponent />
    </Suspense>
  );
}

export function SettingsLayout() {
  const { isMobile } = useBreakpoint();
  const [activeSection, setActiveSection] = useState<SettingsPageValue>('presets');
  const [activeMobileSection, setActiveMobileSection] = useState<SettingsPageValue | undefined>(undefined);
  const isScrollingRef = useRef(false);

  const scrollToSection = useCallback((value: string) => {
    isScrollingRef.current = true;
    setActiveSection(value as SettingsPageValue);
    const el = document.getElementById(value);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setTimeout(() => { isScrollingRef.current = false; }, 800);
  }, []);

  useEffect(() => {
    if (isMobile) return;
    const handleScroll = () => {
      if (isScrollingRef.current) return;
      const offset = 120;
      let current: SettingsPageValue = settingsPages[0].value;
      for (const page of settingsPages) {
        const el = document.getElementById(page.value);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.top <= offset) {
            current = page.value;
          }
        }
      }
      setActiveSection(current);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, [isMobile]);

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const customEvent = event as CustomEvent<{ tab?: string; scrollToTop?: boolean }>;
      const nextTab = customEvent.detail?.tab;
      if (!nextTab) return;
      const isKnown = settingsPages.some((page) => page.value === nextTab);
      if (!isKnown) return;

      if (isMobile) {
        setActiveMobileSection(nextTab as SettingsPageValue);
        window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'auto' }));
      } else {
        scrollToSection(nextTab);
      }
    };
    window.addEventListener(SETTINGS_LAYOUT_NAVIGATE_EVENT, handleNavigate as EventListener);
    return () => window.removeEventListener(SETTINGS_LAYOUT_NAVIGATE_EVENT, handleNavigate as EventListener);
  }, [isMobile, scrollToSection]);

  const windowFlags = typeof window !== 'undefined'
    ? (window as Window & { DASHBOARD_MODE?: boolean; RATING_MODE?: boolean })
    : undefined;
  const isDashboardMode = !!windowFlags?.DASHBOARD_MODE;
  const isRatingMode = !!windowFlags?.RATING_MODE;

  if (isRatingMode) {
    return (
      <div className="w-full">
        <Suspense fallback={<SectionFallback title="rating" />}>
          <LazyRatingPage />
        </Suspense>
      </div>
    );
  }

  if (isDashboardMode) {
    return (
      <div className="w-full">
        <Suspense fallback={<SectionFallback title="dashboard" />}>
          <LazyDashboard />
        </Suspense>
      </div>
    );
  }

  // --- MOBILE: push-pop navigation ---
  if (isMobile) {
    const activePage = settingsPages.find(p => p.value === activeMobileSection);
    const activePageIndex = activeMobileSection
      ? settingsPages.findIndex(p => p.value === activeMobileSection)
      : -1;
    const prevPage = activePageIndex > 0 ? settingsPages[activePageIndex - 1] : null;
    const nextPage = activePageIndex >= 0 && activePageIndex < settingsPages.length - 1
      ? settingsPages[activePageIndex + 1]
      : null;
    const goToSection = (value: SettingsPageValue) => {
      setActiveMobileSection(value);
      window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'auto' }));
    };

    return (
      <div className="w-full overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          {!activeMobileSection ? (
            <motion.div
              key="menu"
              initial={{ opacity: 0, x: -60 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -60 }}
              transition={{ type: "tween", duration: 0.2, ease: "easeOut" }}
              className="space-y-1"
            >
              <div className="rounded-xl border border-white/[0.06] bg-card/80 backdrop-blur-sm overflow-hidden">
                {settingsPages.map((page, index) => {
                  const Icon = page.icon;
                  return (
                    <button
                      key={page.value}
                      onClick={() => setActiveMobileSection(page.value)}
                      className={`flex items-center justify-between w-full px-4 py-3.5 text-left transition-colors active:bg-white/[0.04] ${
                        index < settingsPages.length - 1 ? 'border-b border-white/[0.04]' : ''
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <Icon className="h-4 w-4 text-muted-foreground" />
                        <span className="text-[15px] font-medium text-foreground">{page.title}</span>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
                    </button>
                  );
                })}
              </div>

              <div className="flex justify-center pt-6">
                <button
                  onClick={() => window.open('https://buymeacoffee.com/cedya', '_blank')}
                  aria-label="Buy me a coffee"
                  className="inline-block"
                >
                  <img
                    src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png"
                    alt="Buy Me A Coffee"
                    className="h-12 w-auto hover:opacity-90 transition-opacity"
                  />
                </button>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key={activeMobileSection}
              initial={{ opacity: 0, x: 60 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 60 }}
              transition={{ type: "tween", duration: 0.2, ease: "easeOut" }}
            >
              <button
                onClick={() => setActiveMobileSection(undefined)}
                className="flex items-center gap-1 mb-4 -ml-1 py-1.5 px-2 rounded-lg text-muted-foreground active:bg-white/[0.04] transition-colors"
              >
                <ChevronLeft className="h-4 w-4" />
                <span className="text-sm font-medium">Settings</span>
              </button>
              <h2 className="text-xl font-semibold mb-4">{activePage?.title}</h2>
              {activePage && renderPage(activePage)}

              <div className="mt-8 flex items-stretch gap-2">
                <button
                  onClick={() => prevPage && goToSection(prevPage.value)}
                  disabled={!prevPage}
                  className="flex-1 min-w-0 flex items-center gap-2 rounded-xl border border-white/[0.06] bg-card/80 backdrop-blur-sm px-3 py-3 text-left transition-colors active:bg-white/[0.04] disabled:opacity-40 disabled:active:bg-transparent"
                  aria-label={prevPage ? `Previous: ${prevPage.title}` : 'No previous section'}
                >
                  <ChevronLeft className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground/70">Previous</div>
                    <div className="truncate text-sm font-medium text-foreground">{prevPage?.title ?? '—'}</div>
                  </div>
                </button>
                <button
                  onClick={() => nextPage && goToSection(nextPage.value)}
                  disabled={!nextPage}
                  className="flex-1 min-w-0 flex items-center gap-2 rounded-xl border border-white/[0.06] bg-card/80 backdrop-blur-sm px-3 py-3 text-right transition-colors active:bg-white/[0.04] disabled:opacity-40 disabled:active:bg-transparent"
                  aria-label={nextPage ? `Next: ${nextPage.title}` : 'No next section'}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground/70">Next</div>
                    <div className="truncate text-sm font-medium text-foreground">{nextPage?.title ?? '—'}</div>
                  </div>
                  <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  // --- DESKTOP: sidebar + scroll-spy ---
  return (
    <div className="w-full flex gap-10">
      <aside className="w-52 shrink-0">
        <nav className="sticky top-6 space-y-1 py-2">
          {settingsPages.map((page) => {
            const Icon = page.icon;
            const isActive = activeSection === page.value;
            return (
              <button
                key={page.value}
                onClick={() => scrollToSection(page.value)}
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
                <span className="relative z-10 font-medium">{page.title}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="flex-1 min-w-0 space-y-12 pb-32">
        {settingsPages.map((page, index) => (
          <section
            key={page.value}
            id={page.value}
            className={cn(
              "scroll-mt-6",
              index < settingsPages.length - 1 && "border-b border-white/[0.06] pb-12"
            )}
          >
            {renderPage(page)}
          </section>
        ))}
      </main>
    </div>
  );
}
