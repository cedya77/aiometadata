import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
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
    </div>
  );
}
