import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Eye, EyeOff, CheckCircle, XCircle, Loader2, LogIn, LogOut, AlertCircle } from 'lucide-react';
import { useConfig, AppConfig } from '@/contexts/ConfigContext';
import { toast } from 'sonner';

type KeyValidationResultStatus = 'valid' | 'invalid' | 'timeout' | 'error';

interface KeyValidationDetail {
  status: KeyValidationResultStatus;
  reason?: string;
  message?: string;
  durationMs?: number;
}

interface KeyValidationSummary {
  totalCount: number;
  validCount: number;
  failedCount: number;
  testedKeys: string[];
  validKeys: string[];
  invalidKeys: string[];
  invalidNonQuotaKeys: string[];
  quotaExhaustedKeys: string[];
  timeoutKeys: string[];
  errorKeys: string[];
  failureLines: string[];
}

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
  // Track known-bad keys (definitive invalid keys, excluding temporary failures).
  const lastKnownBadKeys = useRef<Record<string, string>>({});
  const [hasChangedKeys, setHasChangedKeys] = useState(true);
  
  // Track if we've already processed a request token to prevent infinite loops
  const processedTokenRef = useRef<string | null>(null);

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
      const lastKnownBad = lastKnownBadKeys.current[key] || '';
      
      if (!currentValue) {
        // If a previously checked key was removed, treat as changed.
        if (lastValidated || lastKnownBad) {
          changed = true;
          break;
        }
        continue;
      }

      const matchesKnownGood = currentValue === lastValidated;
      const matchesKnownBad = currentValue === lastKnownBad;

      // If current value is not a known checked value, it changed.
      if (!matchesKnownGood && !matchesKnownBad) {
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
    // Clear stored state for this key so a changed value is re-tested.
    delete lastValidatedKeys.current[id];
    delete lastKnownBadKeys.current[id];
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
    // Conditionally include rpdb or topPoster based on selected provider
    const posterKeyToTest = config.posterRatingProvider === 'top' ? 'topPoster' : 'rpdb';
    const apiKeyFields: (keyof AppConfig['apiKeys'])[] = ['gemini', 'openrouter', 'tmdb', 'tvdb', 'fanart', posterKeyToTest, 'mdblist'];
    
    // Build the list of keys to test, excluding unchanged successfully validated ones
    const keysToTest: Record<string, string> = {};
    const skippedValidKeys: string[] = [];
    const skippedKnownBadKeys: string[] = [];
    
    for (const key of apiKeyFields) {
      const currentValue = config.apiKeys[key];
      if (!currentValue || currentValue.trim() === "") continue;
      
      const lastValidated = lastValidatedKeys.current[key];
      const lastKnownBad = lastKnownBadKeys.current[key];
      
      // Skip if this key was already successfully validated and hasn't changed
      if (lastValidated === currentValue && validationStatus[key] === 'success') {
        skippedValidKeys.push(key);
        continue;
      }

      // Skip if this key is a known invalid key and hasn't changed
      if (lastKnownBad === currentValue && validationStatus[key] === 'error') {
        skippedKnownBadKeys.push(key);
        continue;
      }
      
      keysToTest[key] = currentValue;
    }
    
    if (Object.keys(keysToTest).length === 0 && skippedValidKeys.length === 0 && skippedKnownBadKeys.length === 0) {
      toast.info("No API keys to test.", { description: "Please enter at least one API key to validate." });
      setIsTesting(false);
      return;
    }
    
    if (Object.keys(keysToTest).length === 0 && (skippedValidKeys.length > 0 || skippedKnownBadKeys.length > 0)) {
      toast.info("No changed keys to test.", {
        description: "All entered keys are unchanged from their last check."
      });
      setIsTesting(false);
      return;
    }
    
    const initialStatus: Record<string, 'idle' | 'loading' | 'success' | 'error'> = {};
    for (const key of Object.keys(keysToTest)) {
      initialStatus[key] = 'loading';
    }
    setValidationStatus(prev => ({ ...prev, ...initialStatus }));

    const controller = new AbortController();
    const requestTimeout = window.setTimeout(() => controller.abort(), 20000);
    
    try {
      const response = await fetch('/api/test-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKeys: keysToTest }),
        signal: controller.signal,
      });
      
      const payload: {
        details?: Record<string, KeyValidationDetail>;
        summary?: KeyValidationSummary;
        error?: string;
      } = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || 'Server responded with an error.');
      }

      if (!payload?.details || typeof payload.details !== 'object' || !payload?.summary || typeof payload.summary !== 'object') {
        throw new Error('Invalid API response: missing key validation details/summary.');
      }

      const detailsFromApi: Record<string, KeyValidationDetail> = payload.details;
      const summary = payload.summary;
      const detailsForTestedKeys: Record<string, KeyValidationDetail> = {};

      for (const key of Object.keys(keysToTest)) {
        const detail = detailsFromApi[key];
        detailsForTestedKeys[key] =
          detail && typeof detail === 'object'
            ? detail
            : { status: 'error', message: 'Missing key status in API response.' };
      }

      const finalStatus: Record<string, 'idle' | 'loading' | 'success' | 'error'> = {};
      
      // Update validation status and track successfully validated keys
      for (const key of Object.keys(detailsForTestedKeys)) {
        const detail = detailsForTestedKeys[key];
        if (detail.status === 'valid') {
          finalStatus[key] = 'success';
          // Store the successfully validated key value
          lastValidatedKeys.current[key] = keysToTest[key];
          delete lastKnownBadKeys.current[key];
        } else {
          finalStatus[key] = 'error';
          if (detail.status === 'invalid' && detail.reason !== 'quota_exhausted') {
            // Known bad key (definitive invalid). Skip retesting until value changes.
            lastKnownBadKeys.current[key] = keysToTest[key];
          } else {
            // Transient failure (timeout/error/quota), allow future retesting.
            delete lastKnownBadKeys.current[key];
          }
          // Clear the last validated value for failed keys
          delete lastValidatedKeys.current[key];
        }
      }
      
      setValidationStatus(prev => ({ ...prev, ...finalStatus }));
      
      // Prepare the final message
      const newlyValidatedCount = typeof summary.validCount === 'number' ? summary.validCount : 0;
      const alreadyValidatedCount = skippedValidKeys.length;
      const successCount = newlyValidatedCount + alreadyValidatedCount;
      const knownBadCount = skippedKnownBadKeys.length;
      const errorCount = (typeof summary.failedCount === 'number' ? summary.failedCount : 0) + knownBadCount;
      const totalTestedCount = successCount + errorCount;
      
      if (errorCount > 0) {
        const failureDetailLines = Array.isArray(summary.failureLines)
          ? summary.failureLines.filter((line): line is string => typeof line === 'string' && line.trim() !== '')
          : [];

        toast.warning(`${successCount} key(s) valid, ${errorCount} key(s) failed`, {
          description: failureDetailLines.join('\n'),
          descriptionClassName: 'whitespace-pre-line'
        });
      } else {
        toast.success(`All ${totalTestedCount} key(s) are valid!`, {
          description: `Successfully validated ${successCount} key${successCount > 1 ? 's' : ''}.`
        });
      }
    } catch (error) {
      const isAbortError = error instanceof DOMException && error.name === 'AbortError';
      toast.error("Failed to test keys.", {
        description: isAbortError
          ? "The validation request timed out. Please try again."
          : (error instanceof Error ? error.message : "An unknown error occurred.")
      });
      const errorStatus: Record<string, 'idle' | 'loading' | 'success' | 'error'> = {};
      for (const key of Object.keys(keysToTest)) {
        errorStatus[key] = isAbortError ? 'error' : 'idle';
      }
      setValidationStatus(prev => ({ ...prev, ...errorStatus }));
    } finally {
      window.clearTimeout(requestTimeout);
      setIsTesting(false);
    }
  };
  
  // Determine button state and text
  const getButtonState = () => {
    // Conditionally include rpdb or topPoster based on selected provider
    const posterKeyToTest = config.posterRatingProvider === 'top' ? 'topPoster' : 'rpdb';
    const apiKeyFields: (keyof AppConfig['apiKeys'])[] = ['gemini', 'openrouter', 'tmdb', 'tvdb', 'fanart', posterKeyToTest, 'mdblist'];
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

      return { disabled: true, text: "No Key Changes", variant: "default" };
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
        <ApiKeyInput
          id="openrouter"
          label="OpenRouter API Key"
          linkHref="https://openrouter.ai/keys"
          validationStatus={validationStatus.openrouter || 'idle'}
          onKeyChange={handleKeyChange}
        />
        <ApiKeyInput 
          id="tmdb" 
          label="TMDB API Key" 
          linkHref="https://www.themoviedb.org/settings/api" 
          validationStatus={validationStatus.tmdb || 'idle'} 
          onKeyChange={handleKeyChange}
        />
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
        <ApiKeyInput
          id="rpdb"
          label="RPDB API Key"
          linkHref="https://ratingposterdb.com/"
          validationStatus={validationStatus.rpdb || 'idle'}
          onKeyChange={handleKeyChange}
        />
        <ApiKeyInput
          id="topPoster"
          label="TOP Posters API Key"
          linkHref="https://api.top-streaming.stream/user/dashboard"
          validationStatus={validationStatus.topPoster || 'idle'}
          onKeyChange={handleKeyChange}
        />
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
