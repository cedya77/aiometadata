import { useState, useEffect, useMemo } from "react";
import { useConfig } from "@/contexts/ConfigContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertCircle, CheckCircle, Copy, Loader2, Save, Key, User, Download, Eye, EyeOff, List } from "lucide-react";
import { toast } from "sonner";
import { InstallDialog } from "@/components/InstallDialog";
import { ConfigImportExport } from "@/components/ConfigImportExport";
import { Switch } from "@/components/ui/switch";

interface ConfigurationManagerProps {
  children?: React.ReactNode;
}

interface SavedConfig {
  userUUID: string;
  installUrl: string;
}

export function ConfigurationManager({ children }: ConfigurationManagerProps) {
  const { config, setConfig, auth, setAuth, hasBuiltInTvdb, hasBuiltInTmdb, isLoading: contextLoading } = useConfig();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [savedConfig, setSavedConfig] = useState<SavedConfig | null>(null);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [isInstallOpen, setIsInstallOpen] = useState(false);
  const [installUrl, setInstallUrl] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [addonPassword, setAddonPassword] = useState("");
  const [requireAddonPassword, setRequireAddonPassword] = useState(false);
  const [showLoadDialog, setShowLoadDialog] = useState(false);
  const [loadPassword, setLoadPassword] = useState("");
  const [loadAddonPassword, setLoadAddonPassword] = useState("");
  const [loadError, setLoadError] = useState("");
  const [isLoadingLoad, setIsLoadingLoad] = useState(false);
  const [isUUIDTrusted, setIsUUIDTrusted] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/config/addon-info")
      .then(res => res.json())
      .then(data => setRequireAddonPassword(!!data.requiresAddonPassword))
      .catch(() => setRequireAddonPassword(false));
  }, []);

  // Auto-load config if userUUID is in URL but not authenticated
  useEffect(() => {
    if (auth.userUUID && !auth.authenticated) {
      // Show password dialog to load config
      setShowPasswordDialog(true);
    }
  }, [auth.userUUID, auth.authenticated]);

  useEffect(() => {
    if (savedConfig?.userUUID && savedConfig.userUUID.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      fetch(`/api/config/is-trusted/${encodeURIComponent(savedConfig.userUUID)}`)
        .then(res => res.json())
        .then(data => {
          setIsUUIDTrusted(!!data.trusted);
          setRequireAddonPassword(!!data.requiresAddonPassword);
        })
        .catch(() => {
          setIsUUIDTrusted(null);
          setRequireAddonPassword(false);
        });
    } else {
      setIsUUIDTrusted(null);
      setRequireAddonPassword(false);
    }
  }, [savedConfig?.userUUID]);

  const validateRequiredKeys = () => {
    // Don't validate until context is loaded
    if (contextLoading) {
      return { valid: true };
    }
    
    
    const requiredKeys = ['tmdb'];
    
    // Check if fanart is selected in any art provider (handles both legacy and new formats)
    const isFanartSelected = (() => {
      const artProviders = config.artProviders;
      if (!artProviders) return false;
      
      return ['movie', 'series', 'anime'].some(contentType => {
        const provider = artProviders[contentType];
        
        // Handle legacy string format
        if (typeof provider === 'string') {
          return provider === 'fanart';
        }
        
        // Handle new nested object format
        if (typeof provider === 'object' && provider !== null) {
          return provider.poster === 'fanart' || 
                 provider.background === 'fanart' || 
                 provider.logo === 'fanart';
        }
        
        return false;
      });
    })();
    
    if (isFanartSelected && !requiredKeys.includes('fanart')) {
      requiredKeys.push('fanart');
    }
    const missingKeys = requiredKeys.filter(key => {
      if (key === 'tmdb') {
        // TMDB is required unless there's a built-in key
        const hasUserKey = config.apiKeys.tmdb?.trim();
        return !hasUserKey && !hasBuiltInTmdb;
      }
      return !config.apiKeys?.[key] || config.apiKeys[key].trim() === '';
    });
    if (missingKeys.length > 0) {
      return {
        valid: false,
        missingKeys,
        message: `Missing required API keys: ${missingKeys.join(', ')}`
      };
    }
    return { valid: true };
  };

  const handleSaveConfiguration = async () => {
    setIsLoading(true);
    setError("");
    const validation = validateRequiredKeys();
    if (!validation.valid) {
      setError(validation.message);
      setIsLoading(false);
      return;
    }
    const isAuthenticated = auth.authenticated && auth.userUUID && auth.password;
    try {
      const response = isAuthenticated
        ? await fetch(`/api/config/update/${encodeURIComponent(auth.userUUID!)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config, password: auth.password, addonPassword })
          })
        : await fetch('/api/config/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config, password, addonPassword })
          });
      if (!response.ok) {
        let message = 'Failed to save configuration';
        try {
          const errorData = await response.json();
          message = errorData?.error || message;
        } catch (_) {
          const text = await response.text();
          if (text) message = text;
        }
        throw new Error(message);
      }
      let result: any;
      try {
        result = await response.json();
      } catch (_) {
        const text = await response.text();
        throw new Error(text || 'Invalid JSON response from server');
      }
      setSavedConfig(result);
      if (!isAuthenticated && result?.userUUID) {
        setAuth({ authenticated: true, userUUID: result.userUUID, password });
      }
      setShowPasswordDialog(false);
      setPassword("");
      setConfirmPassword("");
      setAddonPassword("");
      toast.success("Configuration saved successfully!");
    } catch (err) {
      console.error('Save configuration error:', err);
      setError(err instanceof Error ? err.message : 'Failed to save configuration');
    } finally {
      setIsLoading(false);
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied to clipboard!`);
    } catch (err) {
      console.error('Copy failed:', err);
      toast.error('Failed to copy to clipboard');
    }
  };

  const handleLoadConfiguration = async () => {
    if (!savedConfig?.userUUID) return;
    setIsLoadingLoad(true);
    setLoadError("");
    try {
      const response = await fetch(`/api/config/load/${savedConfig.userUUID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: loadPassword, addonPassword: loadAddonPassword })
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to load configuration');
      }
      const result = await response.json();
      toast.success("Configuration loaded successfully!");
      setShowLoadDialog(false);
      setLoadPassword("");
      setLoadAddonPassword("");
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load configuration');
    } finally {
      setIsLoadingLoad(false);
    }
  };

  const handleLoadFromUrl = async () => {
    if (!auth.userUUID) return;
    setIsLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/config/load/${auth.userUUID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const success = response.ok;
      if (success) {
        setAuth({ authenticated: true, userUUID: auth.userUUID, password });
        setShowPasswordDialog(false);
        setPassword("");
        setAddonPassword("");
        toast.success("Configuration loaded successfully!");
      } else {
        setError("Invalid password or configuration not found");
      }
    } catch (err) {
      console.error('Load from URL error:', err);
      setError(err instanceof Error ? err.message : 'Failed to load configuration');
    } finally {
      setIsLoading(false);
    }
  };

  const validation = useMemo(() => validateRequiredKeys(), [config, hasBuiltInTmdb, hasBuiltInTvdb, contextLoading]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            Configuration Status
          </CardTitle>
          <CardDescription>
            Check your configuration status and save it to the database
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>API Keys Status</Label>
            <div className="space-y-2">
              {[
                { key: 'tmdb', name: 'TMDB' },
                { key: 'tvdb', name: 'TVDB' },
                { key: 'mdblist', name: 'MDBList' },
                { key: 'fanart', name: 'Fanart' }
              ].map(({ key, name }) => {
                const hasUserKey = config.apiKeys?.[key]?.trim();
                const hasBuiltInKey = key === 'tmdb' ? hasBuiltInTmdb : (key === 'tvdb' ? hasBuiltInTvdb : false);
                const isConfigured = hasUserKey || hasBuiltInKey;
                
                // Check if this key is actually being used
                const isInUse = (() => {
                  if (key === 'tmdb') return true; // Always required
                  if (key === 'tvdb') {
                    // Check if TVDB is used in providers or art providers
                    const isTvdbInProviders = 
                      config.providers?.movie === 'tvdb' ||
                      config.providers?.series === 'tvdb' ||
                      config.providers?.anime === 'tvdb';
                    
                    const isTvdbInArt = ['movie', 'series', 'anime'].some(contentType => {
                      const provider = config.artProviders?.[contentType];
                      if (typeof provider === 'string') {
                        return provider === 'tvdb';
                      }
                      if (typeof provider === 'object' && provider !== null) {
                        return provider.poster === 'tvdb' || 
                               provider.background === 'tvdb' || 
                               provider.logo === 'tvdb';
                      }
                      return false;
                    });
                    
                    return isTvdbInProviders || isTvdbInArt;
                  }
                  if (key === 'mdblist') {
                    // Check if MDBList is used in catalogs
                    return config.catalogs?.some(c => c.id.startsWith('mdblist.'));
                  }
                  if (key === 'fanart') {
                    // Check if fanart is used in art providers
                    const artProviders = config.artProviders;
                    if (!artProviders) return false;
                    
                    return ['movie', 'series', 'anime'].some(contentType => {
                      const provider = artProviders[contentType];
                      if (typeof provider === 'string') {
                        return provider === 'fanart';
                      }
                      if (typeof provider === 'object' && provider !== null) {
                        return provider.poster === 'fanart' || 
                               provider.background === 'fanart' || 
                               provider.logo === 'fanart';
                      }
                      return false;
                    });
                  }
                  return false;
                })();
                
                const isRequired = key === 'tmdb' || isInUse;
                
                return (
                  <div key={key} className="flex items-center justify-between py-2 border-b border-gray-200 last:border-b-0">
                    <div className="flex items-center gap-3">
                      {isConfigured ? (
                        <CheckCircle className="h-4 w-4 text-green-500" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-red-500" />
                      )}
                      <div>
                        <span className="text-sm font-medium">{name}</span>
                        <span className="text-xs text-gray-500 ml-2">
                          {isRequired ? 'Required' : 'Optional'}
                        </span>
                      </div>
                    </div>
                    <div className="text-sm">
                      {isConfigured ? (
                        <span className="text-green-600 font-medium">Configured</span>
                      ) : (
                        <span className="text-red-600 font-medium">Missing</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="space-y-3">
            {!validation.valid && (
              <p className="text-sm text-red-600">
                Please configure all required API keys before saving
              </p>
            )}
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-md">
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-red-500" />
                  <span className="text-sm text-red-700">{error}</span>
                </div>
              </div>
            )}
            
            {/* Catalog Mode Only Toggle */}
            <div className="flex items-center justify-between p-4 border rounded-lg bg-muted/50">
              <div className="flex items-center gap-3">
                <List className="h-5 w-5 text-muted-foreground" />
                <div>
                  <Label htmlFor="catalog-mode-only" className="text-sm font-medium cursor-pointer">
                    Catalog Mode Only
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Remove metadata resource from manifest (catalogs only, no item details). Useful when adding multiple instances of AIOMetadata to an app.
                  </p>
                </div>
              </div>
              <Switch
                id="catalog-mode-only"
                checked={config.catalogModeOnly ?? false}
                onCheckedChange={(checked) => {
                  setConfig(prev => ({
                    ...prev,
                    catalogModeOnly: checked
                  }));
                }}
              />
            </div>
            
            <div className="flex justify-end">
              <Dialog open={!auth.authenticated && showPasswordDialog} onOpenChange={setShowPasswordDialog}>
              <Button
                disabled={!validation.valid || isLoading}
                className="flex items-center gap-2"
                onClick={() => {
                  if (!validation.valid || isLoading) return;
                  
                  setError("");
                  
                  // Check if TVDB is being used anywhere
                  const isTvdbInProviders = 
                    config.providers?.movie === 'tvdb' ||
                    config.providers?.series === 'tvdb' ||
                    config.providers?.anime === 'tvdb';
                  
                  const isTvdbInArt = ['movie', 'series', 'anime'].some(contentType => {
                    const provider = config.artProviders?.[contentType];
                    if (typeof provider === 'string') {
                      return provider === 'tvdb';
                    }
                    if (typeof provider === 'object' && provider !== null) {
                      return provider.poster === 'tvdb' || 
                             provider.background === 'tvdb' || 
                             provider.logo === 'tvdb';
                    }
                    return false;
                  });
                  
                  // Only validate TVDB key if TVDB is actually being used
                  if (isTvdbInProviders || isTvdbInArt) {
                    const hasTvdbKey = !!config.apiKeys?.tvdb?.trim() || hasBuiltInTvdb;
                    if (!hasTvdbKey) {
                      setError("TVDB is selected as a provider but no TVDB API key is configured. Please add your TVDB API key in the Integrations tab or choose a different provider.");
                      return;
                    }
                  }
                  
                  if (auth.authenticated) {
                    void handleSaveConfiguration();
                  } else {
                    setShowPasswordDialog(true);
                  }
                }}
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Save Configuration
              </Button>
              <DialogContent>
                <DialogHeader>
                   <DialogTitle>{auth.userUUID ? 'Load Configuration' : 'Create Password'}</DialogTitle>
                  <DialogDescription>
                    {auth.userUUID 
                      ? 'Enter your password to load your existing configuration.'
                      : 'Create a password to protect your configuration. You\'ll need this password to access your configuration later.'
                    }
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  {error && (
                    <div className="p-3 bg-red-50 border border-red-200 rounded-md">
                      <div className="flex items-center gap-2">
                        <AlertCircle className="h-4 w-4 text-red-500" />
                        <span className="text-sm text-red-700">{error}</span>
                      </div>
                    </div>
                  )}
                   <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <div className="relative">
                      <Input
                        id="password"
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Enter your password"
                        minLength={6}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="absolute right-2 top-1/2 -translate-y-1/2"
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Password must be at least 6 characters long.</p>
                  </div>
                   {!auth.userUUID && (
                     <div className="space-y-2">
                       <Label htmlFor="confirmPassword">Confirm Password</Label>
                       <div className="relative">
                         <Input
                           id="confirmPassword"
                           type={showConfirmPassword ? "text" : "password"}
                           value={confirmPassword}
                           onChange={(e) => setConfirmPassword(e.target.value)}
                           placeholder="Confirm your password"
                           minLength={6}
                         />
                         <Button
                           variant="ghost"
                           size="sm"
                           className="absolute right-2 top-1/2 -translate-y-1/2"
                           onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                         >
                           {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                         </Button>
                       </div>
                       <p className="text-xs text-muted-foreground mt-1">Must match the password above and be at least 6 characters.</p>
                     </div>
                   )}
                  {requireAddonPassword && (
                    <div className="space-y-2">
                      <Label htmlFor="addonPassword">Addon Password</Label>
                      <Input
                        id="addonPassword"
                        type="password"
                        value={addonPassword}
                        onChange={e => setAddonPassword(e.target.value)}
                        placeholder="Enter the addon password"
                        minLength={6}
                      />
                      <p className="text-xs text-muted-foreground mt-1">Required by the addon administrator.</p>
                    </div>
                  )}
                  <div className="flex justify-end gap-2">
                    <Button 
                      variant="outline" 
                      onClick={() => setShowPasswordDialog(false)}
                    >
                      Cancel
                    </Button>
                    <Button 
                      onClick={auth.userUUID ? handleLoadFromUrl : handleSaveConfiguration}
                      disabled={isLoading || password.length < 6 || (!auth.userUUID && password !== confirmPassword)}
                    >
                      {isLoading ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          {auth.userUUID ? 'Loading...' : 'Saving...'}
                        </>
                      ) : (
                        auth.userUUID ? 'Load Configuration' : 'Save Configuration'
                      )}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
            </div>
          </div>
        </CardContent>
      </Card>
      {savedConfig && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              Your Configuration
            </CardTitle>
            <CardDescription>
              Save these credentials to access your configuration later
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <div>
                <Label className="text-sm font-medium">Your UUID</Label>
                <div className="flex items-center gap-2 mt-1">
                  <Input 
                    value={savedConfig.userUUID} 
                    readOnly 
                    className="font-mono text-sm"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyToClipboard(savedConfig.userUUID, 'UUID')}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div>
                <Label className="text-sm font-medium">Install URL</Label>
                <div className="flex items-center gap-2 mt-1">
                  <Input 
                    value={savedConfig.installUrl} 
                    readOnly 
                    className="font-mono text-sm"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyToClipboard(savedConfig.installUrl, 'Install URL')}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-blue-500 mt-0.5" />
                <span className="text-sm text-blue-700">
                  <strong>Important:</strong> Save your UUID and password. You'll need both to access your configuration later.
                </span>
              </div>
            </div>
            <div className="flex gap-2">
              <Dialog open={showLoadDialog} onOpenChange={setShowLoadDialog}>
                <Button
                  variant="outline"
                  onClick={() => setShowLoadDialog(true)}
                  disabled={isLoading}
                >
                  Load Configuration
                </Button>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Load Configuration</DialogTitle>
                    <DialogDescription>
                      Enter your password{requireAddonPassword && isUUIDTrusted === false ? ' and addon password' : ''} to load your configuration.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    {loadError && (
                      <div className="p-3 bg-red-50 border border-red-200 rounded-md">
                        <div className="flex items-center gap-2">
                          <AlertCircle className="h-4 w-4 text-red-500" />
                          <span className="text-sm text-red-700">{loadError}</span>
                        </div>
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label htmlFor="loadPassword">Password</Label>
                      <Input
                        id="loadPassword"
                        type="password"
                        value={loadPassword}
                        onChange={e => setLoadPassword(e.target.value)}
                        placeholder="Enter your password"
                        minLength={6}
                      />
                      <p className="text-xs text-muted-foreground mt-1">Password must be at least 6 characters long.</p>
                    </div>
                    {requireAddonPassword && isUUIDTrusted === false && (
                      <div className="space-y-2">
                        <Label htmlFor="loadAddonPassword">Addon Password</Label>
                        <Input
                          id="loadAddonPassword"
                          type="password"
                          value={loadAddonPassword}
                          onChange={e => setLoadAddonPassword(e.target.value)}
                          placeholder="Enter the addon password"
                          minLength={6}
                        />
                        <p className="text-xs text-muted-foreground mt-1">Required by the addon administrator.</p>
                      </div>
                    )}
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        onClick={() => {
                          setShowLoadDialog(false);
                          setLoadPassword("");
                          setLoadAddonPassword("");
                          setLoadError("");
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        onClick={handleLoadConfiguration}
                        disabled={isLoadingLoad || loadPassword.length < 6}
                      >
                        {isLoadingLoad ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Loading...
                          </>
                        ) : (
                          'Load Configuration'
                        )}
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
              <Button onClick={() => { setInstallUrl(savedConfig.installUrl); setIsInstallOpen(true); }}>
                <Download className="h-4 w-4 mr-2" /> Install
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      
      {/* Import/Export Section */}
      <ConfigImportExport />
      
      {children}
      <InstallDialog isOpen={isInstallOpen} onClose={() => setIsInstallOpen(false)} manifestUrl={installUrl} />
    </div>
  );
}
