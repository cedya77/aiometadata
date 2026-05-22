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
} from "lucide-react";
import { toast } from "sonner";
import {
  type SettingItem,
  useUpdateSetting,
  useResetSetting,
} from "@/hooks/useDashboardQueries";

interface DashboardSettingsProps {
  data: { settings: SettingItem[] } | null | undefined;
}

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  "API Keys": <Key className="h-4 w-4" />,
  "OAuth": <Shield className="h-4 w-4" />,
  "Cache": <Database className="h-4 w-4" />,
  "Features": <Zap className="h-4 w-4" />,
  "Essential Warming": <Flame className="h-4 w-4" />,
  "Comprehensive Warming": <Flame className="h-4 w-4" />,
  "MAL Warming": <Flame className="h-4 w-4" />,
  "Rate Limiting": <Gauge className="h-4 w-4" />,
  "Data Updates": <Calendar className="h-4 w-4" />,
  "Proxy": <Globe className="h-4 w-4" />,
  "Diagnostics": <Activity className="h-4 w-4" />,
  "Server": <Server className="h-4 w-4" />,
};

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  "API Keys": "Third-party API keys for metadata providers",
  "OAuth": "OAuth credentials — read-only, set via environment",
  "Cache": "Cache duration and behavior",
  "Features": "Feature toggles and customization",
  "Essential Warming": "Background warming for trending and popular content",
  "Comprehensive Warming": "Full catalog warming for specific users",
  "MAL Warming": "MyAnimeList catalog warming configuration",
  "Rate Limiting": "API rate limiting and request throttling",
  "Data Updates": "Intervals for updating external data mappings",
  "Proxy": "HTTP/SOCKS proxy configuration",
  "Diagnostics": "Logging, health checks, and monitoring",
  "Server": "Server configuration — requires restart",
};

const CATEGORY_ORDER = [
  "API Keys", "OAuth", "Cache", "Features",
  "Essential Warming", "Comprehensive Warming", "MAL Warming",
  "Rate Limiting", "Data Updates", "Proxy", "Diagnostics", "Server",
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
      className={`flex flex-wrap items-center gap-1.5 min-h-[2rem] rounded-md border border-input bg-background px-2 py-1 w-72 ${
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

  async function handleSave() {
    setSaving(true);
    try {
      await updateMutation.mutateAsync({ key: setting.key, value: localValue });
      toast.success(`${setting.label} updated`);
    } catch (err: any) {
      toast.error(err.message || "Failed to save");
      setLocalValue(setting.value);
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    try {
      await resetMutation.mutateAsync(setting.key);
      toast.success(`${setting.label} reset to default`);
    } catch (err: any) {
      toast.error(err.message || "Failed to reset");
    }
  }

  function handleReveal() {
    setRevealed(!revealed);
    if (!revealed) {
      setLocalValue(setting.value);
    }
  }

  return (
    <div className={`flex items-start gap-4 py-4 border-b border-border/50 last:border-0 transition-opacity ${isDisabled ? "opacity-40" : ""}`}>
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

      <div className="flex items-center gap-2 shrink-0">
        {setting.uiHint === "tags" ? (
          <div className="flex items-center gap-1.5">
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
                    toast.error(err.message || "Failed to save");
                    setLocalValue(setting.value);
                  },
                }
              );
            }}
          >
            <SelectTrigger className="h-8 w-48 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {setting.options.map((opt) => (
                <SelectItem key={opt} value={opt} className="text-xs">
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="flex items-center gap-1.5">
            <div className="relative">
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
                className={`h-8 w-48 text-xs font-mono ${setting.sensitive ? "pr-8" : ""}`}
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
    </div>
  );
}

export function DashboardSettings({ data }: DashboardSettingsProps) {
  const settings = data?.settings || [];
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, SettingItem[]>();
    for (const s of settings) {
      const list = map.get(s.category) || [];
      list.push(s);
      map.set(s.category, list);
    }
    return map;
  }, [settings]);

  const categories = useMemo(
    () => CATEGORY_ORDER.filter((c) => grouped.has(c)),
    [grouped]
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
  );
}
