import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentType, type LazyExoticComponent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useBreakpoint } from '@/hooks/use-breakpoint';

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
  import('./Dashboard').then((module) => ({ default: module.Dashboard }))
);
const LazyRatingPage = lazy(() => import('./RatingPage'));

const settingsPages = [
  { value: 'presets', title: 'Presets', Component: LazyPresetManager },
  { value: 'general', title: 'General', Component: LazyGeneralSettings },
  { value: 'integrations', title: 'Integrations', Component: LazyIntegrationsSettings },
  { value: 'providers', title: 'Meta Providers', Component: LazyProvidersSettings },
  { value: 'art-providers', title: 'Art Providers', Component: LazyArtProviderSettings },
  { value: 'filters', title: 'Filters', Component: LazyFiltersSettings },
  { value: 'search', title: 'Search', Component: LazySearchSettings },
  { value: 'catalogs', title: 'Catalogs', Component: LazyCatalogsSettings },
  { value: 'configuration', title: 'Configuration', Component: LazyConfigurationManager },
] as const;
type SettingsPageValue = (typeof settingsPages)[number]['value'];
type SettingsPage = (typeof settingsPages)[number];
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

function renderSettingsPage(page: SettingsPage) {
  const ActiveComponent = page.Component as LazyExoticComponent<ComponentType>;

  return (
    <Suspense fallback={<SectionFallback title={page.title} />}>
      <ActiveComponent />
    </Suspense>
  );
}

/**
 * A responsive layout component that displays settings in Tabs on desktop
 * and in an Accordion on mobile devices.
 */
export function SettingsLayout() {
  // Use our custom hook to determine if we're on a mobile-sized screen.
  const { isMobile } = useBreakpoint();
  const [activeDesktopTab, setActiveDesktopTab] = useState<SettingsPageValue>('presets');
  const [activeMobileSection, setActiveMobileSection] = useState<SettingsPageValue | undefined>(undefined);
  const layoutRootRef = useRef<HTMLDivElement | null>(null);
  const slideDirection = useRef(0);
  const prevTabIndex = useRef(0);

  const handleTabChange = useCallback((value: string) => {
    const newIndex = settingsPages.findIndex(p => p.value === value);
    slideDirection.current = newIndex > prevTabIndex.current ? 1 : -1;
    prevTabIndex.current = newIndex;
    setActiveDesktopTab(value as SettingsPageValue);
  }, []);

  const scrollLayoutToTop = useCallback(() => {
    if (layoutRootRef.current) {
      layoutRootRef.current.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, []);

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const customEvent = event as CustomEvent<{ tab?: SettingsPageValue; scrollToTop?: boolean }>;
      const nextTab = customEvent.detail?.tab;
      if (!nextTab) return;

      const isKnownTab = settingsPages.some((page) => page.value === nextTab);
      if (!isKnownTab) return;

      const newIndex = settingsPages.findIndex(p => p.value === nextTab);
      slideDirection.current = newIndex > prevTabIndex.current ? 1 : -1;
      prevTabIndex.current = newIndex;
      setActiveDesktopTab(nextTab);
      setActiveMobileSection(nextTab);

      if (!isMobile && customEvent.detail?.scrollToTop !== false) {
        window.requestAnimationFrame(() => {
          scrollLayoutToTop();
          window.setTimeout(scrollLayoutToTop, 120);
        });
      }
    };

    window.addEventListener(SETTINGS_LAYOUT_NAVIGATE_EVENT, handleNavigate as EventListener);
    return () => {
      window.removeEventListener(SETTINGS_LAYOUT_NAVIGATE_EVENT, handleNavigate as EventListener);
    };
  }, [isMobile, scrollLayoutToTop]);
  
  // Check if we're in dashboard mode FIRST (before mobile check)
  const windowFlags = typeof window !== 'undefined'
    ? (window as Window & { DASHBOARD_MODE?: boolean; RATING_MODE?: boolean })
    : undefined;
  const isDashboardMode = !!windowFlags?.DASHBOARD_MODE;
  const isRatingMode = !!windowFlags?.RATING_MODE;

  // If in dashboard mode, show only the dashboard (regardless of mobile/desktop)
  if (isRatingMode) {
    return (
      <div className="w-full">
        <Suspense fallback={<SectionFallback title="rating" />}>
          <LazyRatingPage />
        </Suspense>
      </div>
    );
  }

  // If in dashboard mode, show only the dashboard (regardless of mobile/desktop)
  if (isDashboardMode) {
    return (
      <div className="w-full">
        <Suspense fallback={<SectionFallback title="dashboard" />}>
          <LazyDashboard />
        </Suspense>
      </div>
    );
  }

  // --- RENDER PUSH-POP NAVIGATION ON MOBILE ---
  if (isMobile) {
    const activePage = settingsPages.find(p => p.value === activeMobileSection);

    return (
      <div ref={layoutRootRef} className="w-full overflow-hidden">
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
                {settingsPages.map((page, index) => (
                  <button
                    key={page.value}
                    onClick={() => setActiveMobileSection(page.value)}
                    className={`flex items-center justify-between w-full px-4 py-3.5 text-left transition-colors active:bg-white/[0.04] ${
                      index < settingsPages.length - 1 ? 'border-b border-white/[0.04]' : ''
                    }`}
                  >
                    <span className="text-[15px] font-medium text-foreground">{page.title}</span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
                  </button>
                ))}
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
              {activePage && renderSettingsPage(activePage)}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div ref={layoutRootRef} className="w-full">
      <Tabs
        value={activeDesktopTab}
        onValueChange={handleTabChange}
        className="w-full"
      >
        <TabsList className="relative inline-flex h-12 items-center justify-center rounded-full p-1 text-muted-foreground w-full bg-muted/70 shadow-[inset_0_1px_4px_rgba(0,0,0,0.2),inset_0_0_1px_rgba(0,0,0,0.15)] border border-white/[0.04]">
          {settingsPages.map((page) => (
            <TabsTrigger
              key={page.value}
              value={page.value}
              className="relative z-10 inline-flex items-center justify-center whitespace-nowrap px-4 py-2 text-[15px] rounded-full bg-transparent transition-all duration-200 text-muted-foreground/70 hover:text-muted-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:font-semibold data-[state=active]:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {activeDesktopTab === page.value && (
                <motion.div
                  layoutId="activeTabPill"
                  className="absolute inset-0 rounded-full bg-[hsl(240_6%_12%)] shadow-[0_1px_3px_rgba(0,0,0,0.3),0_1px_1px_rgba(0,0,0,0.2)] border border-white/[0.06]"
                  transition={{ type: "spring", stiffness: 500, damping: 32 }}
                />
              )}
              <span className="relative z-10">{page.title}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="mt-4 rounded-2xl border border-white/[0.06] bg-card/60 backdrop-blur-sm p-6 overflow-hidden">
          <AnimatePresence mode="wait" initial={false} custom={slideDirection.current}>
            <motion.div
              key={activeDesktopTab}
              custom={slideDirection.current}
              variants={{
                enter: (dir: number) => ({ opacity: 0, x: dir * 40 }),
                center: { opacity: 1, x: 0 },
                exit: (dir: number) => ({ opacity: 0, x: dir * -40 }),
              }}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ type: "tween", duration: 0.15, ease: "easeOut" }}
            >
              {renderSettingsPage(settingsPages.find(p => p.value === activeDesktopTab)!)}
            </motion.div>
          </AnimatePresence>
        </div>
      </Tabs>
    </div>
  );
}
