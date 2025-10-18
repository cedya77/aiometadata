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
          <div className="flex items-center space-x-2">
            <Switch
              id="hide-unreleased-digital"
              checked={config.hideUnreleasedDigital ?? false}
              onCheckedChange={handleHideUnreleasedDigitalChange}
            />
            <Label htmlFor="hide-unreleased-digital">Hide Unreleased Movies</Label>
          </div>
        </CardContent>
      </Card>

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
