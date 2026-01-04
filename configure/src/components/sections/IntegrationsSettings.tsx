import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Eye, EyeOff, CheckCircle, XCircle, Loader2, LogIn, LogOut, AlertCircle } from 'lucide-react';
import { useConfig, AppConfig } from '@/contexts/ConfigContext';
import { toast } from 'sonner';

const ApiKeyInput = ({
  id,
  label,
  linkHref,
  placeholder = "Paste your API key here",
  validationStatus = 'idle',
  onKeyChange
}: {
  id: keyof AppConfig['apiKeys'];
  label: string;
  linkHref: string;
  placeholder?: string;
  validationStatus?: 'idle' | 'loading' | 'success' | 'error';
  onKeyChange?: (id: keyof AppConfig['apiKeys']) => void;
}) => {
  const { config, setConfig } = useConfig();
  const [showKey, setShowKey] = useState(false);
  const value = config.apiKeys[id];
  
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setConfig(prev => ({ ...prev, apiKeys: { ...prev.apiKeys, [id]: newValue } }));
    // Notify parent component that this key has changed
    if (onKeyChange) {
      onKeyChange(id);
    }
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
  const { config, setConfig, sessionId, setSessionId, auth } = useConfig();
  const [validationStatus, setValidationStatus] = useState<Record<string, 'idle' | 'loading' | 'success' | 'error'>>({});
  const [isTesting, setIsTesting] = useState(false);
  const [tmdbAuthLoading, setTmdbAuthLoading] = useState(false);
  const [tmdbAuthError, setTmdbAuthError] = useState('');
  
  // Track successfully validated keys to prevent re-testing unchanged keys
  const lastValidatedKeys = useRef<Record<string, string>>({});
  const [hasChangedKeys, setHasChangedKeys] = useState(true);
  
  // Track if we've already processed a request token to prevent infinite loops
  const processedTokenRef = useRef<string | null>(null);

  const handlePosterProxyChange = (checked: boolean) => {
    setConfig(prev => ({ ...prev, usePosterProxy: checked }));
  };
  
  // Handle TMDB authentication callback - create session using user's API key
  const handleRequestToken = useCallback(async (requestToken: string) => {
    // Prevent processing the same token multiple times
    if (processedTokenRef.current === requestToken) {
      return;
    }
    
    processedTokenRef.current = requestToken;
    setTmdbAuthLoading(true);
    setTmdbAuthError('');
    
    const tmdbApiKey = config.apiKeys?.tmdb;
    
    if (!tmdbApiKey) {
      setTmdbAuthError("TMDB API key is required");
      toast.error("Please enter your TMDB API key first");
      setTmdbAuthLoading(false);
      return;
    }
    
    try {
      const sessionResponse = await fetch(
        `https://api.themoviedb.org/3/authentication/session/new?api_key=${tmdbApiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ request_token: requestToken })
        }
      );
      
      if (!sessionResponse.ok) {
        const errorData = await sessionResponse.json().catch(() => ({}));
        throw new Error(errorData.status_message || 'Failed to create session');
      }
      
      const sessionData = await sessionResponse.json();
      
      if (!sessionData.success) {
        throw new Error('Failed to create session with TMDB');
      }
      
      const newSessionId = sessionData.session_id;
      setSessionId(newSessionId);
      
      // Auto-save config if user is authenticated
      if (auth.authenticated && auth.userUUID && auth.password) {
        try {
          const configToSave = {
            ...config,
            sessionId: newSessionId,
            apiKeys: {
              ...config.apiKeys,
              customDescriptionBlurb: undefined
            }
          };
          
          const saveResponse = await fetch(`/api/config/update/${encodeURIComponent(auth.userUUID)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: configToSave, password: auth.password })
          });
          
          if (saveResponse.ok) {
            toast.success("TMDB session saved successfully!");
          } else {
            toast.warning("Session created but save failed. Please save your config manually.");
          }
        } catch (saveError) {
          console.error('Auto-save error:', saveError);
          toast.warning("Session created but save failed. Please save your config manually.");
        }
      } else {
        toast.info("Session created. Please save your configuration to persist it.");
      }
      
      window.history.replaceState({}, '', window.location.pathname);
      setTmdbAuthError('');
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "Failed to create TMDB session";
      setSessionId("");
      setTmdbAuthError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setTmdbAuthLoading(false);
    }
  }, [setSessionId, config, auth]);

  // Check for request_token in URL
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const requestToken = urlParams.get('request_token');

    if (requestToken && !processedTokenRef.current) {
      handleRequestToken(requestToken);
    }
  }, [handleRequestToken]);

  // Check if any keys have changed since last successful validation
  useEffect(() => {
    const apiKeyFields: (keyof AppConfig['apiKeys'])[] = ['gemini', 'tmdb', 'tvdb', 'fanart', 'rpdb', 'topPoster', 'mdblist'];
    
    let changed = false;
    for (const key of apiKeyFields) {
      const currentValue = config.apiKeys[key] || '';
      const lastValidated = lastValidatedKeys.current[key] || '';
      
      // If this key was previously validated successfully and has changed
      if (lastValidated && currentValue !== lastValidated) {
        changed = true;
        break;
      }
      // If this is a new key that wasn't tested before
      if (!lastValidated && currentValue) {
        changed = true;
        break;
      }
    }
    
    setHasChangedKeys(changed);
  }, [config.apiKeys]);
  
  const handleKeyChange = (id: keyof AppConfig['apiKeys']) => {
    // Reset validation status for this specific key when it changes
    setValidationStatus(prev => ({
      ...prev,
      [id]: 'idle'
    }));
  };

  const handleTmdbLogin = async () => {
    setTmdbAuthLoading(true);
    setTmdbAuthError('');

    const tmdbApiKey = config.apiKeys?.tmdb;
    
    if (!tmdbApiKey) {
      setTmdbAuthError("Please enter your TMDB API key first");
      toast.error("Please enter your TMDB API key first");
      setTmdbAuthLoading(false);
      return;
    }

    try {
      const response = await fetch(
        `https://api.themoviedb.org/3/authentication/token/new?api_key=${tmdbApiKey}`,
        { method: 'GET' }
      );
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.status_message || 'Failed to get request token');
      }
      
      const data = await response.json();
      
      if (!data.success) {
        throw new Error('Failed to get request token from TMDB');
      }
      
      const requestToken = data.request_token;
      
      // Construct redirect URL - use /stremio/{uuid}/configure format if authenticated
      let redirectUrl = window.location.href;
      if (auth.authenticated && auth.userUUID) {
        const origin = window.location.origin;
        redirectUrl = `${origin}/stremio/${auth.userUUID}/configure`;
      }
      
      const tmdbAuthUrl = `https://www.themoviedb.org/authenticate/${requestToken}?redirect_to=${encodeURIComponent(redirectUrl)}`;
      
      window.location.href = tmdbAuthUrl;
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "Failed to start TMDB authentication";
      setTmdbAuthError(errorMessage);
      toast.error(errorMessage);
      setTmdbAuthLoading(false);
    }
  };

  const handleTmdbLogout = () => {
    setSessionId("");
    toast.info("TMDB session cleared. Save your configuration to persist the change.");
  };
  
  const handleTestAllKeys = async () => {
    setIsTesting(true);
    const apiKeyFields: (keyof AppConfig['apiKeys'])[] = ['gemini', 'tmdb', 'tvdb', 'fanart', 'rpdb', 'topPoster', 'mdblist'];
    
    // Build the list of keys to test, excluding unchanged successfully validated ones
    const keysToTest: Record<string, string> = {};
    const skippedKeys: string[] = [];
    
    for (const key of apiKeyFields) {
      const currentValue = config.apiKeys[key];
      if (!currentValue || currentValue.trim() === "") continue;
      
      const lastValidated = lastValidatedKeys.current[key];
      
      // Skip if this key was already successfully validated and hasn't changed
      if (lastValidated === currentValue && validationStatus[key] === 'success') {
        skippedKeys.push(key);
        continue;
      }
      
      keysToTest[key] = currentValue;
    }
    
    if (Object.keys(keysToTest).length === 0 && skippedKeys.length === 0) {
      toast.info("No API keys to test.", { description: "Please enter at least one API key to validate." });
      setIsTesting(false);
      return;
    }
    
    if (Object.keys(keysToTest).length === 0 && skippedKeys.length > 0) {
      toast.info("All keys already validated.", { 
        description: "No changes detected since last successful validation." 
      });
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
      
      // Update validation status and track successfully validated keys
      for (const key of Object.keys(results)) {
        if (results[key] === true) {
          finalStatus[key] = 'success';
          successCount++;
          // Store the successfully validated key value
          lastValidatedKeys.current[key] = keysToTest[key];
        } else {
          finalStatus[key] = 'error';
          errorCount++;
          // Clear the last validated value for failed keys
          delete lastValidatedKeys.current[key];
        }
      }
      
      setValidationStatus(prev => ({ ...prev, ...finalStatus }));
      
      // Prepare the final message
      const totalTestedCount = successCount + errorCount;
      const skippedMessage = skippedKeys.length > 0 
        ? ` (${skippedKeys.length} unchanged key${skippedKeys.length > 1 ? 's' : ''} skipped)` 
        : '';
      
      if (errorCount > 0) {
        toast.warning(`${successCount} key(s) valid, ${errorCount} key(s) invalid${skippedMessage}`, {
          description: "Please check the invalid keys and try again."
        });
      } else {
        toast.success(`All ${totalTestedCount} key(s) are valid!${skippedMessage}`, {
          description: `Successfully validated ${successCount} key${successCount > 1 ? 's' : ''}.`
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
  
  // Determine button state and text
  const getButtonState = () => {
    const apiKeyFields: (keyof AppConfig['apiKeys'])[] = ['gemini', 'tmdb', 'tvdb', 'fanart', 'rpdb', 'topPoster', 'mdblist'];
    const hasAnyKeys = apiKeyFields.some(key => config.apiKeys[key] && config.apiKeys[key]!.trim() !== "");
    
    if (!hasAnyKeys) {
      return { disabled: false, text: "Test All Keys", variant: "default" };
    }
    
    if (!hasChangedKeys) {
      // Check if all non-empty keys are successfully validated
      const allValidated = apiKeyFields.every(key => {
        const value = config.apiKeys[key];
        if (!value || value.trim() === "") return true; // Skip empty keys
        return validationStatus[key] === 'success' && lastValidatedKeys.current[key] === value;
      });
      
      if (allValidated) {
        return { disabled: true, text: "All Keys Validated", variant: "success" };
      }
    }
    
    return { disabled: false, text: "Test All Keys", variant: "default" };
  };
  
  const buttonState = getButtonState();
  
  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-semibold">Integrations & API Keys</h2>
        <p className="text-muted-foreground mt-1">
          Connect to external services to enhance metadata quality.
        </p>
      </div>
      
      {/* Inputs */}
      <div className="space-y-4 max-w-2xl">
        <ApiKeyInput 
          id="gemini" 
          label="Google Gemini API Key" 
          linkHref="https://aistudio.google.com/app/apikey" 
          validationStatus={validationStatus.gemini || 'idle'} 
          onKeyChange={handleKeyChange}
        />
        <div className="space-y-3">
          <ApiKeyInput 
            id="tmdb" 
            label="TMDB API Key" 
            linkHref="https://www.themoviedb.org/settings/api" 
            validationStatus={validationStatus.tmdb || 'idle'} 
            onKeyChange={handleKeyChange}
          />
          {/* TMDB Authentication */}
          <div className="ml-4 p-4 rounded-lg border border-border bg-muted/30">
            <div className="flex items-center justify-between mb-2">
              <Label className="text-sm font-medium">TMDB Authentication</Label>
              <span className="text-xs text-muted-foreground">Required for watchlist & favorites</span>
            </div>
            {tmdbAuthError && !sessionId && (
              <div className="mb-3 p-2 rounded-md bg-destructive/10 border border-destructive/20 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0" />
                <span className="text-sm text-destructive">{tmdbAuthError}</span>
              </div>
            )}
            {sessionId ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-green-500" />
                  <span className="text-sm text-muted-foreground">Authenticated</span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTmdbLogout}
                  disabled={tmdbAuthLoading}
                >
                  <LogOut className="h-3 w-3 mr-1" />
                  Logout
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={handleTmdbLogin}
                disabled={tmdbAuthLoading || !config.apiKeys?.tmdb}
              >
                {tmdbAuthLoading ? (
                  <>
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  <>
                    <LogIn className="h-3 w-3 mr-1" />
                    Login with TMDB
                  </>
                )}
              </Button>
            )}
            {!config.apiKeys?.tmdb && (
              <p className="text-xs text-muted-foreground mt-2">
                Enter a TMDB API key above to enable authentication
              </p>
            )}
          </div>
        </div>
        <ApiKeyInput 
          id="tvdb" 
          label="TheTVDB API Key" 
          linkHref="https://thetvdb.com/api-information" 
          validationStatus={validationStatus.tvdb || 'idle'} 
          onKeyChange={handleKeyChange}
        />
        <ApiKeyInput 
          id="fanart" 
          label="Fanart.tv API Key" 
          linkHref="https://fanart.tv/get-an-api-key/" 
          validationStatus={validationStatus.fanart || 'idle'} 
          onKeyChange={handleKeyChange}
        />
        {/* Poster Rating Provider Selection */}
        <div className="flex items-center justify-between p-4 rounded-lg border border-transparent hover:border-border hover:bg-accent transition-colors">
          <div className="flex-1">
            <Label htmlFor="posterRatingProvider" className="text-lg font-medium">Poster Rating Provider</Label>
            <p className="text-sm text-muted-foreground mt-1">
              Choose which service to use for rating overlays on posters
            </p>
          </div>
          <Select 
            value={config.posterRatingProvider || 'rpdb'} 
            onValueChange={(value) => setConfig(prev => ({ ...prev, posterRatingProvider: value as 'rpdb' | 'top' }))}
          >
            <SelectTrigger id="posterRatingProvider" className="w-[200px]">
              <SelectValue placeholder="Select provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rpdb">RatingPosterDB (RPDB)</SelectItem>
              <SelectItem value="top">Top Poster API</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* ADD: Proxy Toggle */}
        <div className="flex items-center justify-between p-4 rounded-lg border border-transparent hover:border-border hover:bg-accent transition-colors">
          <div className="flex-1">
            <Label htmlFor="usePosterProxy" className="text-lg font-medium">Proxy Rating Posters</Label>
            <p className="text-sm text-muted-foreground mt-1">
              Route rating poster requests through this addon. This allows fallback posters to be used if the RPDB/Top Poster API is down or does not have a poster for that item. It can however cause a minimal slowdown due to having to contact AIOMetadata first.
            </p>
          </div>
          <Switch
            id="usePosterProxy"
            checked={!!config.usePosterProxy} // CHANGED: Default false, so check truthiness
            onCheckedChange={handlePosterProxyChange}
          />
        </div>
        
        {config.posterRatingProvider !== 'top' ? (
          <ApiKeyInput 
            id="rpdb" 
            label="RPDB API Key" 
            linkHref="https://ratingposterdb.com/" 
            validationStatus={validationStatus.rpdb || 'idle'} 
            onKeyChange={handleKeyChange}
          />
        ) : (
          <ApiKeyInput 
            id="topPoster" 
            label="Top Poster API Key" 
            linkHref="https://api.top-streaming.stream/user/register" 
            validationStatus={validationStatus.topPoster || 'idle'} 
            onKeyChange={handleKeyChange}
          />
        )}
        <ApiKeyInput 
          id="mdblist" 
          label="MDBList API Key" 
          linkHref="https://mdblist.com/preferences/#api_key_uid" 
          validationStatus={validationStatus.mdblist || 'idle'} 
          onKeyChange={handleKeyChange}
        />
      </div>
      
      {/* Test Button */}
      <div className="max-w-2xl pt-2">
        <button
          onClick={handleTestAllKeys}
          disabled={isTesting || buttonState.disabled}
          className={`inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 border border-input h-10 px-4 py-2 w-full sm:w-auto ${
            buttonState.variant === 'success' 
              ? 'cursor-not-allowed'
              : 'bg-background hover:bg-accent hover:text-accent-foreground'
          }`}
        >
          {isTesting ? (
            <>
              <Loader2 className="animate-spin" />
              Testing Keys...
            </>
          ) : buttonState.variant === 'success' ? (
            <>
              <CheckCircle className="text-green-500" />
              {buttonState.text}
            </>
          ) : (
            <>
              <CheckCircle className="text-muted-foreground" />
              {buttonState.text}
            </>
          )}
        </button>
      </div>
    </div>
  );
}