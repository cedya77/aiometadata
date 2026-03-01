import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { useConfig } from '@/contexts/ConfigContext';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

// Define the options for the age rating select dropdown
const ageRatingOptions = [
    { value: 'None', label: 'None (Show All)' },
    { value: 'G', label: 'G (All Ages)' },
    { value: 'PG', label: 'PG (Parental Guidance)' },
    { value: 'PG-13', label: 'PG-13 (Parents Strongly Cautioned)' },
    { value: 'R', label: 'R (Restricted)' },
    { value: 'NC-17', label: 'NC-17 (Adults Only)' },
];

export function FiltersSettings() {
  const { config, setConfig } = useConfig();

  const handleAgeRatingChange = (value: string) => {
    setConfig(prev => ({ ...prev, ageRating: value }));
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

  const handleExclusionKeywordsChange = (value: string) => {
    setConfig(prev => ({ ...prev, exclusionKeywords: value }));
  };

  const handleRegexExclusionFilterChange = (value: string) => {
    setConfig(prev => ({ ...prev, regexExclusionFilter: value }));
  };

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Page Header */}
      <div>
        <h2 className="text-2xl font-semibold">Content Filters</h2>
        {/* FIX: Use theme-aware text color for descriptions */}
        <p className="text-muted-foreground mt-1">Filter the content displayed in catalogs and search results based on age ratings.</p>
      </div>

      {/* Content Rating Card */}
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Content Rating</CardTitle>
          <CardDescription>
            Select the maximum content rating to display. All content rated higher than your selection will be hidden. For movies and series only.
          </CardDescription>
        </CardHeader>
        <CardContent>
            <Select value={config.ageRating} onValueChange={handleAgeRatingChange}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a rating" />
              </SelectTrigger>
              <SelectContent>
                {ageRatingOptions.map(opt => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
              </SelectContent>
            </Select>
        </CardContent>
      </Card>

      {/* SFW Filter Card */}
      <Card className="max-w-lg">
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

      {/* Hide Unreleased Digital Movies Card */}
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Digital Release Filter</CardTitle>
          <CardDescription>
            Hide movies that haven't been released digitally yet. This filters out movies that are only in theaters or haven't been released at all. Applies to movie catalogs only.
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

      {/* Hide Watched Card */}
      {(config.apiKeys?.traktTokenId || config.apiKeys?.anilistTokenId || config.apiKeys?.mdblist) && (
        <Card className="max-w-lg">
          <CardHeader>
            <CardTitle>Hide Watched</CardTitle>
            <CardDescription className="space-y-2 mt-2">
              <p>Hide items you've already watched on Trakt, AniList, or MDBList from all catalogs.</p>
              <ul className="list-disc list-inside ml-2 space-y-1">
                <li><strong>Trakt & MDBList:</strong> Refreshes every 5 minutes</li>
                <li><strong>AniList:</strong> Refreshes every 24 hours</li>
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
          </CardContent>
        </Card>
      )}

      {/* Content Exclusion Filter Card */}
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Content Exclusion Filter</CardTitle>
          <CardDescription>
            Exclude content by keywords or advanced patterns. Perfect for kid-safe filtering.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Simple Keywords */}
          <div className="space-y-2">
            <Label htmlFor="exclusion-keywords">Simple Keywords (Easy)</Label>
            <Input
              id="exclusion-keywords"
              placeholder="naked, sex, porn, adult, horror, scary, violence"
              value={config.exclusionKeywords || ''}
              onChange={(e) => handleExclusionKeywordsChange(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              Comma-separated keywords. Example: "naked, sex, porn, adult"
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
              Advanced users only. Use | to separate patterns. Example: "naked|sex|porn"
            </p>
          </div>

          <div className="text-sm text-muted-foreground bg-muted p-3 rounded">
            <strong>Tip:</strong> Use simple keywords for easy filtering, or advanced regex for precise control. 
            Both work together - content matching either will be excluded.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
