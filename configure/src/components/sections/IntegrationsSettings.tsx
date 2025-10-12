import React, { useState, useRef, useEffect } from 'react';
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
  const { config } = useConfig();
  const [validationStatus, setValidationStatus] = useState<Record<string, 'idle' | 'loading' | 'success' | 'error'>>({});
  const [isTesting, setIsTesting] = useState(false);
  
  // Track successfully validated keys to prevent re-testing unchanged keys
  const lastValidatedKeys = useRef<Record<string, string>>({});
  const [hasChangedKeys, setHasChangedKeys] = useState(true);
  
  // Check if any keys have changed since last successful validation
  useEffect(() => {
    const apiKeyFields: (keyof AppConfig['apiKeys'])[] = ['tmdb', 'tvdb', 'fanart', 'rpdb', 'mdblist'];
    
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
  
  const handleTestAllKeys = async () => {
    setIsTesting(true);
    const apiKeyFields: (keyof AppConfig['apiKeys'])[] = ['tmdb', 'tvdb', 'fanart', 'rpdb', 'mdblist'];
    
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
    const apiKeyFields: (keyof AppConfig['apiKeys'])[] = ['tmdb', 'tvdb', 'fanart', 'rpdb', 'mdblist'];
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
        {/* Gemini AI Search - Temporarily hidden */}
        {/* <ApiKeyInput 
          id="gemini" 
          label="Google Gemini API Key" 
          linkHref="https://aistudio.google.com/app/apikey" 
          validationStatus={validationStatus.gemini || 'idle'} 
          onKeyChange={handleKeyChange}
        /> */}
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