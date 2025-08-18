import { useState, useEffect } from "react";
import { useConfig } from "@/contexts/ConfigContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertCircle, CheckCircle, Copy, Loader2, Save, Key, User, Download, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { InstallDialog } from "@/components/InstallDialog";

interface ConfigurationManagerProps {
  children?: React.ReactNode;
}

interface SavedConfig {
  userUUID: string;
  installUrl: string;
  compressedConfig: string;
}

export function ConfigurationManager({ children }: ConfigurationManagerProps) {
  const { config, auth, setAuth } = useConfig();
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
  // Add state for load dialog and fields
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

  // Add effect to check trust status when savedConfig?.userUUID changes (for load dialog)
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

  // Check if required API keys are provided
  const validateRequiredKeys = () => {
    const requiredKeys = ['tmdb', 'tvdb'];
    
    // Check if Fanart is selected as any art provider
    const isFanartSelected = config.artProviders?.movie === 'fanart' || 
                            config.artProviders?.series === 'fanart' || 
                            config.artProviders?.anime === 'fanart';
    
    // Add fanart to required keys if it's selected as an art provider
    if (isFanartSelected && !requiredKeys.includes('fanart')) {
      requiredKeys.push('fanart');
    }
    
    const missingKeys = requiredKeys.filter(key => !config.apiKeys?.[key] || config.apiKeys[key].trim() === '');
    
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

    // Validate required API keys
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
        // Try JSON first, then fall back to text
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

      // Parse success response robustly
      let result: any;
      try {
        result = await response.json();
      } catch (_) {
        const text = await response.text();
        throw new Error(text || 'Invalid JSON response from server');
      }
      setSavedConfig(result);
      // If this was a new config creation, mark user as authenticated
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
      // TODO: update config context with loaded config if needed
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load configuration');
    } finally {
      setIsLoadingLoad(false);
    }
  };

  const validation = validateRequiredKeys();

  return (
    <div className="space-y-6">
      {/* Configuration Status */}
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
          {/* API Keys Validation */}
          <div className="space-y-2">
            <Label>Required API Keys</Label>
            <div className="space-y-2">
              {['tmdb', 'tvdb'].map(key => (
                <div key={key} className="flex items-center gap-2">
                  {config.apiKeys?.[key] ? (
                    <CheckCircle className="h-4 w-4 text-green-500" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-red-500" />
                  )}
                  <span className="text-sm font-medium">{key.toUpperCase()}</span>
                  {config.apiKeys?.[key] ? (
                    <span className="text-sm text-green-600">✓ Configured</span>
                  ) : (
                    <span className="text-sm text-red-600">✗ Missing</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Save Configuration Button */}
          <div className="flex justify-between items-center">
            <div>
              {!validation.valid && (
                <p className="text-sm text-red-600">
                  Please configure all required API keys before saving
                </p>
              )}
            </div>
            <Dialog open={!auth.authenticated && showPasswordDialog} onOpenChange={setShowPasswordDialog}>
              <Button
                disabled={!validation.valid || isLoading}
                className="flex items-center gap-2"
                onClick={() => {
                  if (!validation.valid || isLoading) return;
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
                   <DialogTitle>Create Password</DialogTitle>
                  <DialogDescription>
                    Create a password to protect your configuration. You'll need this password to access your configuration later.
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
                      onClick={handleSaveConfiguration}
                      disabled={isLoading || password.length < 6 || password !== confirmPassword}
                    >
                      {isLoading ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Saving...
                        </>
                      ) : (
                        'Save Configuration'
                      )}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </CardContent>
      </Card>

      {/* Saved Configuration Display */}
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

      {children}
      <InstallDialog isOpen={isInstallOpen} onClose={() => setIsInstallOpen(false)} manifestUrl={installUrl} />
    </div>
  );
}
