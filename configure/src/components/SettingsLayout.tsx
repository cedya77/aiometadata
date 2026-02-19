import { useCallback, useEffect, useRef, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { useBreakpoint } from '@/hooks/use-breakpoint';
import { cn } from "@/lib/utils";

import { GeneralSettings } from './sections/GeneralSettings';
import { IntegrationsSettings } from './sections/IntegrationsSettings';
import { ProvidersSettings } from './sections/ProvidersSettings';
import { ArtProviderSettings } from './sections/ArtProviderSettings';
import { FiltersSettings } from './sections/FiltersSettings';
import { CatalogsSettings } from './sections/CatalogsSettings';
import { SearchSettings } from './sections/SearchSettings';
import { PresetManager } from './sections/PresetManager';
import { ConfigurationManager } from './ConfigurationManager';
import { Dashboard } from './Dashboard';
import RatingPage from './RatingPage';

const settingsPages = [
  { value: 'presets', title: 'Presets', component: <PresetManager /> },
  { value: 'general', title: 'General', component: <GeneralSettings /> },
  { value: 'integrations', title: 'Integrations', component: <IntegrationsSettings /> },
  { value: 'providers', title: 'Meta Providers', component: <ProvidersSettings /> },
  { value: 'art-providers', title: 'Art Providers', component: <ArtProviderSettings /> },
  { value: 'filters', title: 'Filters', component: <FiltersSettings /> },
  { value: 'search', title: 'Search', component: <SearchSettings /> },
  { value: 'catalogs', title: 'Catalogs', component: <CatalogsSettings /> },
  { value: 'configuration', title: 'Configuration', component: <ConfigurationManager /> },
];
type SettingsPageValue = (typeof settingsPages)[number]['value'];
const SETTINGS_LAYOUT_NAVIGATE_EVENT = 'settings-layout:navigate';

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
        <RatingPage />
      </div>
    );
  }

  // If in dashboard mode, show only the dashboard (regardless of mobile/desktop)
  if (isDashboardMode) {
    return (
      <div className="w-full">
        <Dashboard />
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
              <AccordionContent className="pt-2 pb-6">{page.component}</AccordionContent>
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
          {page.component}
        </TabsContent>
      ))}
      </Tabs>
    </div>
  );
}
