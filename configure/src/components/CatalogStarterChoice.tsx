import React, { useState } from 'react';
import { Layers, Wand2, Sparkles, ChevronRight, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CatalogStarterChoiceProps {
  onChooseDefaults: () => void;
  onChooseBlank: () => void;
}

/**
 * CatalogStarterChoice
 *
 * Shown in the Catalogs tab when the user has a new/empty config
 * (i.e. config.catalogs is empty or hasn't been committed yet).
 *
 * Presents two paths:
 *  1) "Start with Defaults" — loads allCatalogDefinitions with their default enabled/showInHome states
 *  2) "Start from Scratch" — keeps catalogs empty and opens the TMDBDiscoverBuilderDialog
 *
 * Usage in CatalogsSettings:
 *   if (isNewConfig) {
 *     return (
 *       <CatalogStarterChoice
 *         onChooseDefaults={handleLoadDefaults}
 *         onChooseBlank={() => { handleClearCatalogs(); setIsTmdbDiscoverBuilderOpen(true); }}
 *       />
 *     );
 *   }
 */
export function CatalogStarterChoice({ onChooseDefaults, onChooseBlank }: CatalogStarterChoiceProps) {
  const [hoveredCard, setHoveredCard] = useState<'defaults' | 'blank' | null>(null);
  const [selectedCard, setSelectedCard] = useState<'defaults' | 'blank' | null>(null);

  const handleSelect = (choice: 'defaults' | 'blank') => {
    if (selectedCard) return; // prevent double-click
    setSelectedCard(choice);
    // Small delay for the visual feedback before triggering the action
    setTimeout(() => {
      if (choice === 'defaults') onChooseDefaults();
      else onChooseBlank();
    }, 400);
  };

  const defaultFeatures = [
    'Trending & Popular catalogs',
    'Top Rated collections',
    'Catalogs by year, genre & language',
    'Ready to use immediately',
  ];

  const blankFeatures = [
    'Start with zero catalogs',
    'Build exactly what you want',
    'Use the Catalog Builder tool',
    'Add from integrations later',
  ];

  if (selectedCard) {
    return (
      <div className="flex items-center justify-center py-20 animate-fade-in">
        <div className="flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center animate-in zoom-in duration-300">
            <Check className="w-6 h-6 text-primary" />
          </div>
          <p className="text-sm text-muted-foreground font-medium">
            {selectedCard === 'defaults' ? 'Loading default catalogs...' : 'Opening Catalog Builder...'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 py-4 animate-fade-in">
      {/* Header */}
      <div className="text-center space-y-3">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 mb-2">
          <Sparkles className="w-7 h-7 text-primary" />
        </div>
        <h2 className="text-2xl font-semibold tracking-tight">
          Set Up Your Catalogs
        </h2>
        <p className="text-muted-foreground max-w-md mx-auto text-sm leading-relaxed">
          Choose how you'd like to start. You can always customize everything later.
        </p>
      </div>

      {/* Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl mx-auto">
        {/* Default Catalogs Card */}
        <button
          onClick={() => handleSelect('defaults')}
          onMouseEnter={() => setHoveredCard('defaults')}
          onMouseLeave={() => setHoveredCard(null)}
          className={cn(
            "group relative w-full text-left rounded-xl border-2 p-6 transition-all duration-300 outline-none",
            "hover:shadow-lg hover:shadow-primary/5",
            "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
            hoveredCard === 'defaults'
              ? "border-primary bg-primary/[0.03] dark:bg-primary/[0.06]"
              : "border-border hover:border-primary/40"
          )}
        >
          {/* Recommended badge */}
          <div className="absolute -top-3 left-4">
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-primary text-primary-foreground shadow-sm">
              <Sparkles className="w-3 h-3" />
              Recommended
            </span>
          </div>

          <div className="space-y-4 pt-1">
            <div className="flex items-start gap-3">
              <div className={cn(
                "flex items-center justify-center w-10 h-10 rounded-lg shrink-0 transition-colors duration-300",
                hoveredCard === 'defaults'
                  ? "bg-primary/15 text-primary"
                  : "bg-muted text-muted-foreground"
              )}>
                <Layers className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-base">Start with Defaults</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  A curated set of catalogs to get you going
                </p>
              </div>
            </div>

            <ul className="space-y-2 pl-0.5">
              {defaultFeatures.map((feature) => (
                <li key={feature} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Check className="w-3.5 h-3.5 text-primary shrink-0" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>

            <div className={cn(
              "flex items-center gap-1.5 text-sm font-medium pt-1 transition-colors duration-300",
              hoveredCard === 'defaults' ? "text-primary" : "text-muted-foreground"
            )}>
              Get started
              <ChevronRight className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-0.5" />
            </div>
          </div>
        </button>

        {/* Blank / Builder Card */}
        <button
          onClick={() => handleSelect('blank')}
          onMouseEnter={() => setHoveredCard('blank')}
          onMouseLeave={() => setHoveredCard(null)}
          className={cn(
            "group relative w-full text-left rounded-xl border-2 p-6 transition-all duration-300 outline-none",
            "hover:shadow-lg hover:shadow-primary/5",
            "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
            hoveredCard === 'blank'
              ? "border-primary bg-primary/[0.03] dark:bg-primary/[0.06]"
              : "border-border hover:border-primary/40"
          )}
        >
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <div className={cn(
                "flex items-center justify-center w-10 h-10 rounded-lg shrink-0 transition-colors duration-300",
                hoveredCard === 'blank'
                  ? "bg-primary/15 text-primary"
                  : "bg-muted text-muted-foreground"
              )}>
                <Wand2 className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-base">Start from Scratch</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Build your own catalog collection
                </p>
              </div>
            </div>

            <ul className="space-y-2 pl-0.5">
              {blankFeatures.map((feature) => (
                <li key={feature} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Check className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>

            <div className={cn(
              "flex items-center gap-1.5 text-sm font-medium pt-1 transition-colors duration-300",
              hoveredCard === 'blank' ? "text-primary" : "text-muted-foreground"
            )}>
              Open Catalog Builder
              <ChevronRight className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-0.5" />
            </div>
          </div>
        </button>
      </div>
    </div>
  );
}
