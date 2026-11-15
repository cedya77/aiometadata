import { useState, useMemo, useRef, useCallback, type KeyboardEvent } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Key,
  Lock,
  RotateCcw,
  Save,
  Settings,
  Eye,
  EyeOff,
  RefreshCw,
  Shield,
  Zap,
  Database,
  Gauge,
  Flame,
  Server,
  Globe,
  Activity,
  Calendar,
  Loader2,
  X,
  Plus,
  Image,
  Palette,
  LayoutGrid,
  Snowflake,
  Puzzle,
  Search,
  Download,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import {
  type SettingItem,
  type SettingsImportResult,
  useUpdateSetting,
  useResetSetting,
  useExportSettings,
  useImportSettings,
} from "@/hooks/useDashboardQueries";
import { RestartManager } from "./RestartManager";

interface DashboardSettingsProps {
  data: { settings: SettingItem[]; canRestart?: boolean; bootId?: string } | null | undefined;
}

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  "API Keys": <Key className="h-4 w-4" />,
  "OAuth": <Shield className="h-4 w-4" />,
  "Sign-In & Access": <Lock className="h-4 w-4" />,
  "Appearance": <Palette className="h-4 w-4" />,
  "Catalogs & Search": <LayoutGrid className="h-4 w-4" />,
  "Images & Art": <Image className="h-4 w-4" />,
  "Providers": <Puzzle className="h-4 w-4" />,
  "Cache": <Database className="h-4 w-4" />,
  "Cold Store": <Snowflake className="h-4 w-4" />,
  "Warming: Popular": <Flame className="h-4 w-4" />,
  "Warming: Full": <Flame className="h-4 w-4" />,
  "Warming: MAL": <Flame className="h-4 w-4" />,
  "Rate Limits": <Gauge className="h-4 w-4" />,
  "Data Updates": <Calendar className="h-4 w-4" />,
  "Proxy": <Globe className="h-4 w-4" />,
  "Diagnostics": <Activity className="h-4 w-4" />,
  "Server & Storage": <Server className="h-4 w-4" />,
};

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  "API Keys": "Third-party API keys for metadata providers",
  "OAuth": "OAuth credentials for the services users link their accounts to",
  "Sign-In & Access": "Who can reach the config page and dashboard, and how they authenticate",
  "Appearance": "Addon name, logo and description shown to users",
  "Catalogs & Search": "Catalog limits, page sizes and search behavior",
  "Images & Art": "Poster, logo and backdrop caching, the art proxy, and image warming",
  "Providers": "Per-provider endpoints, credentials and pacing",
  "Cache": "Cache lifetimes, compression and cleanup",
  "Cold Store": "On-disk tier for settled metadata that rarely changes",
  "Warming: Popular": "Background warming for trending and popular content",
  "Warming: Full": "Full catalog warming for specific users",
  "Warming: MAL": "MyAnimeList catalog warming",
  "Rate Limits": "Request throttling and concurrency ceilings",
  "Data Updates": "Intervals for refreshing external id mappings",
  "Proxy": "HTTP and SOCKS proxy routing",
  "Features": "Optional surfaces the addon can expose, off unless turned on",
  "Diagnostics": "Logging, health checks and monitoring",
  "Server & Storage": "Ports, database and Redis. Most of these need a restart",
};

const CATEGORY_ORDER = [
  "API Keys", "OAuth", "Sign-In & Access",
  "Appearance", "Catalogs & Search", "Images & Art", "Providers",
  "Features",
  "Cache", "Cold Store",
  "Warming: Popular", "Warming: Full", "Warming: MAL",
  "Rate Limits", "Data Updates", "Proxy", "Diagnostics", "Server & Storage",
];

function TagsInput({
  value,
  onChange,
  disabled,
  settingKey,
  maxTags,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  settingKey: string;
  maxTags?: number | null;
}) {
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const isUuid = settingKey === "CACHE_WARMUP_UUIDS";

  const tags = useMemo(
    () => value.split(",").map((t) => t.trim()).filter(Boolean),
    [value]
  );

  const atLimit = !!maxTags && tags.length >= maxTags;

  const commitTag = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed || tags.includes(trimmed)) {
      setInputValue("");
      return;
    }
    if (maxTags && tags.length >= maxTags) {
      setInputValue("");
      return;
    }
    const next = [...tags, trimmed].join(",");
    onChange(next);
    setInputValue("");
  }, [inputValue, tags, onChange, maxTags]);

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitTag();
    }
    if (e.key === "Backspace" && !inputValue && tags.length) {
      const next = tags.slice(0, -1).join(",");
      onChange(next);
    }
  }

  function removeTag(idx: number) {
    const next = tags.filter((_, i) => i !== idx).join(",");
    onChange(next);
  }

  function displayTag(tag: string) {
    if (isUuid && tag.length > 12) return tag.slice(0, 8) + "...";
    return tag;
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-1.5 min-h-[2rem] rounded-md border border-input bg-background px-2 py-1 flex-1 min-w-0 sm:flex-none sm:w-72 ${
        disabled ? "opacity-50 pointer-events-none" : ""
      }`}
      onClick={() => inputRef.current?.focus()}
    >
      {tags.map((tag, idx) => (
        <span
          key={idx}
          className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-xs font-mono"
          title={tag}
        >
          {displayTag(tag)}
          {!disabled && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); removeTag(idx); }}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      {!disabled && !atLimit && (
        <input
          ref={inputRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commitTag}
          placeholder={tags.length === 0 ? "Add value..." : ""}
          className="flex-1 min-w-[80px] bg-transparent text-xs font-mono outline-none placeholder:text-muted-foreground"
        />
      )}
      {maxTags && (
        <span className={`text-[10px] ml-auto ${atLimit ? "text-orange-400" : "text-muted-foreground"}`}>
          {tags.length}/{maxTags}
        </span>
      )}
    </div>
  );
}

function SettingRow({ setting }: { setting: SettingItem }) {
  const [localValue, setLocalValue] = useState(setting.value);
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<
    { kind: "update"; value: string; reason: string } | { kind: "reset"; reason: string } | null
  >(null);
  const updateMutation = useUpdateSetting();
  const resetMutation = useResetSetting();
  const prevServerValue = useRef(setting.value);

  if (setting.value !== prevServerValue.current) {
    prevServerValue.current = setting.value;
    setLocalValue(setting.value);
  }

  const isDisabled = !!setting.disabledReason;
  const isReadOnly = setting.envOnly || isDisabled;
  const hasChanged = localValue !== setting.value;
  const maskedValue = setting.sensitive && setting.value
    ? (setting.value.length <= 4 ? "••••" : "••••••" + setting.value.slice(-4))
    : "";
  const displayValue = setting.sensitive && !revealed && !hasChanged ? maskedValue : localValue;

  function needsConfirmation(err: any, pending: { kind: "update"; value: string } | { kind: "reset" }): boolean {
    if (!err?.requiresConfirmation) return false;
    setPendingConfirm({ ...pending, reason: err.reason || "This change affects your own access." });
    return true;
  }

  async function handleSave() {
    setSaving(true);
    try {
      await updateMutation.mutateAsync({ key: setting.key, value: localValue });
      toast.success(`${setting.label} updated`);
    } catch (err: any) {
      if (!needsConfirmation(err, { kind: "update", value: localValue })) {
        toast.error(err.message || "Failed to save");
        setLocalValue(setting.value);
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    try {
      await resetMutation.mutateAsync({ key: setting.key });
      toast.success(`${setting.label} reset to default`);
    } catch (err: any) {
      if (!needsConfirmation(err, { kind: "reset" })) {
        toast.error(err.message || "Failed to reset");
      }
    }
  }

  async function handleConfirmed() {
    if (!pendingConfirm) return;
    const pending = pendingConfirm;
    setPendingConfirm(null);
    try {
      if (pending.kind === "update") {
        await updateMutation.mutateAsync({ key: setting.key, value: pending.value, confirm: true });
        toast.success(`${setting.label} updated`);
      } else {
        await resetMutation.mutateAsync({ key: setting.key, confirm: true });
        toast.success(`${setting.label} reset to default`);
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to save");
      setLocalValue(setting.value);
    }
  }

  function handleReveal() {
    setRevealed(!revealed);
    if (!revealed) {
      setLocalValue(setting.value);
    }
  }

  return (
    <div className={`flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4 py-4 border-b border-border/50 last:border-0 transition-opacity ${isDisabled ? "opacity-40" : ""}`}>
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{setting.label}</span>
          <code className="text-[10px] px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground font-mono">
            {setting.key}
          </code>
          {isDisabled && (
            <Badge variant="outline" className="text-[10px] gap-1 bg-red-500/10 text-red-400 border-red-500/30">
              {setting.disabledReason}
            </Badge>
          )}
          {setting.envOnly && !isDisabled && (
            <Badge variant="outline" className="text-[10px] gap-1 bg-slate-500/10 text-slate-400 border-slate-500/30">
              <Lock className="h-2.5 w-2.5" /> ENV ONLY
            </Badge>
          )}
          {!setting.envOnly && !isDisabled && setting.hasEnvVar && !setting.hasDbOverride && (
            <Badge variant="outline" className="text-[10px] gap-1 bg-amber-500/10 text-amber-400 border-amber-500/30">
              FROM ENV
            </Badge>
          )}
          {setting.requiresRestart && !isDisabled && (
            <Badge variant="outline" className="text-[10px] gap-1 bg-orange-500/10 text-orange-400 border-orange-500/30">
              <RefreshCw className="h-2.5 w-2.5" /> RESTART
            </Badge>
          )}
          {setting.hasDbOverride && !isDisabled && (
            <Badge variant="outline" className="text-[10px] gap-1 bg-blue-500/10 text-blue-400 border-blue-500/30">
              OVERRIDE
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {setting.description}
          {(setting.min != null || setting.max != null) && (
            <span className="text-muted-foreground/60">
              {" "}({[
                setting.min != null && `min ${setting.min}`,
                setting.max != null && `max ${setting.max}`,
              ].filter(Boolean).join(", ")})
            </span>
          )}
        </p>
      </div>

      <div className="flex items-center gap-2 w-full sm:w-auto sm:shrink-0">
        {setting.uiHint === "tags" ? (
          <div className="flex items-center gap-1.5 w-full sm:w-auto">
            <TagsInput
              value={localValue}
              onChange={setLocalValue}
              disabled={isReadOnly}
              settingKey={setting.key}
              maxTags={setting.maxTags}
            />
            {hasChanged && !isReadOnly && (
              <Button size="sm" variant="ghost" onClick={handleSave} disabled={saving} className="h-8 px-2">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              </Button>
            )}
          </div>
        ) : setting.type === "boolean" ? (
          <Switch
            checked={localValue === "true"}
            disabled={isReadOnly}
            onCheckedChange={(checked) => {
              const val = String(checked);
              setLocalValue(val);
              updateMutation.mutate(
                { key: setting.key, value: val },
                {
                  onSuccess: () => toast.success(`${setting.label} updated`),
                  onError: (err: any) => {
                    if (needsConfirmation(err, { kind: "update", value: val })) return;
                    toast.error(err.message || "Failed to save");
                    setLocalValue(setting.value);
                  },
                }
              );
            }}
          />
        ) : setting.type === "select" && setting.options ? (
          <Select
            value={localValue}
            disabled={isReadOnly}
            onValueChange={(val) => {
              setLocalValue(val);
              updateMutation.mutate(
                { key: setting.key, value: val },
                {
                  onSuccess: () => toast.success(`${setting.label} updated`),
                  onError: (err: any) => {
                    if (needsConfirmation(err, { kind: "update", value: val })) return;
                    toast.error(err.message || "Failed to save");
                    setLocalValue(setting.value);
                  },
                }
              );
            }}
          >
            <SelectTrigger className="h-8 w-full sm:w-48 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent sheet>
              {setting.options.map((opt) => (
                <SelectItem key={opt} value={opt} className="text-xs">
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="flex items-center gap-1.5 w-full sm:w-auto">
            <div className="relative flex-1 min-w-0 sm:flex-none">
              <Input
                type={setting.type === "number" ? "number" : "text"}
                value={displayValue}
                disabled={isReadOnly}
                onChange={(e) => setLocalValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && hasChanged) handleSave();
                }}
                {...(setting.type === "number" && setting.min != null ? { min: setting.min } : {})}
                {...(setting.type === "number" && setting.max != null ? { max: setting.max } : {})}
                className={`h-8 w-full sm:w-48 text-xs font-mono ${setting.sensitive ? "pr-8" : ""}`}
              />
              {setting.sensitive && (
                <button
                  type="button"
                  onClick={handleReveal}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              )}
            </div>
            {hasChanged && !isReadOnly && (
              <Button size="sm" variant="ghost" onClick={handleSave} disabled={saving} className="h-8 px-2">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              </Button>
            )}
          </div>
        )}

        {setting.hasDbOverride && !isReadOnly && (
          <Button
            size="sm"
            variant="ghost"
            onClick={handleReset}
            disabled={resetMutation.isPending}
            className="h-8 px-2 text-muted-foreground hover:text-foreground"
            title="Reset to default"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <AlertDialog open={pendingConfirm !== null} onOpenChange={(open) => { if (!open) setPendingConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm this change</AlertDialogTitle>
            <AlertDialogDescription>{pendingConfirm?.reason}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setPendingConfirm(null);
                setLocalValue(setting.value);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmed}>Save anyway</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function DashboardSettings({ data }: DashboardSettingsProps) {
  const settings = useMemo(() => data?.settings || [], [data?.settings]);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const exportMutation = useExportSettings();
  const importMutation = useImportSettings();
  const importInput = useRef<HTMLInputElement>(null);
  const [importResult, setImportResult] = useState<SettingsImportResult | null>(null);
  const importNotes = importResult
    ? [
        ...importResult.failed.map((row) => ({ ...row, failed: true })),
        ...importResult.skipped.filter((row) => row.reason !== "unchanged").map((row) => ({ ...row, failed: false })),
      ]
    : [];

  async function handleExport() {
    try {
      const payload = await exportMutation.mutateAsync();
      const count = Object.keys(payload.settings).length;
      toast.success(`${count} setting${count === 1 ? "" : "s"} exported`, payload.maskedSecretKeys.length > 0
        ? { description: `${payload.maskedSecretKeys.length} secret${payload.maskedSecretKeys.length === 1 ? " is" : "s are"} left out and must be entered again after importing.` }
        : undefined);
    } catch (err: any) {
      toast.error(err.message || "Failed to export settings");
    }
  }

  async function handleImportFile(file: File | undefined) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const map = parsed && typeof parsed.settings === "object" && !Array.isArray(parsed.settings) ? parsed.settings : parsed;
      if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("This file holds no settings");
      setImportResult(await importMutation.mutateAsync(map));
    } catch (err: any) {
      toast.error(err instanceof SyntaxError ? "This file is not valid JSON" : err.message || "Failed to import settings");
    }
  }

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return settings;
    return settings.filter((s) =>
      s.label.toLowerCase().includes(needle) ||
      s.key.toLowerCase().includes(needle) ||
      (s.description || "").toLowerCase().includes(needle)
    );
  }, [settings, filter]);

  const grouped = useMemo(() => {
    const map = new Map<string, SettingItem[]>();
    for (const s of visible) {
      const list = map.get(s.category) || [];
      list.push(s);
      map.set(s.category, list);
    }
    return map;
  }, [visible]);

  // Ordering is deliberate for the categories named above, but a registry entry
  // must never be unreachable because its category was not one of them, so
  // anything unlisted is shown after them rather than dropped.
  const categories = useMemo(() => {
    const known = CATEGORY_ORDER.filter((c) => grouped.has(c));
    const rest = [...grouped.keys()].filter((c) => !CATEGORY_ORDER.includes(c)).sort();
    return [...known, ...rest];
  }, [grouped]);

  const pendingLabels = useMemo(
    () => settings.filter((s) => s.requiresRestart && s.changedSinceBoot).map((s) => s.label),
    [settings]
  );

  function scrollToCategory(cat: string) {
    setActiveCategory(cat);
    document.getElementById(`settings-cat-${cat}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (settings.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <Settings className="h-12 w-12 mx-auto mb-4 opacity-50" />
        <p>Loading settings...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <RestartManager pendingLabels={pendingLabels} canRestart={data?.canRestart} />
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-md flex-1 min-w-[16rem]">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search settings by name, key or description"
            className="pl-8 h-9"
          />
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" className="h-9" onClick={handleExport} disabled={exportMutation.isPending}>
            {exportMutation.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Download className="mr-1.5 h-4 w-4" />}
            Export
          </Button>
          <Button variant="outline" size="sm" className="h-9" onClick={() => importInput.current?.click()} disabled={importMutation.isPending}>
            {importMutation.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Upload className="mr-1.5 h-4 w-4" />}
            Import
          </Button>
          <input
            ref={importInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => { void handleImportFile(e.target.files?.[0]); e.target.value = ""; }}
          />
        </div>
      </div>
      <AlertDialog open={importResult !== null} onOpenChange={(open) => { if (!open) setImportResult(null); }}>
        <AlertDialogContent className="max-h-[80vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Settings imported</AlertDialogTitle>
            <AlertDialogDescription>
              {importResult?.imported.length ?? 0} applied, {importResult?.skipped.length ?? 0} skipped, {importResult?.failed.length ?? 0} not applied.
              {importResult?.requiresRestart ? " Some of them take effect after a restart." : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {importNotes.length > 0 && (
            <ul className="space-y-1 text-xs">
              {importNotes.map((row) => (
                <li key={row.key} className="flex gap-2">
                  <span className={`font-mono ${row.failed ? "text-red-400" : "text-muted-foreground"}`}>{row.key}</span>
                  <span className="text-muted-foreground">{row.reason}</span>
                </li>
              ))}
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setImportResult(null)}>Done</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="flex gap-6">
      <nav className="hidden lg:block w-52 shrink-0 sticky top-0 self-start space-y-1">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => scrollToCategory(cat)}
            className={`flex items-center gap-2 w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
              activeCategory === cat
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
            }`}
          >
            {CATEGORY_ICONS[cat] || <Settings className="h-4 w-4" />}
            <span className="truncate">{cat}</span>
            <Badge variant="secondary" className="ml-auto text-[10px] h-5 min-w-5 justify-center">
              {grouped.get(cat)?.length}
            </Badge>
          </button>
        ))}
      </nav>

      <div className="flex-1 min-w-0 space-y-6">
        {categories.length === 0 && (
          <div className="py-16 text-center text-muted-foreground">
            No setting matches "{filter}".
          </div>
        )}
        {categories.map((cat) => (
          <Card key={cat} id={`settings-cat-${cat}`}>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                {CATEGORY_ICONS[cat] || <Settings className="h-5 w-5" />}
                <div>
                  <CardTitle className="text-lg">{cat}</CardTitle>
                  <CardDescription>{CATEGORY_DESCRIPTIONS[cat] || ""}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {grouped.get(cat)?.map((setting) => (
                <SettingRow key={setting.key} setting={setting} />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
      </div>
    </div>
  );
}
