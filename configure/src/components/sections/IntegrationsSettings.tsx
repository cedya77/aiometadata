// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import React, { useState, useRef, useEffect } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Eye, EyeOff, CheckCircle, XCircle, Loader2 } from 'lucide-react';
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
  onKeyChange,
  forceShow
}: {
  id: keyof AppConfig['apiKeys'];
  label: string;
  linkHref: string;
  placeholder?: string;
  validationStatus?: 'idle' | 'loading' | 'success' | 'error';
  onKeyChange?: (id: keyof AppConfig['apiKeys']) => void;
  forceShow?: boolean;
}) => {
  const { config, setConfig } = useConfig();
  const [showKey, setShowKey] = useState(false);
  const visible = forceShow ?? showKey;
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
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor={id} className="font-medium">{label}</Label>
          <a
            href={linkHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            Get Key
          </a>
        </div>
        <div className="flex items-center space-x-2">
          <Input
            id={id}
            type={visible ? 'text' : 'password'}
            value={value}
            onChange={handleChange}
            placeholder={placeholder}
          />
          <div className="w-6 h-6 flex items-center justify-center shrink-0">
            {validationStatus === 'loading' && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
            {validationStatus === 'success' && <CheckCircle className="h-5 w-5 text-green-500" />}
            {validationStatus === 'error' && <XCircle className="h-5 w-5 text-red-500" />}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowKey(!showKey)}
            aria-label={visible ? 'Hide key' : 'Show key'}
            className="text-muted-foreground hover:text-foreground shrink-0"
          >
            {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

export function IntegrationsSettings() {
  const { config } = useConfig();
  const [validationStatus, setValidationStatus] = useState<Record<string, 'idle' | 'loading' | 'success' | 'error'>>({});
  const [isTesting, setIsTesting] = useState(false);
  const [showAllKeys, setShowAllKeys] = useState(false);
  // Track successfully validated keys to prevent re-testing unchanged keys
  const lastValidatedKeys = useRef<Record<string, string>>({});
  // Track known-bad keys (definitive invalid keys, excluding temporary failures).
  const lastKnownBadKeys = useRef<Record<string, string>>({});
  const [hasChangedKeys, setHasChangedKeys] = useState(true);
  
  // Check if any keys have changed since last successful validation
  useEffect(() => {
    const apiKeyFields: (keyof AppConfig['apiKeys'])[] = ['gemini', 'openrouter', 'tmdb', 'tvdb', 'fanart', 'rpdb', 'topPoster', 'mdblist', 'publicmetadb'];

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

  const handleTestAllKeys = async () => {
    setIsTesting(true);
    const apiKeyFields: (keyof AppConfig['apiKeys'])[] = ['gemini', 'openrouter', 'tmdb', 'tvdb', 'fanart', 'rpdb', 'topPoster', 'mdblist', 'publicmetadb'];
    
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
    const apiKeyFields: (keyof AppConfig['apiKeys'])[] = ['gemini', 'openrouter', 'tmdb', 'tvdb', 'fanart', 'rpdb', 'topPoster', 'mdblist', 'publicmetadb'];
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
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold">Integrations & API Keys</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAllKeys(!showAllKeys)}
            className="text-muted-foreground hover:text-foreground gap-1.5 shrink-0"
          >
            {showAllKeys ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {showAllKeys ? 'Hide All' : 'Show All'}
          </Button>
        </div>
        <p className="text-muted-foreground mt-1">
          Connect to external services to enhance metadata quality.
        </p>
      </div>
      
      {/* Inputs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ApiKeyInput
          id="gemini"
          label="Google Gemini API Key"
          linkHref="https://aistudio.google.com/app/apikey"
          validationStatus={validationStatus.gemini || 'idle'}
          onKeyChange={handleKeyChange}
          forceShow={showAllKeys || undefined}
        />
        <ApiKeyInput
          id="openrouter"
          label="OpenRouter API Key"
          linkHref="https://openrouter.ai/keys"
          validationStatus={validationStatus.openrouter || 'idle'}
          onKeyChange={handleKeyChange}
          forceShow={showAllKeys || undefined}
        />
        <ApiKeyInput 
          id="tmdb" 
          label="TMDB API Key" 
          linkHref="https://www.themoviedb.org/settings/api" 
          validationStatus={validationStatus.tmdb || 'idle'} 
          onKeyChange={handleKeyChange}
          forceShow={showAllKeys || undefined}
        />
        <ApiKeyInput 
          id="tvdb" 
          label="TheTVDB API Key" 
          linkHref="https://thetvdb.com/api-information" 
          validationStatus={validationStatus.tvdb || 'idle'} 
          onKeyChange={handleKeyChange}
          forceShow={showAllKeys || undefined}
        />
        <ApiKeyInput 
          id="fanart" 
          label="Fanart.tv API Key" 
          linkHref="https://fanart.tv/get-an-api-key/" 
          validationStatus={validationStatus.fanart || 'idle'} 
          onKeyChange={handleKeyChange}
          forceShow={showAllKeys || undefined}
        />
        <ApiKeyInput
          id="rpdb"
          label="RPDB API Key"
          linkHref="https://ratingposterdb.com/"
          validationStatus={validationStatus.rpdb || 'idle'}
          onKeyChange={handleKeyChange}
          forceShow={showAllKeys || undefined}
        />
        <ApiKeyInput
          id="topPoster"
          label="TOP Posters API Key"
          linkHref="https://api.top-posters.com/user/dashboard"
          validationStatus={validationStatus.topPoster || 'idle'}
          onKeyChange={handleKeyChange}
          forceShow={showAllKeys || undefined}
        />
        <ApiKeyInput
          id="mdblist"
          label="MDBList API Key"
          linkHref="https://mdblist.com/preferences/#api_key_uid"
          validationStatus={validationStatus.mdblist || 'idle'}
          onKeyChange={handleKeyChange}
          forceShow={showAllKeys || undefined}
        />
        <ApiKeyInput
          id="publicmetadb"
          label="PublicMetaDB API Key"
          linkHref="https://publicmetadb.com"
          validationStatus={validationStatus.publicmetadb || 'idle'}
          onKeyChange={handleKeyChange}
          forceShow={showAllKeys || undefined}
        />
      </div>
      
      {/* Test Button */}
      <div className="pt-2">
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
