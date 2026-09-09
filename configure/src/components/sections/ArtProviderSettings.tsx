import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useConfig } from '@/contexts/ConfigContext';
import type { AppConfig } from '@/contexts/ConfigContext';
import { RotateCcw } from 'lucide-react';
import {
  ART_TYPES,
  CONTENT_TYPES,
  getOptions,
  readValue,
  writeValue,
  type ArtType,
  type ContentType,
} from '@/lib/artProviders';
import { Callout } from '@/components/settings/Callout';
import { ProviderSelect } from '@/components/settings/ProviderSelect';
import { SettingRow } from '@/components/settings/SettingRow';
import { NoticeDisclosure } from '@/components/settings/NoticeDisclosure';
import { animeNotices } from '@/lib/animeNotices';

const CONTENT_LABELS: Record<ContentType, string> = {
  movie: 'Movies',
  series: 'Series',
  anime: 'Anime',
};

const ART_LABELS: Record<ArtType, string> = {
  poster: 'Poster',
  background: 'Background',
  logo: 'Logo',
};

export function ArtProviderSettings() {
  const { config, setConfig, hasBuiltInTvdb } = useConfig();
  const hasTvdbKey = !!config.apiKeys?.tvdb?.trim() || hasBuiltInTvdb;

  const handleEnglishArtOnlyChange = (value: boolean) => {
    setConfig(prev => ({
      ...prev,
      artProviders: {
        ...prev.artProviders,
        englishArtOnly: value
      }
    }));
  };

  const isFanartSelected = () => {
    const artProviders = config.artProviders;
    if (!artProviders) return false;

    return Object.values(artProviders).some(contentType =>
      contentType && typeof contentType === 'object' &&
      Object.values(contentType).includes('fanart')
    );
  };

  const hasFanartKey = config.apiKeys.fanart && config.apiKeys.fanart.trim() !== '';

  const setArt = (contentType: ContentType, artType: ArtType, value: string) => {
    setConfig(prev => ({
      ...prev,
      artProviders: writeValue(prev.artProviders, contentType, artType, value) as AppConfig['artProviders'],
    }));
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h2 className="text-2xl font-semibold">Art Providers</h2>
        <p className="text-muted-foreground mt-1">
          Choose your preferred sources for different types of artwork. You can select different providers for posters, backgrounds, and logos.
        </p>

        {/* Search Notice */}
        <Callout variant="info" className="mt-4">
          <strong>Note:</strong> Art provider settings apply to catalogs and detail pages, but not to search results. Search uses the selected search engine's poster sources for faster performance. <strong>Art URL Overrides (configured below) take priority over art provider settings.</strong>
        </Callout>
      </div>

      {/* Global toggles */}
      <Card>
        <CardHeader>
          <CardTitle>Global</CardTitle>
        </CardHeader>
        <CardContent>
          <SettingRow
            htmlFor="english-art-only"
            label="English Art Only"
            description="Force all artwork to be in English language, regardless of your language setting."
            control={
              <Switch
                id="english-art-only"
                checked={config.artProviders?.englishArtOnly || false}
                onCheckedChange={handleEnglishArtOnlyChange}
              />
            }
          />
          <SettingRow
            htmlFor="original-lang-fallback"
            label="Original Language Poster Fallback"
            description="Skip region-mismatched posters in your display language and fall back to English or the title's original language instead."
            control={
              <Switch
                id="original-lang-fallback"
                checked={!!config.artProviders?.originalLangFallback}
                onCheckedChange={(value) => setConfig(prev => ({ ...prev, artProviders: { ...prev.artProviders, originalLangFallback: value } }))}
              />
            }
          />
        </CardContent>
      </Card>

      {isFanartSelected() && !hasFanartKey && (
        <Callout variant="warn">
          <strong>Fanart.tv API Key Required:</strong> You've selected Fanart.tv as an art provider.
          Please add your Fanart.tv API key in the <strong>Integrations</strong> tab to use this service.
        </Callout>
      )}

      {/* Above the matrix because these notices qualify its Anime rows. */}
      <NoticeDisclosure notices={animeNotices(config)} />

      {/* The matrix */}
      <Card>
        <CardHeader>
          <CardTitle>Art Sources</CardTitle>
          <CardDescription>
            Pick a source for each combination of content type and artwork. "Meta Provider (default)" follows whatever you chose on the Meta Providers page. The Anime rows apply only to anime using MAL, AniList, Kitsu or AniDB IDs — anime with IMDb IDs uses the Movie or Series row instead.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Desktop: a real table so row and column headers are announced */}
          <Table className="hidden md:table table-fixed min-w-[42rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[120px]">Content</TableHead>
                {ART_TYPES.map(artType => (
                  <TableHead key={artType}>{ART_LABELS[artType]}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {CONTENT_TYPES.map(contentType => (
                <TableRow key={contentType}>
                  <TableHead scope="row" className="font-medium text-foreground">
                    {CONTENT_LABELS[contentType]}
                  </TableHead>
                  {ART_TYPES.map(artType => (
                    <TableCell key={artType} data-setting={`art-${contentType}-${artType}`}>
                      <ProviderSelect
                        id={`art-${contentType}-${artType}`}
                        ariaLabel={`${CONTENT_LABELS[contentType]} ${ART_LABELS[artType].toLowerCase()} provider`}
                        value={readValue(config.artProviders, contentType, artType)}
                        onValueChange={(val) => setArt(contentType, artType, val)}
                        options={getOptions(contentType, artType)}
                        includeMetaDefault
                        hasTvdbKey={hasTvdbKey}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Mobile: three labelled groups, no horizontal scrolling */}
          <div className="md:hidden space-y-6">
            {CONTENT_TYPES.map(contentType => (
              <div key={contentType}>
                <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                  {CONTENT_LABELS[contentType]}
                </h4>
                {/*
                  Not SettingRow here: its 12rem label floor plus a
                  content-sized control column makes the wrap decision depend on
                  how long the *selected* provider's name is, so choosing
                  "TheTVDB" pulled the select up beside its label while the rows
                  still on "Meta Provider (default)" stayed below theirs. These
                  labels are one short word with no description, so the floor
                  buys nothing and the control can keep the right-hand side at
                  every width. `flex-1 min-w-0` is what makes it stable: the
                  select takes whatever the label leaves rather than measuring
                  its own text, and the trigger's [&>span]:line-clamp-1 handles
                  the longest option on a very narrow phone.
                */}
                {ART_TYPES.map(artType => (
                  <div
                    key={artType}
                    data-setting={`art-${contentType}-${artType}`}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <Label htmlFor={`art-${contentType}-${artType}-m`} className="shrink-0 text-sm font-medium">
                      {ART_LABELS[artType]}
                    </Label>
                    <ProviderSelect
                      id={`art-${contentType}-${artType}-m`}
                      ariaLabel={`${CONTENT_LABELS[contentType]} ${ART_LABELS[artType].toLowerCase()} provider`}
                      value={readValue(config.artProviders, contentType, artType)}
                      onValueChange={(val) => setArt(contentType, artType, val)}
                      options={getOptions(contentType, artType)}
                      includeMetaDefault
                      hasTvdbKey={hasTvdbKey}
                      className="w-auto min-w-0 flex-1 max-w-[15rem]"
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Art URL Overrides */}
      <div>
        <h3 className="text-xl font-semibold mb-4">Art URL Overrides</h3>
        <p className="text-muted-foreground mb-4">
          Override artwork with custom URL patterns. Select a rating poster provider for pre-filled defaults, or use fully custom patterns.
        </p>

        <Card className="mb-6">
          <CardContent className="pt-6">
            <SettingRow
              htmlFor="posterRatingProvider"
              label="Rating Poster Provider"
              description="Pre-fills poster patterns. Choose Custom for manual patterns."
              control={
                <ProviderSelect
                  id="posterRatingProvider"
                  ariaLabel="Rating poster provider"
                  value={config.posterRatingProvider || 'none'}
                  onValueChange={(value) => {
                    const provider = value as 'none' | 'rpdb' | 'top' | 'custom';

                    if (provider === 'none') {
                      setConfig(prev => ({
                        ...prev,
                        posterRatingProvider: provider,
                        customPosterUrlPattern: '',
                        customThumbnailUrlPattern: ''
                      }));
                    } else if (provider === 'custom') {
                      setConfig(prev => ({ ...prev, posterRatingProvider: provider }));
                    } else if (provider === 'rpdb') {
                      setConfig(prev => ({
                        ...prev,
                        posterRatingProvider: provider,
                        customPosterUrlPattern: 'https://api.ratingposterdb.com/{rpdb_key}/imdb/poster-default/{imdb_id}.jpg?fallback=true',
                        customBackgroundUrlPattern: '',
                        customLandscapeUrlPattern: '',
                        customLogoUrlPattern: '',
                        customThumbnailUrlPattern: ''
                      }));
                    } else if (provider === 'top') {
                      setConfig(prev => ({
                        ...prev,
                        posterRatingProvider: provider,
                        customPosterUrlPattern: 'https://api.top-posters.com/{top_key}/imdb/poster/{imdb_id}.jpg',
                        customBackgroundUrlPattern: '',
                        customLandscapeUrlPattern: 'https://api.top-posters.com/{top_key}/imdb/banner/{imdb_id}.jpg?fallback_url={landscape}&user_agent={user_agent}',
                        customLogoUrlPattern: 'https://api.top-posters.com/{top_key}/imdb/logo/{imdb_id}.png?fallback_url={logo}&user_agent={user_agent}',
                        customThumbnailUrlPattern: 'https://api.top-posters.com/{top_key}/imdb/thumbnail/{imdb_id}/S{season}E{episode}.jpg?blur={blur}&fallback_url={thumbnail}&user_agent={user_agent}'
                      }));
                    }
                  }}
                  options={[
                    { value: 'none', label: 'None (no rating posters)' },
                    { value: 'rpdb', label: 'RatingPosterDB (RPDB)' },
                    { value: 'top', label: 'TOP Posters API' },
                    { value: 'custom', label: 'Custom Art URLs' },
                  ]}
                  hasTvdbKey={hasTvdbKey}
                  className="w-full sm:w-[220px]"
                />
              }
            />
            <SettingRow
              htmlFor="usePosterProxy"
              label="Proxy Rating & Custom Art"
              description="Route requests through addon with fallback to original art."
              control={
                <Switch
                  id="usePosterProxy"
                  checked={!!config.usePosterProxy}
                  onCheckedChange={(checked) => setConfig(prev => ({ ...prev, usePosterProxy: checked }))}
                />
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">URL Patterns</CardTitle>
            <CardDescription>
              {config.posterRatingProvider === 'rpdb' || config.posterRatingProvider === 'top'
                ? 'Pre-filled with the default pattern for your selected provider. You can customize it if needed.'
                : 'Override art with custom URL patterns. If a placeholder references an unavailable value, normal art is used instead.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <Label htmlFor="custom-poster-pattern" className="text-sm font-medium">Poster URL Pattern</Label>
                  {(config.posterRatingProvider === 'rpdb' || config.posterRatingProvider === 'top') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        const pattern = config.posterRatingProvider === 'rpdb'
                          ? 'https://api.ratingposterdb.com/{rpdb_key}/imdb/poster-default/{imdb_id}.jpg?fallback=true'
                          : 'https://api.top-posters.com/{top_key}/imdb/poster/{imdb_id}.jpg';
                        setConfig(prev => ({ ...prev, customPosterUrlPattern: pattern }));
                      }}
                    >
                      <RotateCcw className="w-3 h-3 mr-1" />
                      Reset
                    </Button>
                  )}
                </div>
                <Input
                  id="custom-poster-pattern"
                  placeholder="https://example.com/poster/{imdb_id}.jpg"
                  value={config.customPosterUrlPattern || ''}
                  onChange={(e) => setConfig(prev => ({ ...prev, customPosterUrlPattern: e.target.value }))}
                />
              </div>
              <div>
                <Label htmlFor="custom-background-pattern" className="text-sm font-medium mb-1 block">Background URL Pattern</Label>
                <Input
                  id="custom-background-pattern"
                  placeholder="https://example.com/background/{tmdb_id}.jpg"
                  value={config.customBackgroundUrlPattern || ''}
                  onChange={(e) => setConfig(prev => ({ ...prev, customBackgroundUrlPattern: e.target.value }))}
                />
              </div>
              <div>
                <Label htmlFor="custom-landscape-pattern" className="text-sm font-medium mb-1 block">Landscape URL Pattern</Label>
                <Input
                  id="custom-landscape-pattern"
                  placeholder="https://example.com/landscape/{tmdb_id}.jpg"
                  value={config.customLandscapeUrlPattern || ''}
                  onChange={(e) => setConfig(prev => ({ ...prev, customLandscapeUrlPattern: e.target.value }))}
                />
              </div>
              <div>
                <Label htmlFor="custom-logo-pattern" className="text-sm font-medium mb-1 block">Logo URL Pattern</Label>
                <Input
                  id="custom-logo-pattern"
                  placeholder="https://example.com/logo/{tmdb_id}.png"
                  value={config.customLogoUrlPattern || ''}
                  onChange={(e) => setConfig(prev => ({ ...prev, customLogoUrlPattern: e.target.value }))}
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <Label htmlFor="custom-thumbnail-pattern" className="text-sm font-medium">Episode Thumbnail URL Pattern</Label>
                  {(config.posterRatingProvider === 'top') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        const pattern = 'https://api.top-posters.com/{top_key}/imdb/thumbnail/{imdb_id}/S{season}E{episode}.jpg?blur={blur}&fallback_url={thumbnail}&user_agent={user_agent}';
                        setConfig(prev => ({ ...prev, customThumbnailUrlPattern: pattern }));
                      }}
                    >
                      <RotateCcw className="w-3 h-3 mr-1" />
                      Reset
                    </Button>
                  )}
                </div>
                <Input
                  id="custom-thumbnail-pattern"
                  placeholder="https://example.com/thumbnail/{imdb_id}/S{season}E{episode}.jpg"
                  value={config.customThumbnailUrlPattern || ''}
                  onChange={(e) => setConfig(prev => ({ ...prev, customThumbnailUrlPattern: e.target.value }))}
                />
              </div>
            </div>

            <details className="rounded-lg bg-muted p-3">
              <summary className="text-xs font-medium cursor-pointer">Available placeholders</summary>
              <div className="text-xs text-muted-foreground space-y-1 mt-2">
                <p>
                  <strong>ID placeholders:</strong> <code>{'{id}'}</code> <code>{'{imdb_id}'}</code> <code>{'{tmdb_id}'}</code> <code>{'{tvdb_id}'}</code> <code>{'{mal_id}'}</code> <code>{'{kitsu_id}'}</code> <code>{'{anilist_id}'}</code> <code>{'{anidb_id}'}</code> <code>{'{type}'}</code>
                </p>
                <p>
                  <strong>API keys:</strong> <code>{'{rpdb_key}'}</code> <code>{'{top_key}'}</code> <code>{'{tmdb_key}'}</code> <code>{'{mdblist_key}'}</code> <code>{'{fanart_key}'}</code> <code>{'{user_agent}'}</code>
                </p>
                <p>
                  <strong>Language:</strong> <code>{'{language}'}</code> (e.g. fr-FR) <code>{'{language_short}'}</code> (e.g. fr) &nbsp;
                  <strong>Thumbnail:</strong> <code>{'{season}'}</code> <code>{'{episode}'}</code> <code>{'{blur}'}</code> <code>{'{thumbnail}'}</code>
                  &nbsp; <strong>Landscape fallback:</strong> <code>{'{landscape}'}</code>
                  &nbsp; <strong>Logo fallback:</strong> <code>{'{logo}'}</code>
                </p>
                <p>
                  <strong>Optional IDs:</strong> add <code>?</code> before the closing brace (e.g. <code>{'{tvdb_id?}'}</code>) to blank a
                  placeholder instead of discarding the URL when that ID is unavailable. Useful for patterns carrying several IDs where only
                  one needs to be present.
                </p>
                <p>RPDB/TOP patterns automatically fall back to alternative IDs when the primary one is unavailable.</p>
              </div>
            </details>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
