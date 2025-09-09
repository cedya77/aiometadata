import React, { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Eye, EyeOff, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { useConfig, AppConfig } from '@/contexts/ConfigContext';
import { toast } from 'sonner';

// --- Reusable Component for a single API key input field ---
const ApiKeyInput = ({
  id,
  label,
  linkHref,
  placeholder = "Paste your API key here",
}: {
  id: keyof AppConfig['apiKeys'];
  label: string;
  linkHref: string;
  placeholder?: string;
}) => {
  const { config, setConfig } = useConfig();
  const [showKey, setShowKey] = useState(false);
  const value = config.apiKeys[id];

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setConfig(prev => ({ ...prev, apiKeys: { ...prev.apiKeys, [id]: newValue } }));
  };

  return (
    // FIX: Use theme-aware hover effects
    <div className="flex items-center justify-between p-4 rounded-lg border border-transparent hover:border-border hover:bg-accent transition-colors">
      <div className="flex-1 space-y-1">
        <div className="flex items-center justify-between">
          <Label htmlFor={id} className="text-lg font-medium">{label}</Label>
          {/* FIX: Use a less vibrant, more theme-consistent link color */}
          <a href={linkHref} target="_blank" rel="noopener noreferrer" className="text-sm text-muted-foreground hover:text-foreground hover:underline">
            Get Key
          </a>
        </div>
        <div className="flex items-center space-x-2">
          {/* FIX: Remove all hard-coded colors from Input. It is already themed. */}
          <Input
            id={id}
            type={showKey ? 'text' : 'password'}
            value={value}
            onChange={handleChange}
            placeholder={placeholder}
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowKey(!showKey)}
            aria-label={showKey ? 'Hide key' : 'Show key'}
            className="text-muted-foreground hover:text-foreground"
          >
            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
};


export function IntegrationsSettings() {
  return (
    <div className="space-y-8 animate-fade-in">
      {/* Page Header */}
      <div>
        <h2 className="text-2xl font-semibold">Integrations & API Keys</h2>
        {/* FIX: Use theme-aware muted text color */}
        <p className="text-muted-foreground mt-1">Connect to external services. AI Search requires a Google Gemini key.</p>
      </div>

      {/* Settings Group */}
      <div className="space-y-4 max-w-2xl">
        <ApiKeyInput id="gemini" label="Google Gemini API Key" linkHref="https://aistudio.google.com/app/apikey" />
        <ApiKeyInput id="tmdb" label="TMDB API Key" linkHref="https://www.themoviedb.org/settings/api" />
        <ApiKeyInput id="tvdb" label="TheTVDB API Key" linkHref="https://thetvdb.com/api-information" />
        <ApiKeyInput id="fanart" label="Fanart.tv API Key" linkHref="https://fanart.tv/get-an-api-key/" />
        <ApiKeyInput id="rpdb" label="RPDB API Key" linkHref="https://ratingposterdb.com/" />
        <ApiKeyInput id="mdblist" label="MDBList API Key" linkHref="https://mdblist.com/preferences/#api_key_uid" />
      </div>
    </div>
  );
}
