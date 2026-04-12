import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentType, type LazyExoticComponent } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
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

  // --- RENDER ACCORDION ON MOBILE ---
  if (isMobile) {
    return (
      <div ref={layoutRootRef} className="w-full space-y-6">
        <Accordion
          type="single"
          collapsible
          className="w-full"
          value={activeMobileSection}
          onValueChange={(value) => setActiveMobileSection(value ? (value as SettingsPageValue) : undefined)}
        >
          {settingsPages.map((page, index) => (
            <AccordionItem 
              value={page.value} 
              key={page.value}
              // FIX: Use theme-aware border
              className={index === settingsPages.length - 1 ? "border-b-0" : "border-b"}
            >
              <AccordionTrigger className="text-lg font-medium hover:no-underline py-4">
                {page.title}
              </AccordionTrigger>
              <AccordionContent className="pt-2 pb-6">
                {activeMobileSection === page.value ? renderSettingsPage(page) : null}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
        
        {/* Buy Me a Coffee Button */}
        <div className="flex justify-center pt-4">
          <button
            onClick={() => {
              window.open('https://buymeacoffee.com/cedya', '_blank');
            }}
            aria-label="Buy me a coffee"
            title="Buy me a coffee"
            className="inline-block"
          >
            <img
              src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png"
              alt="Buy Me A Coffee"
              className="h-12 w-auto hover:opacity-90 transition-opacity"
            />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={layoutRootRef} className="w-full">
      <Tabs
        value={activeDesktopTab}
        onValueChange={(value) => setActiveDesktopTab(value as SettingsPageValue)}
        className="w-full"
      >
        <TabsList className="inline-flex h-10 items-center justify-center rounded-md p-1 text-muted-foreground w-full gap-x-2 bg-muted">
          {settingsPages.map((page) => (
            <TabsTrigger 
              key={page.value} 
              value={page.value} 
              className="inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
            >
              {page.title}
            </TabsTrigger>
          ))}
        </TabsList>
      {settingsPages.map((page) => (
        <TabsContent key={page.value} value={page.value} className="mt-6 animate-fade-in">
          {activeDesktopTab === page.value ? renderSettingsPage(page) : null}
        </TabsContent>
      ))}
      </Tabs>
    </div>
  );
}
