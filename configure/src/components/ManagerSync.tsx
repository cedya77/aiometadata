import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { RefreshCw, Loader2, ChevronDown } from "lucide-react";
import { useConfig } from "@/contexts/ConfigContext";

interface ManagerDef {
  id: string;
  name: string;
  endpoint: string;
  urlPlaceholder: string;
  keyHint: string;
  description: string;
  publicInstances?: { name: string; url: string }[];
}

const MANAGERS: ManagerDef[] = [
  {
    id: 'aiomanager',
    name: 'AIOManager',
    endpoint: '/api/aiomanager/reinstall',
    urlPlaceholder: 'https://aio.example.com',
    keyHint: 'Your AIOManager user UUID (settings → API access)',
    description: 'Installs or updates this addon in your AIOManager account and propagates it to all your connected platforms.',
    publicInstances: [
      { name: 'Elfhosted', url: 'https://aiomanager.elfhosted.com' },
      { name: "Midnight's", url: 'https://aiomanagerfortheweebs.midnightignite.me' },
      { name: "Yeb's", url: 'https://aiomanager.fortheweak.cloud' },
      { name: "Kuu's", url: 'https://aiomanager.stremio.ru' },
    ],
  },
];

const CUSTOM_INSTANCE = 'custom';

const SYNC_BUTTON_CLASSES = "border-violet-400/30 bg-violet-500/15 text-violet-600 dark:text-violet-300 hover:bg-violet-500/25 hover:text-violet-700 dark:hover:text-violet-200";

interface ManagerSyncProps {
  manifestUrl: string;
  onSynced?: () => void;
}

export function ManagerSync({ manifestUrl, onSynced }: ManagerSyncProps) {
  const { config, setConfig, auth } = useConfig();
  const [activeManager, setActiveManager] = useState<ManagerDef | null>(null);
  const [selectedInstance, setSelectedInstance] = useState(CUSTOM_INSTANCE);
  const [instanceUrl, setInstanceUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [remember, setRemember] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    if (activeManager) {
      const saved = config.managers?.[activeManager.id];
      const savedUrl = saved?.instanceUrl || '';
      const publicMatch = activeManager.publicInstances?.find(i => i.url === savedUrl);
      setSelectedInstance(publicMatch ? publicMatch.url : CUSTOM_INSTANCE);
      setInstanceUrl(publicMatch ? '' : savedUrl);
      setApiKey(saved?.apiKey || '');
    }
  }, [activeManager, config.managers]);

  const handleSync = async () => {
    if (!activeManager) return;
    const effectiveUrl = selectedInstance === CUSTOM_INSTANCE ? instanceUrl : selectedInstance;
    const trimmedUrl = effectiveUrl.trim().replace(/\/+$/, '');
    const trimmedKey = apiKey.trim();
    if (!trimmedUrl || !trimmedKey) {
      toast.error(`Enter your ${activeManager.name} instance URL and API key.`);
      return;
    }
    setIsSyncing(true);
    try {
      const response = await fetch(activeManager.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceUrl: trimmedUrl, apiKey: trimmedKey, addonUrl: manifestUrl })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || `Sync failed (${response.status})`);
      }
      setConfig(prev => ({
        ...prev,
        managers: { ...prev.managers, [activeManager.id]: { instanceUrl: trimmedUrl, apiKey: trimmedKey } }
      }));
      if (remember && auth.authenticated && auth.userUUID && auth.password) {
        const saveResponse = await fetch('/api/managers/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userUUID: auth.userUUID,
            password: auth.password,
            managerId: activeManager.id,
            instanceUrl: trimmedUrl,
            apiKey: trimmedKey
          })
        });
        if (!saveResponse.ok) {
          toast.warning("Synced, but failed to remember the credentials.");
        }
      }
      toast.success(`Addon synced to ${activeManager.name}!`);
      setActiveManager(null);
      onSynced?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to sync to ${activeManager.name}`);
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <>
      {MANAGERS.length === 1 ? (
        <Button variant="outline" className={SYNC_BUTTON_CLASSES} onClick={() => setActiveManager(MANAGERS[0])}>
          <RefreshCw className="h-4 w-4 mr-2" /> Sync to {MANAGERS[0].name}
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className={SYNC_BUTTON_CLASSES}>
              <RefreshCw className="h-4 w-4 mr-2" /> Sync to Manager <ChevronDown className="h-4 w-4 ml-2" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {MANAGERS.map((manager) => (
              <DropdownMenuItem key={manager.id} onClick={() => setActiveManager(manager)}>
                {manager.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Dialog open={!!activeManager} onOpenChange={(open) => { if (!open) setActiveManager(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Sync to {activeManager?.name}</DialogTitle>
            <DialogDescription>
              {activeManager?.description}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="manager-instance">Instance</Label>
              {activeManager?.publicInstances?.length ? (
                <Select value={selectedInstance} onValueChange={setSelectedInstance}>
                  <SelectTrigger id="manager-instance">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {activeManager.publicInstances.map((instance) => (
                      <SelectItem key={instance.url} value={instance.url}>
                        {instance.name} <span className="text-muted-foreground">({instance.url.replace('https://', '')})</span>
                      </SelectItem>
                    ))}
                    <SelectItem value={CUSTOM_INSTANCE}>Custom URL…</SelectItem>
                  </SelectContent>
                </Select>
              ) : null}
              {(selectedInstance === CUSTOM_INSTANCE || !activeManager?.publicInstances?.length) && (
                <Input
                  id="manager-url"
                  placeholder={activeManager?.urlPlaceholder}
                  value={instanceUrl}
                  onChange={(e) => setInstanceUrl(e.target.value)}
                />
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="manager-key">Account API key</Label>
              <Input
                id="manager-key"
                type="password"
                placeholder={activeManager?.keyHint}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="manager-remember" className="text-sm text-muted-foreground">
                Remember credentials in my configuration
              </Label>
              <Switch
                id="manager-remember"
                checked={remember}
                onCheckedChange={setRemember}
              />
            </div>
            <Button
              className="w-full"
              onClick={handleSync}
              disabled={isSyncing}
            >
              {isSyncing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Syncing…
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" /> Sync
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
