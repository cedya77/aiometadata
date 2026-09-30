import { Label } from '@/components/ui/label';
import { TmdbKeywordPicker } from '@/components/settings/TmdbKeywordPicker';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { useConfig } from '@/contexts/ConfigContext';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { AGE_RATING_OPTIONS as ageRatingOptions } from '@/lib/ageRatings';


export function FiltersSettings() {
  const { config, setConfig } = useConfig();
  const hasAgeRatingCap = !!config.ageRating && config.ageRating !== 'None';

  const handleAgeRatingChange = (value: string) => {
    setConfig(prev => ({ ...prev, ageRating: value }));
  };

  const handleAllowUnratedChange = (checked: boolean) => {
    setConfig(prev => ({ ...prev, allowUnratedContent: checked }));
  };

  const handleSfwChange = (checked: boolean) => {
    setConfig(prev => ({ ...prev, sfw: checked }));
  };

  const handleHideUnreleasedDigitalChange = (checked: boolean) => {
    setConfig(prev => ({ ...prev, hideUnreleasedDigital: checked }));
  };

  const handleHideUnreleasedDigitalSearchChange = (checked: boolean) => {
    setConfig(prev => ({ ...prev, hideUnreleasedDigitalSearch: checked }));
  };

  const handleHideUnreleasedShowsChange = (checked: boolean) => {
    setConfig(prev => ({ ...prev, hideUnreleasedShows: checked }));
  };

  const handleHideUnreleasedShowsSearchChange = (checked: boolean) => {
    setConfig(prev => ({ ...prev, hideUnreleasedShowsSearch: checked }));
  };

  const handleExclusionKeywordsChange = (value: string) => {
    setConfig(prev => ({ ...prev, exclusionKeywords: value }));
  };

  const handleRegexExclusionFilterChange = (value: string) => {
    setConfig(prev => ({ ...prev, regexExclusionFilter: value }));
  };

  const handleExclusionGenresChange = (value: string) => {
    setConfig(prev => ({ ...prev, exclusionGenres: value }));
  };

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Page Header */}
      <div>
        <h2 className="text-2xl font-semibold">Content Filters</h2>
        {/* FIX: Use theme-aware text color for descriptions */}
        <p className="text-muted-foreground mt-1">Filter the content displayed in catalogs and search results based on age ratings.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Content Rating</CardTitle>
            <CardDescription>
              Select the maximum content rating to display. All content rated higher than your selection will be hidden. For movies and series only.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col space-y-4">
              <Select value={config.ageRating} onValueChange={handleAgeRatingChange}>
                <SelectTrigger className="w-full" data-setting="age-rating" aria-label="Maximum content rating">
                  <SelectValue placeholder="Select a rating" />
                </SelectTrigger>
                <SelectContent>
                  {ageRatingOptions.map(opt => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
                </SelectContent>
              </Select>
              {/* Also shown when it is off with no limit set: an install URL can carry a
                  limit of its own, and that reads this, so it must not be unreachable. */}
              {(hasAgeRatingCap || config.allowUnratedContent === false) && (
                <div className="space-y-2">
                  <div className="flex items-center space-x-2">
                    <Switch
                      id="allow-unrated-content"
                      data-setting="allow-unrated-content"
                      checked={config.allowUnratedContent !== false}
                      onCheckedChange={handleAllowUnratedChange}
                    />
                    <Label htmlFor="allow-unrated-content">Show Unrated Titles</Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Most catalog rows carry no rating at all, so turning this off leaves them nearly empty.
                    Turn it off only if you would rather hide anything whose rating cannot be confirmed.
                  </p>
                  {!hasAgeRatingCap && (
                    <p className="text-xs text-muted-foreground">
                      With no limit set above, this only applies to an install URL that carries one.
                    </p>
                  )}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Anime Content Filter</CardTitle>
            <CardDescription>
              Enable to show only safe for work anime content. This will filter out adult content, some ecchi content, and other mature themes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center space-x-2">
              <Switch
                id="sfw-mode"
                checked={config.sfw}
                onCheckedChange={handleSfwChange}
              />
              <Label htmlFor="sfw-mode">Safe for Work (SFW) Mode</Label>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Digital Release Filter</CardTitle>
            <CardDescription>
              Hide movies that haven't been released digitally yet. Applies to movie catalogs only.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col space-y-4">
              <div className="flex items-center space-x-2">
                <Switch
                  id="hide-unreleased-digital"
                  checked={config.hideUnreleasedDigital ?? false}
                  onCheckedChange={handleHideUnreleasedDigitalChange}
                />
                <Label htmlFor="hide-unreleased-digital">Hide Unreleased Movies in Catalogs</Label>
              </div>
              <div className="flex items-center space-x-2">
                <Switch
                  id="hide-unreleased-digital-search"
                  checked={config.hideUnreleasedDigitalSearch ?? false}
                  onCheckedChange={handleHideUnreleasedDigitalSearchChange}
                />
                <Label htmlFor="hide-unreleased-digital-search">Hide Unreleased Movies in Search</Label>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Unreleased Shows Filter</CardTitle>
            <CardDescription>
              Hide series that haven't aired yet based on their release date. Applies to series catalogs only.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col space-y-4">
              <div className="flex items-center space-x-2">
                <Switch
                  id="hide-unreleased-shows"
                  checked={config.hideUnreleasedShows ?? false}
                  onCheckedChange={handleHideUnreleasedShowsChange}
                />
                <Label htmlFor="hide-unreleased-shows">Hide Unreleased Shows in Catalogs</Label>
              </div>
              <div className="flex items-center space-x-2">
                <Switch
                  id="hide-unreleased-shows-search"
                  checked={config.hideUnreleasedShowsSearch ?? false}
                  onCheckedChange={handleHideUnreleasedShowsSearchChange}
                />
                <Label htmlFor="hide-unreleased-shows-search">Hide Unreleased Shows in Search</Label>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Hide Watched Card */}
      {(config.apiKeys?.traktTokenId || config.apiKeys?.anilistTokenId || config.apiKeys?.mdblist || config.apiKeys?.simklTokenId) && (
        <Card>
          <CardHeader>
            <CardTitle>Hide Watched</CardTitle>
            <CardDescription className="space-y-2 mt-2">
              <p>Hide items you've already watched on Trakt, AniList, MDBList or Simkl from all catalogs.</p>
              <ul className="list-disc list-inside ml-2 space-y-1">
                <li><strong>Trakt & MDBList:</strong> Refreshes every 5 minutes</li>
                <li><strong>AniList:</strong> Refreshes every 24 hours</li>
                <li><strong>Simkl:</strong> Refreshes every 6 hours by default</li>
              </ul>
              <p className="text-muted-foreground mt-2">
                Note: Does not apply to search results, watchlists, or up-next catalogs.
              </p>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {config.apiKeys?.traktTokenId && (
              <div className="flex items-center space-x-2">
                <Switch
                  id="hide-watched-trakt"
                  checked={config.hideWatchedTrakt ?? false}
                  onCheckedChange={(checked) => setConfig(prev => ({ ...prev, hideWatchedTrakt: checked }))}
                />
                <Label htmlFor="hide-watched-trakt">Hide Trakt Watched Items</Label>
              </div>
            )}
            {config.apiKeys?.anilistTokenId && (
              <div className="flex items-center space-x-2">
                <Switch
                  id="hide-watched-anilist"
                  checked={config.hideWatchedAnilist ?? false}
                  onCheckedChange={(checked) => setConfig(prev => ({ ...prev, hideWatchedAnilist: checked }))}
                />
                <Label htmlFor="hide-watched-anilist">Hide AniList Watched Items</Label>
              </div>
            )}
            {config.apiKeys?.mdblist && (
              <div className="flex items-center space-x-2">
                <Switch
                  id="hide-watched-mdblist"
                  checked={config.hideWatchedMdblist ?? false}
                  onCheckedChange={(checked) => setConfig(prev => ({ ...prev, hideWatchedMdblist: checked }))}
                />
                <Label htmlFor="hide-watched-mdblist">Hide MDBList Watched Items</Label>
              </div>
            )}
            {config.apiKeys?.simklTokenId && (
              <div className="flex items-center space-x-2">
                <Switch
                  id="hide-watched-simkl"
                  checked={config.hideWatchedSimkl ?? false}
                  onCheckedChange={(checked) => setConfig(prev => ({ ...prev, hideWatchedSimkl: checked }))}
                />
                <Label htmlFor="hide-watched-simkl">Hide Simkl Watched Items</Label>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Content Exclusion Filter Card */}
      <Card>
        <CardHeader>
          <CardTitle>Content Exclusion Filter</CardTitle>
          <CardDescription>
            Hide content from catalogs and search results by genre, TMDB keyword, or words in the title and description.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Genre Exclusion */}
          <div className="space-y-2">
            <Label htmlFor="exclusion-genres">Exclude Genres</Label>
            <Input
              id="exclusion-genres"
              placeholder="Horror, Documentary, Reality, War"
              value={config.exclusionGenres || ''}
              onChange={(e) => handleExclusionGenresChange(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              Comma-separated genre names. Any item tagged with a matching genre will be hidden.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="exclusion-tmdb-keywords">Exclude TMDB Keywords</Label>
            <TmdbKeywordPicker
              id="exclusion-tmdb-keywords"
              value={config.exclusionTmdbKeywords ?? []}
              onChange={(next) => setConfig(prev => ({ ...prev, exclusionTmdbKeywords: next }))}
            />
            <p className="text-sm text-muted-foreground">
              Hides any title TMDB tags with one of these keywords.
            </p>
          </div>

          {/* Simple Keywords */}
          <div className="space-y-2">
            <Label htmlFor="exclusion-keywords">Exclude Words</Label>
            <Input
              id="exclusion-keywords"
              placeholder="naked, sex, porn, adult, horror, scary, violence"
              value={config.exclusionKeywords || ''}
              onChange={(e) => handleExclusionKeywordsChange(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              Comma-separated words matched against each item's title and description.
            </p>
          </div>

          {/* Advanced Regex */}
          <div className="space-y-2">
            <Label htmlFor="regex-exclusion-filter">Advanced Pattern (Regex)</Label>
            <Input
              id="regex-exclusion-filter"
              placeholder="naked|sex|porn|adult|horror|scary"
              value={config.regexExclusionFilter || ''}
              onChange={(e) => handleRegexExclusionFilterChange(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              Advanced users only. Matched against title and description. Use | to separate patterns.
            </p>
          </div>

          <div className="text-sm text-muted-foreground bg-muted p-3 rounded">
            <strong>Tip:</strong> All filters work together — content matching any of them will be hidden from catalogs and search results.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
