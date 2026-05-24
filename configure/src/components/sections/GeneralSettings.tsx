import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useConfig } from '@/contexts/ConfigContext';

// Define the options for the language select dropdown for clarity
const languageOptions = [
  { value: "ab-AB", label: "Abkhazian" },
  { value: "aa-AA", label: "Afar" },
  { value: "af-AF", label: "Afrikaans" },
  { value: "ak-AK", label: "Akan" },
  { value: "sq-AL", label: "Albanian" },
  { value: "am-AM", label: "Amharic" },
  { value: "ar-SA", label: "Arabic (Saudi Arabia)" },
  { value: "ar-AE", label: "Arabic (UAE)" },
  { value: "an-AN", label: "Aragonese" },
  { value: "hy-HY", label: "Armenian" },
  { value: "as-AS", label: "Assamese" },
  { value: "av-AV", label: "Avaric" },
  { value: "ae-AE", label: "Avestan" },
  { value: "ay-AY", label: "Aymara" },
  { value: "az-AZ", label: "Azerbaijani" },
  { value: "bm-BM", label: "Bambara" },
  { value: "ba-BA", label: "Bashkir" },
  { value: "eu-ES", label: "Basque" },
  { value: "be-BY", label: "Belarusian" },
  { value: "bn-BD", label: "Bengali" },
  { value: "bi-BI", label: "Bislama" },
  { value: "nb-NO", label: "Bokmål" },
  { value: "bs-BS", label: "Bosnian" },
  { value: "br-BR", label: "Breton" },
  { value: "bg-BG", label: "Bulgarian" },
  { value: "my-MY", label: "Burmese" },
  { value: "cn-CN", label: "Cantonese" },
  { value: "ca-ES", label: "Catalan" },
  { value: "km-KM", label: "Central Khmer" },
  { value: "ch-GU", label: "Chamorro" },
  { value: "ce-CE", label: "Chechen" },
  { value: "ny-NY", label: "Chichewa" },
  { value: "zh-CN", label: "Chinese (China)" },
  { value: "zh-HK", label: "Chinese (Hong Kong)" },
  { value: "zh-TW", label: "Chinese (Taiwan)" },
  { value: "cu-CU", label: "Church Slavic" },
  { value: "cv-CV", label: "Chuvash" },
  { value: "kw-KW", label: "Cornish" },
  { value: "co-CO", label: "Corsican" },
  { value: "cr-CR", label: "Cree" },
  { value: "hr-HR", label: "Croatian" },
  { value: "cs-CZ", label: "Czech" },
  { value: "da-DK", label: "Danish" },
  { value: "dv-DV", label: "Divehi" },
  { value: "nl-NL", label: "Dutch" },
  { value: "dz-DZ", label: "Dzongkha" },
  { value: "en-US", label: "English (US)" },
  { value: "en-AU", label: "English (Australia)" },
  { value: "en-CA", label: "English (Canada)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "en-IE", label: "English (Ireland)" },
  { value: "en-NZ", label: "English (New Zealand)" },
  { value: "eo-EO", label: "Esperanto" },
  { value: "et-EE", label: "Estonian" },
  { value: "ee-EE", label: "Ewe" },
  { value: "fo-FO", label: "Faroese" },
  { value: "fj-FJ", label: "Fijian" },
  { value: "fi-FI", label: "Finnish" },
  { value: "fr-FR", label: "French (France)" },
  { value: "fr-CA", label: "French (Canada)" },
  { value: "ff-FF", label: "Fulah" },
  { value: "gd-GD", label: "Gaelic" },
  { value: "gl-ES", label: "Galician" },
  { value: "lg-LG", label: "Ganda" },
  { value: "ka-GE", label: "Georgian" },
  { value: "de-DE", label: "German (Germany)" },
  { value: "de-AT", label: "German (Austria)" },
  { value: "de-CH", label: "German (Switzerland)" },
  { value: "el-GR", label: "Greek" },
  { value: "gn-GN", label: "Guarani" },
  { value: "gu-GU", label: "Gujarati" },
  { value: "ht-HT", label: "Haitian" },
  { value: "ha-HA", label: "Hausa" },
  { value: "he-IL", label: "Hebrew" },
  { value: "hz-HZ", label: "Herero" },
  { value: "hi-IN", label: "Hindi" },
  { value: "ho-HO", label: "Hiri Motu" },
  { value: "hu-HU", label: "Hungarian" },
  { value: "is-IS", label: "Icelandic" },
  { value: "io-IO", label: "Ido" },
  { value: "ig-IG", label: "Igbo" },
  { value: "id-ID", label: "Indonesian" },
  { value: "ia-IA", label: "Interlingua" },
  { value: "ie-IE", label: "Interlingue" },
  { value: "iu-IU", label: "Inuktitut" },
  { value: "ik-IK", label: "Inupiaq" },
  { value: "ga-GA", label: "Irish" },
  { value: "it-IT", label: "Italian" },
  { value: "ja-JP", label: "Japanese" },
  { value: "jv-JV", label: "Javanese" },
  { value: "kl-KL", label: "Kalaallisut" },
  { value: "kn-IN", label: "Kannada" },
  { value: "kr-KR", label: "Kanuri" },
  { value: "ks-KS", label: "Kashmiri" },
  { value: "kk-KZ", label: "Kazakh" },
  { value: "ki-KI", label: "Kikuyu" },
  { value: "rw-RW", label: "Kinyarwanda" },
  { value: "ky-KY", label: "Kirghiz" },
  { value: "kv-KV", label: "Komi" },
  { value: "kg-KG", label: "Kongo" },
  { value: "ko-KR", label: "Korean" },
  { value: "kj-KJ", label: "Kuanyama" },
  { value: "ku-KU", label: "Kurdish" },
  { value: "lo-LO", label: "Lao" },
  { value: "la-LA", label: "Latin" },
  { value: "lv-LV", label: "Latvian" },
  { value: "li-LI", label: "Limburgan" },
  { value: "ln-LN", label: "Lingala" },
  { value: "lt-LT", label: "Lithuanian" },
  { value: "lu-LU", label: "Luba-Katanga" },
  { value: "lb-LB", label: "Luxembourgish" },
  { value: "mk-MK", label: "Macedonian" },
  { value: "mg-MG", label: "Malagasy" },
  { value: "ms-MY", label: "Malay (Malaysia)" },
  { value: "ms-SG", label: "Malay (Singapore)" },
  { value: "ml-IN", label: "Malayalam" },
  { value: "mt-MT", label: "Maltese" },
  { value: "gv-GV", label: "Manx" },
  { value: "mi-MI", label: "Maori" },
  { value: "mr-MR", label: "Marathi" },
  { value: "mh-MH", label: "Marshallese" },
  { value: "mo-MO", label: "Moldavian" },
  { value: "mn-MN", label: "Mongolian" },
  { value: "na-NA", label: "Nauru" },
  { value: "nv-NV", label: "Navajo" },
  { value: "nd-ND", label: "North Ndebele" },
  { value: "nr-NR", label: "South Ndebele" },
  { value: "ng-NG", label: "Ndonga" },
  { value: "ne-NE", label: "Nepali" },
  { value: "se-SE", label: "Northern Sami" },
  { value: "no-NO", label: "Norwegian" },
  { value: "nn-NN", label: "Norwegian Nynorsk" },
  { value: "oc-OC", label: "Occitan" },
  { value: "oj-OJ", label: "Ojibwa" },
  { value: "or-OR", label: "Oriya" },
  { value: "om-OM", label: "Oromo" },
  { value: "os-OS", label: "Ossetian" },
  { value: "pi-PI", label: "Pali" },
  { value: "pa-PA", label: "Panjabi" },
  { value: "fa-IR", label: "Persian" },
  { value: "pl-PL", label: "Polish" },
  { value: "pt-PT", label: "Portuguese (Portugal)" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
  { value: "ps-PS", label: "Pushto" },
  { value: "qu-QU", label: "Quechua" },
  { value: "ro-RO", label: "Romanian" },
  { value: "rm-RM", label: "Romansh" },
  { value: "rn-RN", label: "Rundi" },
  { value: "ru-RU", label: "Russian" },
  { value: "sm-SM", label: "Samoan" },
  { value: "sg-SG", label: "Sango" },
  { value: "sa-SA", label: "Sanskrit" },
  { value: "sc-SC", label: "Sardinian" },
  { value: "sr-RS", label: "Serbian" },
  { value: "sh-SH", label: "Serbo-Croatian" },
  { value: "sn-SN", label: "Shona" },
  { value: "ii-II", label: "Sichuan Yi" },
  { value: "sd-SD", label: "Sindhi" },
  { value: "si-LK", label: "Sinhala" },
  { value: "sk-SK", label: "Slovak" },
  { value: "sl-SI", label: "Slovenian" },
  { value: "so-SO", label: "Somali" },
  { value: "st-ST", label: "Sotho" },
  { value: "es-ES", label: "Spanish (Spain)" },
  { value: "es-MX", label: "Spanish (Mexico)" },
  { value: "su-SU", label: "Sundanese" },
  { value: "sw-SW", label: "Swahili" },
  { value: "ss-SS", label: "Swati" },
  { value: "sv-SE", label: "Swedish" },
  { value: "tl-PH", label: "Tagalog" },
  { value: "ty-TY", label: "Tahitian" },
  { value: "tg-TG", label: "Tajik" },
  { value: "ta-IN", label: "Tamil" },
  { value: "tt-TT", label: "Tatar" },
  { value: "te-IN", label: "Telugu" },
  { value: "th-TH", label: "Thai" },
  { value: "bo-BO", label: "Tibetan" },
  { value: "ti-TI", label: "Tigrinya" },
  { value: "to-TO", label: "Tonga" },
  { value: "ts-TS", label: "Tsonga" },
  { value: "tn-TN", label: "Tswana" },
  { value: "tr-TR", label: "Turkish" },
  { value: "tk-TK", label: "Turkmen" },
  { value: "tw-TW", label: "Twi" },
  { value: "ug-UG", label: "Uighur" },
  { value: "uk-UA", label: "Ukrainian" },
  { value: "ur-UR", label: "Urdu" },
  { value: "uz-UZ", label: "Uzbek" },
  { value: "ve-VE", label: "Venda" },
  { value: "vi-VN", label: "Vietnamese" },
  { value: "vo-VO", label: "Volapük" },
  { value: "wa-WA", label: "Walloon" },
  { value: "cy-CY", label: "Welsh" },
  { value: "fy-FY", label: "Western Frisian" },
  { value: "wo-WO", label: "Wolof" },
  { value: "xh-XH", label: "Xhosa" },
  { value: "yi-YI", label: "Yiddish" },
  { value: "yo-YO", label: "Yoruba" },
  { value: "za-ZA", label: "Zhuang" },
  { value: "zu-ZA", label: "Zulu" }
];

const castCountOptions = [
    { value: 0, label: '0 Members' },
    { value: 5, label: '5 Members' },
    { value: 10, label: '10 Members' },
    { value: 15, label: '15 Members' },
    { value: -1, label: 'Unlimited' } 
];

// Common timezones for the selector
const timezoneOptions = [
  { value: 'UTC', label: 'UTC (GMT+0)' },
  { value: 'America/New_York', label: 'Eastern Time (US & Canada)' },
  { value: 'America/Chicago', label: 'Central Time (US & Canada)' },
  { value: 'America/Denver', label: 'Mountain Time (US & Canada)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (US & Canada)' },
  { value: 'America/Anchorage', label: 'Alaska' },
  { value: 'Pacific/Honolulu', label: 'Hawaii' },
  { value: 'America/Phoenix', label: 'Arizona' },
  { value: 'America/Toronto', label: 'Toronto' },
  { value: 'America/Mexico_City', label: 'Mexico City' },
  { value: 'America/Sao_Paulo', label: 'Brasília' },
  { value: 'America/Argentina/Buenos_Aires', label: 'Buenos Aires' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Paris', label: 'Paris' },
  { value: 'Europe/Berlin', label: 'Berlin' },
  { value: 'Europe/Rome', label: 'Rome' },
  { value: 'Europe/Madrid', label: 'Madrid' },
  { value: 'Europe/Amsterdam', label: 'Amsterdam' },
  { value: 'Europe/Brussels', label: 'Brussels' },
  { value: 'Europe/Stockholm', label: 'Stockholm' },
  { value: 'Europe/Warsaw', label: 'Warsaw' },
  { value: 'Europe/Athens', label: 'Athens' },
  { value: 'Europe/Moscow', label: 'Moscow' },
  { value: 'Asia/Dubai', label: 'Dubai' },
  { value: 'Asia/Kolkata', label: 'India' },
  { value: 'Asia/Shanghai', label: 'Beijing/Shanghai' },
  { value: 'Asia/Hong_Kong', label: 'Hong Kong' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'Asia/Seoul', label: 'Seoul' },
  { value: 'Australia/Sydney', label: 'Sydney' },
  { value: 'Australia/Melbourne', label: 'Melbourne' },
  { value: 'Australia/Brisbane', label: 'Brisbane' },
  { value: 'Australia/Perth', label: 'Perth' },
  { value: 'Pacific/Auckland', label: 'Auckland' },
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

  const handleShowMetaProviderAttributionChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, showMetaProviderAttribution: checked }));
  };

  const handleCastCountChange = (value: string) => {
    const count = parseInt(value, 10);
    setConfig(prevConfig => ({ ...prevConfig, castCount: count === -1 ? undefined : count }));
  };

  const handleDisplayAgeRatingChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, displayAgeRating: checked }));
  };

  const handleMDBListTrackingChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, mdblistWatchTracking: checked }));
  };

  const handleAniListTrackingChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, anilistWatchTracking: checked }));
  };
  
  const handleSimklTrackingChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, simklWatchTracking: checked }));
  };

  const handleTraktTrackingChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, traktWatchTracking: checked }));
  };

  const handlePublicMetaDBTrackingChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, publicmetadbWatchTracking: checked }));
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
            <div className="flex items-center justify-between p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="mr-4">
                <Label htmlFor="language" className="font-medium">Display Language</Label>
                <p className="text-sm text-muted-foreground">Language for titles and descriptions.</p>
              </div>
              <Select value={config.language} onValueChange={handleLanguageChange}>
                <SelectTrigger id="language" className="w-[200px] shrink-0">
                  <SelectValue placeholder="Select language" />
                </SelectTrigger>
                <SelectContent>
                  {languageOptions.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="mr-4">
                <Label htmlFor="timezone" className="font-medium">Timezone</Label>
                <p className="text-sm text-muted-foreground">For calendar-based features (e.g., Trakt Calendar).</p>
              </div>
              <Select value={config.timezone || 'UTC'} onValueChange={handleTimezoneChange}>
                <SelectTrigger id="timezone" className="w-[240px] shrink-0">
                  <SelectValue placeholder="Select timezone" />
                </SelectTrigger>
                <SelectContent>
                  {timezoneOptions.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="mr-4">
                <Label htmlFor="cast-count" className="font-medium">Cast Members</Label>
                <p className="text-sm text-muted-foreground">Number of cast members on details page.</p>
              </div>
              <Select value={String(config.castCount ?? -1)} onValueChange={handleCastCountChange}>
                <SelectTrigger id="cast-count" className="w-[160px] shrink-0">
                  <SelectValue placeholder="Select count" />
                </SelectTrigger>
                <SelectContent>
                  {castCountOptions.map(opt => (
                    <SelectItem key={opt.value} value={String(opt.value)}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="mr-4">
                <Label htmlFor="show-prefix" className="font-medium">Show Prefix</Label>
                <p className="text-sm text-muted-foreground">Add "{config.addonName || 'AIOMetadata'} - " prefix to catalogs.</p>
              </div>
              <Switch id="show-prefix" checked={config.showPrefix} onCheckedChange={handleShowPrefixChange} />
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="mr-4">
                <Label htmlFor="show-meta-provider-attribution" className="font-medium">Meta Attribution</Label>
                <p className="text-sm text-muted-foreground">Show "[Meta provided by Provider]" in overview.</p>
              </div>
              <Switch id="show-meta-provider-attribution" checked={config.showMetaProviderAttribution} onCheckedChange={handleShowMetaProviderAttributionChange} />
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="mr-4">
                <Label htmlFor="display-age-rating" className="font-medium">Display Age Rating</Label>
                <p className="text-sm text-muted-foreground">Show rating/certification in genres.</p>
              </div>
              <Switch id="display-age-rating" checked={config.displayAgeRating} onCheckedChange={handleDisplayAgeRatingChange} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Content & Privacy</CardTitle>
            <CardDescription>Manage adult content, spoilers, and poster settings.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex items-center justify-between p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="mr-4">
                <Label htmlFor="adult-content" className="font-medium">Include Adult Content</Label>
                <p className="text-sm text-muted-foreground">Show NSFW content in catalogs and search.</p>
              </div>
              <Switch id="adult-content" checked={config.includeAdult} onCheckedChange={handleIncludeAdultChange} />
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="mr-4">
                <Label htmlFor="blur-thumbs" className="font-medium">Hide Episode Spoilers</Label>
                <p className="text-sm text-muted-foreground">Blur episode thumbnails to avoid spoilers.</p>
              </div>
              <Switch id="blur-thumbs" checked={config.blurThumbs} onCheckedChange={handleBlurThumbsChange} />
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="mr-4">
                <Label htmlFor="show-rate-me-button" className="font-medium">Show Rate Me Button</Label>
                <p className="text-sm text-muted-foreground">Display a rating button in meta pages.</p>
              </div>
              <Switch id="show-rate-me-button" checked={!!config.showRateMeButton} onCheckedChange={handleShowRateMeButtonChange} />
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="mr-4">
                <Label htmlFor="enable-rating-posters-for-library" className="font-medium">Rating Posters for Library</Label>
                <p className="text-sm text-muted-foreground">Keep rating posters for Continue Watching and Library items.</p>
              </div>
              <Switch id="enable-rating-posters-for-library" checked={config.enableRatingPostersForLibrary !== false} onCheckedChange={handleEnableRatingPostersForLibraryChange} />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Watch Tracking</CardTitle>
          <CardDescription>Automatically sync your watch progress to external services when you play content.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
            <div className="flex items-center justify-between p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="mr-4">
                <Label htmlFor="trakt-watch-tracking" className="font-medium">Trakt Checkin</Label>
                <p className="text-sm text-muted-foreground">Sync watch progress to Trakt.</p>
              </div>
              <Switch id="trakt-watch-tracking" checked={!!config.traktWatchTracking} onCheckedChange={handleTraktTrackingChange} />
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="mr-4">
                <Label htmlFor="simkl-watch-tracking" className="font-medium">Simkl Checkin</Label>
                <p className="text-sm text-muted-foreground">Sync watch progress to Simkl.</p>
              </div>
              <Switch id="simkl-watch-tracking" checked={!!config.simklWatchTracking} onCheckedChange={handleSimklTrackingChange} />
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="mr-4">
                <Label htmlFor="anilist-watch-tracking" className="font-medium">AniList Tracking</Label>
                <p className="text-sm text-muted-foreground">Sync anime watch progress to AniList.</p>
              </div>
              <Switch id="anilist-watch-tracking" checked={!!config.anilistWatchTracking} onCheckedChange={handleAniListTrackingChange} />
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="mr-4">
                <Label htmlFor="mdblist-watch-tracking" className="font-medium">MDBList Tracking</Label>
                <p className="text-sm text-muted-foreground">Sync watched status to MDBList.</p>
              </div>
              <Switch id="mdblist-watch-tracking" checked={!!config.mdblistWatchTracking} onCheckedChange={handleMDBListTrackingChange} />
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="mr-4">
                <Label htmlFor="publicmetadb-watch-tracking" className="font-medium">PublicMetaDB Tracking</Label>
                <p className="text-sm text-muted-foreground">Log plays to PublicMetaDB.</p>
              </div>
              <Switch id="publicmetadb-watch-tracking" checked={!!config.publicmetadbWatchTracking} onCheckedChange={handlePublicMetaDBTrackingChange} />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
