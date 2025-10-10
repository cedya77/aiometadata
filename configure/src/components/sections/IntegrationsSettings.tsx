import React, { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Eye, EyeOff, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { useConfig, AppConfig } from '@/contexts/ConfigContext';
import { toast } from 'sonner';

const ApiKeyInput = ({
  id,
  label,
  linkHref,
  placeholder = "Paste your API key here",
  validationStatus = 'idle'
}: {
  id: keyof AppConfig['apiKeys'];
  label: string;
  linkHref: string;
  placeholder?: string;
  validationStatus?: 'idle' | 'loading' | 'success' | 'error';
}) => {
  const { config, setConfig } = useConfig();
  const [showKey, setShowKey] = useState(false);
  const value = config.apiKeys[id];

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setConfig(prev => ({ ...prev, apiKeys: { ...prev.apiKeys, [id]: newValue } }));
  };

  return (
    <div className="flex items-center justify-between p-4 rounded-lg border border-transparent hover:border-border hover:bg-accent transition-colors">
      <div className="flex-1 space-y-1">
        <div className="flex items-center justify-between">
          <Label htmlFor={id} className="text-lg font-medium">{label}</Label>
          <a
            href={linkHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            Get Key
          </a>
        </div>
        <div className="flex items-center space-x-2">
          <Input
            id={id}
            type={showKey ? 'text' : 'password'}
            value={value}
            onChange={handleChange}
            placeholder={placeholder}
          />
          <div className="w-6 h-6 flex items-center justify-center">
            {validationStatus === 'loading' && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
            {validationStatus === 'success' && <CheckCircle className="h-5 w-5 text-green-500" />}
            {validationStatus === 'error' && <XCircle className="h-5 w-5 text-red-500" />}
          </div>
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
  const { config } = useConfig();
  const [validationStatus, setValidationStatus] = useState<Record<string, 'idle' | 'loading' | 'success' | 'error'>>({});
  const [isTesting, setIsTesting] = useState(false);

  const handleTestAllKeys = async () => {
    setIsTesting(true);

    const keysToTest = Object.entries(config.apiKeys)
      .filter(([_, value]) => value && value.trim() !== "")
      .reduce((obj, [key, value]) => {
        obj[key] = value as string;
        return obj;
      }, {} as Record<string, string>);

    if (Object.keys(keysToTest).length === 0) {
      toast.info("No API keys to test.", { description: "Please enter at least one API key." });
      setIsTesting(false);
      return;
    }

    const initialStatus: Record<string, 'idle' | 'loading' | 'success' | 'error'> = {};
    for (const key of Object.keys(keysToTest)) {
      initialStatus[key] = 'loading';
    }
    setValidationStatus(prev => ({ ...prev, ...initialStatus }));

    try {
      const response = await fetch('/api/test-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKeys: keysToTest })
      });

      if (!response.ok) throw new Error('Server responded with an error.');

      const { results } = await response.json();

      const finalStatus: Record<string, 'idle' | 'loading' | 'success' | 'error'> = {};
      let successCount = 0;
      let errorCount = 0;

      for (const key of Object.keys(results)) {
        if (results[key] === true) {
          finalStatus[key] = 'success';
          successCount++;
        } else {
          finalStatus[key] = 'error';
          errorCount++;
        }
      }

      setValidationStatus(prev => ({ ...prev, ...finalStatus }));

      if (errorCount > 0) {
        toast.warning(`${successCount} key(s) valid, ${errorCount} key(s) invalid.`, {
          description: "Please check the invalid keys and try again."
        });
      } else {
        toast.success("All API keys are valid!", {
          description: `${successCount} key(s) tested successfully.`
        });
      }

    } catch (error) {
      toast.error("Failed to test keys.", {
        description: error instanceof Error ? error.message : "An unknown error occurred."
      });
      const errorStatus: Record<string, 'idle' | 'loading' | 'success' | 'error'> = {};
      for (const key of Object.keys(keysToTest)) {
        errorStatus[key] = 'idle';
      }
      setValidationStatus(prev => ({ ...prev, ...errorStatus }));
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-semibold">Integrations & API Keys</h2>
        <p className="text-muted-foreground mt-1">
          Connect to external services. AI Search requires a Google Gemini key.
        </p>
      </div>

      {/* Inputs */}
      <div className="space-y-4 max-w-2xl">
        <ApiKeyInput id="gemini" label="Google Gemini API Key" linkHref="https://aistudio.google.com/app/apikey" validationStatus={validationStatus.gemini || 'idle'} />
        <ApiKeyInput id="tmdb" label="TMDB API Key" linkHref="https://www.themoviedb.org/settings/api" validationStatus={validationStatus.tmdb || 'idle'} />
        <ApiKeyInput id="tvdb" label="TheTVDB API Key" linkHref="https://thetvdb.com/api-information" validationStatus={validationStatus.tvdb || 'idle'} />
        <ApiKeyInput id="fanart" label="Fanart.tv API Key" linkHref="https://fanart.tv/get-an-api-key/" validationStatus={validationStatus.fanart || 'idle'} />
        <ApiKeyInput id="rpdb" label="RPDB API Key" linkHref="https://ratingposterdb.com/" validationStatus={validationStatus.rpdb || 'idle'} />
        <ApiKeyInput id="mdblist" label="MDBList API Key" linkHref="https://mdblist.com/preferences/#api_key_uid" validationStatus={validationStatus.mdblist || 'idle'} />
      </div>

      {/* Button now at the bottom */}
      <div className="max-w-2xl pt-2">
        <button
          onClick={handleTestAllKeys}
          disabled={isTesting}
          className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-10 px-4 py-2 w-full sm:w-auto"
        >
          {isTesting ? (
            <>
              <Loader2 className="animate-spin" />
              Testing Keys...
            </>
          ) : (
            <>
              <CheckCircle className="text-muted-foreground" />
              Test All Keys
            </>
          )}
        </button>
      </div>
    </div>
  );
}
