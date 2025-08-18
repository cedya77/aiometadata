import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { useBreakpoint } from '@/hooks/use-breakpoint';
import { cn } from "@/lib/utils";

import { GeneralSettings } from './sections/GeneralSettings';
import { IntegrationsSettings } from './sections/IntegrationsSettings';
import { ProvidersSettings } from './sections/ProvidersSettings';
import { FiltersSettings } from './sections/FiltersSettings';
import { CatalogsSettings } from './sections/CatalogsSettings';
import { SearchSettings } from './sections/SearchSettings';
import { ConfigurationManager } from './ConfigurationManager';

const settingsPages = [
  { value: 'general', title: 'General', component: <GeneralSettings /> },
  { value: 'integrations', title: 'Integrations', component: <IntegrationsSettings /> },
  { value: 'providers', title: 'Providers', component: <ProvidersSettings /> },
  { value: 'filters', title: 'Filters', component: <FiltersSettings /> },
  { value: 'search', title: 'Search', component: <SearchSettings /> },
  { value: 'catalogs', title: 'Catalogs', component: <CatalogsSettings /> },
  { value: 'configuration', title: 'Configuration', component: <ConfigurationManager /> },
];

/**
 * A responsive layout component that displays settings in Tabs on desktop
 * and in an Accordion on mobile devices.
 */
export function SettingsLayout() {
  // Use our custom hook to determine if we're on a mobile-sized screen.
  const { isMobile } = useBreakpoint();

  // --- RENDER ACCORDION ON MOBILE ---
  if (isMobile) {
    return (
      <Accordion type="single" collapsible className="w-full">
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
    );
  }

  return (
    <Tabs defaultValue="general" className="w-full">
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
  );
}
