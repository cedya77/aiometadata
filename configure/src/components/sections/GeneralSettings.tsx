// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useConfig } from '@/contexts/ConfigContext';

import { languageOptions } from '@/data/languages';
import { ratingCountryCodes } from '@/data/ratingCountries';
import { timezoneOptionsWith } from '@/data/timezones';

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const ratingCountryOptions = ratingCountryCodes
  .map(code => ({ value: code, label: regionNames.of(code) || code }))
  .sort((a, b) => a.label.localeCompare(b.label));

const castCountOptions = [
    { value: 0, label: '0 Members' },
    { value: 5, label: '5 Members' },
    { value: 10, label: '10 Members' },
    { value: 15, label: '15 Members' },
    { value: -1, label: 'Unlimited' } 
];

export function GeneralSettings() {
  // Use our custom hook to get the current config and the function to update it
  const { config, setConfig } = useConfig();

  // --- Handler Functions ---
  // These functions update the single state object, preserving the other values.

  const handleLanguageChange = (value: string) => {
    setConfig(prevConfig => ({ ...prevConfig, language: value }));
  };

  const handleIncludeAdultChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, includeAdult: checked }));
  };

  const handleBlurThumbsChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, blurThumbs: checked }));
  };

  const handleShowPrefixChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, showPrefix: checked }));
  };

  const handleDisplayTypeOverrideChange = (kind: 'movie' | 'series', value: string) => {
    setConfig(prevConfig => {
      const next = { ...(prevConfig.displayTypeOverrides || {}), [kind]: value.trim() || undefined };
      const hasAny = !!(next.movie || next.series);
      return { ...prevConfig, displayTypeOverrides: hasAny ? next : undefined };
    });
  };

  const handleShowMetaProviderAttributionChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, showMetaProviderAttribution: checked }));
  };

  const handleHideErrorsChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, hideErrors: checked ? undefined : true }));
  };

  const handleCriticRatingsChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, criticRatings: checked ? true : undefined }));
  };

  const handleCastCountChange = (value: string) => {
    const count = parseInt(value, 10);
    setConfig(prevConfig => ({ ...prevConfig, castCount: count === -1 ? undefined : count }));
  };

  const handleDisplayAgeRatingChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, displayAgeRating: checked }));
  };

  const handleContentRatingCountryChange = (value: string) => {
    setConfig(prevConfig => ({ ...prevConfig, contentRatingCountry: value === 'auto' ? undefined : value }));
  };

  const handleEnableRatingPostersForLibraryChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, enableRatingPostersForLibrary: checked }));
  };

  const handleShowRateMeButtonChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, showRateMeButton: checked }));
  };

  const handleTimezoneChange = (value: string) => {
    setConfig(prevConfig => ({ ...prevConfig, timezone: value }));
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h2 className="text-2xl font-semibold">General</h2>
        <p className="text-muted-foreground mt-1">Configure the basic display and content settings for your addon.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Display & Language</CardTitle>
            <CardDescription>Control how content is presented in your addon.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="language" className="font-medium">Display Language</Label>
                <p className="text-sm text-muted-foreground">Language for titles and descriptions.</p>
              </div>
              <Select value={config.language} onValueChange={handleLanguageChange}>
                <SelectTrigger id="language" className="w-full sm:w-[200px] shrink-0">
                  <SelectValue placeholder="Select language" />
                </SelectTrigger>
                <SelectContent>
                  {languageOptions.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="timezone" className="font-medium">Timezone</Label>
                <p className="text-sm text-muted-foreground">For calendar-based features (e.g., Trakt Calendar).</p>
              </div>
              <Select value={config.timezone || 'UTC'} onValueChange={handleTimezoneChange}>
                <SelectTrigger id="timezone" className="w-full sm:w-[240px] shrink-0">
                  <SelectValue placeholder="Select timezone" />
                </SelectTrigger>
                <SelectContent>
                  {timezoneOptionsWith(config.timezone || 'UTC').map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="cast-count" className="font-medium">Cast Members</Label>
                <p className="text-sm text-muted-foreground">Number of cast members on details page.</p>
              </div>
              <Select value={String(config.castCount ?? -1)} onValueChange={handleCastCountChange}>
                <SelectTrigger id="cast-count" className="w-full sm:w-[160px] shrink-0">
                  <SelectValue placeholder="Select count" />
                </SelectTrigger>
                <SelectContent>
                  {castCountOptions.map(opt => (
                    <SelectItem key={opt.value} value={String(opt.value)}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="show-prefix" className="font-medium">Show Prefix</Label>
                <p className="text-sm text-muted-foreground">Add "{config.addonName || 'AIOMetadata'} - " prefix to catalogs.</p>
              </div>
              <Switch id="show-prefix" checked={config.showPrefix} onCheckedChange={handleShowPrefixChange} />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="show-meta-provider-attribution" className="font-medium">Meta Attribution</Label>
                <p className="text-sm text-muted-foreground">Show "[Meta provided by Provider]" in overview.</p>
              </div>
              <Switch id="show-meta-provider-attribution" checked={config.showMetaProviderAttribution} onCheckedChange={handleShowMetaProviderAttributionChange} />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="show-errors" className="font-medium">Show Errors</Label>
                <p className="text-sm text-muted-foreground">When a provider refuses a request, show the reason as a card in the row instead of an empty one.</p>
              </div>
              <Switch id="show-errors" checked={config.hideErrors !== true} onCheckedChange={handleHideErrorsChange} />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="critic-ratings" className="font-medium">Critic Ratings</Label>
                <p className="text-sm text-muted-foreground">Add Rotten Tomatoes, Metacritic, Letterboxd, Roger Ebert, Trakt, TMDB and MyAnimeList scores to titles, for apps that show them. Most apps ignore them, so leave this off unless yours reads them.</p>
              </div>
              <Switch id="critic-ratings" checked={config.criticRatings === true} onCheckedChange={handleCriticRatingsChange} />
            </div>

            <div className="space-y-3 p-3 rounded-lg">
              <div>
                <Label className="font-medium">Catalog Type Labels</Label>
                <p className="text-sm text-muted-foreground">
                  Clients label rows by content type, as in "Netflix - Series". Override the wording
                  to taste, for example "Netflix - Shows". Leave blank to keep the default.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {(['movie', 'series'] as const).map(kind => (
                  <div key={kind} className="space-y-1.5">
                    <Label htmlFor={`display-type-${kind}`} className="text-sm">
                      {kind === 'movie' ? 'Movies' : 'Series'}
                    </Label>
                    <Input
                      id={`display-type-${kind}`}
                      value={config.displayTypeOverrides?.[kind] || ''}
                      placeholder={kind === 'movie' ? 'e.g. film' : 'e.g. shows'}
                      onChange={event => handleDisplayTypeOverrideChange(kind, event.target.value)}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="display-age-rating" className="font-medium">Display Age Rating</Label>
                <p className="text-sm text-muted-foreground">Show rating/certification in genres.</p>
              </div>
              <Switch id="display-age-rating" checked={config.displayAgeRating} onCheckedChange={handleDisplayAgeRatingChange} />
            </div>
            {config.displayAgeRating && (
              <div className="ml-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-r-lg border-l border-border p-3 pl-4 hover:bg-accent/50 transition-colors">
                <div className="min-w-[12rem] flex-1">
                  <Label htmlFor="content-rating-country" className="font-medium">Rating Country</Label>
                  <p className="text-sm text-muted-foreground">Which country's rating the age rating shows.</p>
                </div>
                <Select value={config.contentRatingCountry || 'auto'} onValueChange={handleContentRatingCountryChange}>
                  <SelectTrigger id="content-rating-country" className="w-full sm:w-[240px] shrink-0">
                    <SelectValue placeholder="Same as display language" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Same as display language</SelectItem>
                    {ratingCountryOptions.map(opt => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Content & Privacy</CardTitle>
            <CardDescription>Manage adult content, spoilers, and poster settings.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="adult-content" className="font-medium">Include Adult Content</Label>
                <p className="text-sm text-muted-foreground">Show NSFW content in catalogs and search.</p>
              </div>
              <Switch id="adult-content" checked={config.includeAdult} onCheckedChange={handleIncludeAdultChange} />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="blur-thumbs" className="font-medium">Hide Episode Spoilers</Label>
                <p className="text-sm text-muted-foreground">Blur episode thumbnails to avoid spoilers.</p>
              </div>
              <Switch id="blur-thumbs" checked={config.blurThumbs} onCheckedChange={handleBlurThumbsChange} />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="show-rate-me-button" className="font-medium">Show Rate Me Button</Label>
                <p className="text-sm text-muted-foreground">
                  {config.catalogModeOnly
                    ? 'Catalog Mode Only leaves the rating button to the install that supplies meta.'
                    : 'Display a rating button in meta pages.'}
                </p>
              </div>
              <Switch id="show-rate-me-button" checked={!!config.showRateMeButton && !config.catalogModeOnly} disabled={config.catalogModeOnly} onCheckedChange={handleShowRateMeButtonChange} />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="enable-rating-posters-for-library" className="font-medium">Rating Posters for Library</Label>
                <p className="text-sm text-muted-foreground">Keep rating posters for Continue Watching and Library items.</p>
              </div>
              <Switch id="enable-rating-posters-for-library" checked={config.enableRatingPostersForLibrary !== false} onCheckedChange={handleEnableRatingPostersForLibraryChange} />
            </div>
          </CardContent>
        </Card>
      </div>

    </div>
  );
}
