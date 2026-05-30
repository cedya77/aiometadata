import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Server,
  HardDrive,
  Cpu,
  Database,
  Users,
  Zap,
  TrendingUp,
  Flame,
  Star,
  Film,
} from "lucide-react";

interface Signal {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail?: string;
  metric?: string;
  link?: { tab: string; label: string };
}

interface TrendingItem {
  id: string;
  type: string;
  title: string;
  rating: number | null;
  year: number | string | null;
  poster: string | null;
  landscapePoster: string | null;
  imdb_id: string | null;
  requests: number;
  prevRequests: number;
  deltaPct: number | null;
  isNew: boolean;
}

interface OverviewSignals {
  verdict: { level: "healthy" | "warning" | "critical"; headline: string; count: number };
  live: { requestsPerMin: number; activeUsers: number; successRate: number; successWindow: string; sparkline: number[] };
  needsAttention: Signal[];
  notable: Signal[];
  system: {
    status: string;
    memoryMB: number;
    diskPct: number | null;
    errorRate: number;
    redisOk: boolean;
    platform: string;
    processId: number;
    nodeVersion: string;
    version: string;
    uptime: string;
  };
  tabs: Record<string, "ok" | "warn" | "alert">;
  trending: TrendingItem[];
}

interface DashboardOverviewProps {
  data?: { signals?: OverviewSignals; metricsDisabled?: boolean; systemOverview?: any } | undefined;
  loading?: boolean;
  onNavigate?: (tab: string) => void;
}

const detectEnvironment = (system: OverviewSignals["system"]): string => {
  if (system.processId === 1) return "Docker";
  const platform = system.platform;
  if (platform === "linux") return "Linux";
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  return platform || "Unknown";
};

const VERDICT_STYLES = {
  healthy: { wrap: "border-green-500/30 bg-green-500/10", dot: "bg-green-500", text: "text-green-400", Icon: CheckCircle2, label: "ALL HEALTHY" },
  warning: { wrap: "border-amber-500/30 bg-amber-500/10", dot: "bg-amber-500", text: "text-amber-400", Icon: AlertTriangle, label: "NEEDS ATTENTION" },
  critical: { wrap: "border-red-500/30 bg-red-500/10", dot: "bg-red-500", text: "text-red-400", Icon: AlertCircle, label: "NEEDS ATTENTION" },
} as const;

const TAB_HEALTH_DOT = {
  ok: "bg-green-500",
  warn: "bg-amber-500",
  alert: "bg-red-500",
} as const;

const TAB_LABELS: Record<string, string> = {
  analytics: "Analytics",
  content: "Content",
  performance: "Performance",
  users: "Users",
  operations: "Operations",
  logs: "Logs",
};

function Sparkline({ data }: { data: number[] }) {
  if (!data || data.length < 2) return null;
  const w = 120;
  const h = 28;
  const max = Math.max(...data, 1);
  const step = w / (data.length - 1);
  const points = data.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" className="text-primary/80" />
    </svg>
  );
}

function SignalRow({ signal, onNavigate }: { signal: Signal; onNavigate?: (tab: string) => void }) {
  const tone =
    signal.severity === "critical" ? "text-red-400"
      : signal.severity === "warning" ? "text-amber-400"
        : "text-blue-400";
  const Icon =
    signal.severity === "critical" ? AlertCircle
      : signal.severity === "warning" ? AlertTriangle
        : TrendingUp;
  const clickable = !!(signal.link && onNavigate);
  return (
    <div
      className={`flex items-start gap-3 p-3 rounded-lg border bg-card/40 ${clickable ? "cursor-pointer hover:bg-white/[0.03]" : ""}`}
      onClick={clickable ? () => onNavigate!(signal.link!.tab) : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onNavigate!(signal.link!.tab); } } : undefined}
    >
      <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${tone}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm font-medium truncate">{signal.title}</p>
          {signal.metric && <span className="text-xs font-medium text-muted-foreground shrink-0 tabular-nums">{signal.metric}</span>}
        </div>
        {signal.detail && <p className="text-xs text-muted-foreground mt-0.5">{signal.detail}</p>}
        {signal.link && (
          <span className="inline-flex items-center text-[11px] text-muted-foreground/70 mt-1">
            {signal.link.label}
            <ChevronRight className="h-3 w-3" />
          </span>
        )}
      </div>
    </div>
  );
}

const MAX_DELTA_PCT = 500;

function Momentum({ item }: { item: TrendingItem }) {
  if (item.isNew) {
    return <span className="rounded-full bg-green-500/90 text-white text-[10px] font-semibold px-1.5 py-0.5">NEW</span>;
  }
  if (item.deltaPct === null) return null;
  if (item.deltaPct >= 5) {
    const label = item.deltaPct > MAX_DELTA_PCT ? `${MAX_DELTA_PCT}+` : `${item.deltaPct}`;
    return <span className="rounded-full bg-green-500/90 text-white text-[10px] font-semibold px-1.5 py-0.5">▲ {label}%</span>;
  }
  if (item.deltaPct <= -5) {
    const label = item.deltaPct < -MAX_DELTA_PCT ? `${MAX_DELTA_PCT}+` : `${Math.abs(item.deltaPct)}`;
    return <span className="rounded-full bg-red-500/90 text-white text-[10px] font-semibold px-1.5 py-0.5">▼ {label}%</span>;
  }
  return null;
}

function TrendingCard({ item, rank }: { item: TrendingItem; rank: number }) {
  const art = item.landscapePoster || item.poster;
  return (
    <div className="relative w-full rounded-lg overflow-hidden border bg-muted">
      <div
        className="aspect-video bg-cover bg-center flex items-center justify-center"
        style={art ? { backgroundImage: `url(${art})` } : undefined}
      >
        {!art && <Film className="h-8 w-8 text-muted-foreground/40" />}
      </div>
      <div className="absolute top-1.5 left-1.5 flex items-center justify-center h-5 min-w-5 px-1 rounded-md bg-black/70 text-white text-xs font-bold">
        {rank}
      </div>
      <div className="absolute top-1.5 right-1.5">
        <Momentum item={item} />
      </div>
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-2 pt-6">
        <p className="text-white text-sm font-medium leading-tight line-clamp-2">{item.title}</p>
        <div className="flex items-center gap-2 mt-1 text-[11px] text-white/80">
          {item.year && <span>{item.year}</span>}
          {item.rating && (
            <span className="flex items-center gap-0.5">
              <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
              {item.rating}
            </span>
          )}
          <span className="ml-auto tabular-nums">{item.requests.toLocaleString()} reqs</span>
        </div>
      </div>
    </div>
  );
}

export function DashboardOverview({ data, loading, onNavigate }: DashboardOverviewProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (data?.metricsDisabled || !data?.signals) {
    const status = data?.systemOverview?.status || "unknown";
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Overview
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {data?.metricsDisabled
              ? "Metrics are disabled on this instance, so signals are unavailable."
              : "No signal data yet."}
          </p>
          <p className="text-sm mt-2">System status: <span className="font-medium">{status}</span></p>
        </CardContent>
      </Card>
    );
  }

  const s = data.signals;
  const verdict = VERDICT_STYLES[s.verdict.level];
  const VerdictIcon = verdict.Icon;

  return (
    <div className="space-y-4">
      <div className={`rounded-xl border px-4 py-3 ${verdict.wrap}`}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              {s.verdict.level !== "healthy" && (
                <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping ${verdict.dot}`} />
              )}
              <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${verdict.dot}`} />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <VerdictIcon className={`h-4 w-4 ${verdict.text}`} />
                <span className={`text-xs font-semibold tracking-wide ${verdict.text}`}>
                  {verdict.label}{s.verdict.count > 0 ? ` · ${s.verdict.count}` : ""}
                </span>
              </div>
              <p className="text-sm mt-0.5 truncate">{s.verdict.headline}</p>
            </div>
          </div>
          <div className="text-xs text-muted-foreground text-right shrink-0">
            aiometadata {s.system.version} · up {s.system.uptime}
          </div>
        </div>
      </div>

      <Card>
        <CardContent className="py-3">
          <div className="flex items-center gap-6 flex-wrap">
            <div className="flex items-center gap-2 text-primary">
              <Sparkline data={s.live.sparkline} />
            </div>
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-muted-foreground" />
              <span className="text-lg font-bold tabular-nums">{s.live.requestsPerMin}</span>
              <span className="text-xs text-muted-foreground">req/min</span>
            </div>
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-lg font-bold tabular-nums">{s.live.activeUsers}</span>
              <span className="text-xs text-muted-foreground">active now</span>
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
              <span className="text-lg font-bold tabular-nums">{s.live.successRate}%</span>
              <span className="text-xs text-muted-foreground">success ({s.live.successWindow})</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Needs Attention
            </CardTitle>
          </CardHeader>
          <CardContent>
            {s.needsAttention.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                <CheckCircle2 className="h-10 w-10 mb-3 text-green-500/60" />
                <p className="text-sm">Nothing needs you right now</p>
              </div>
            ) : (
              <div className="space-y-2">
                {s.needsAttention.map((sig) => (
                  <SignalRow key={sig.id} signal={sig} onNavigate={onNavigate} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Server className="h-4 w-4" />
              System
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Status</span>
              <Badge variant={s.system.status === "healthy" ? "default" : s.system.status === "warning" ? "secondary" : "destructive"}>
                {s.system.status}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5" />Memory</span>
              <span className="font-medium tabular-nums">{s.system.memoryMB} MB</span>
            </div>
            {s.system.diskPct !== null && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground flex items-center gap-1.5"><HardDrive className="h-3.5 w-3.5" />Disk</span>
                <span className={`font-medium tabular-nums ${s.system.diskPct >= 85 ? "text-red-400" : s.system.diskPct >= 70 ? "text-amber-400" : ""}`}>{s.system.diskPct}%</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground flex items-center gap-1.5"><AlertCircle className="h-3.5 w-3.5" />Error rate</span>
              <span className={`font-medium tabular-nums ${s.system.errorRate >= 5 ? "text-red-400" : s.system.errorRate >= 2 ? "text-amber-400" : ""}`}>{s.system.errorRate}%</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground flex items-center gap-1.5"><Database className="h-3.5 w-3.5" />Redis</span>
              <span className={`font-medium ${s.system.redisOk ? "text-green-400" : "text-red-400"}`}>{s.system.redisOk ? "ok" : "down"}</span>
            </div>
            <div className="flex items-center justify-between pt-2 border-t">
              <span className="text-muted-foreground">Environment</span>
              <span className="font-medium">{detectEnvironment(s.system)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Node</span>
              <span className="font-medium">{s.system.nodeVersion}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            What's Notable
          </CardTitle>
        </CardHeader>
        <CardContent>
          {s.notable.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">Nothing notable yet today</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {s.notable.map((sig) => (
                <SignalRow key={sig.id} signal={sig} onNavigate={onNavigate} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {s.trending && s.trending.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Flame className="h-4 w-4 text-orange-400" />
                Trending This Week
              </CardTitle>
              <button
                onClick={() => onNavigate?.("content")}
                className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
              >
                View all
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {s.trending.map((item, i) => (
                <TrendingCard key={`${item.type}-${item.id}`} item={item} rank={i + 1} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="py-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground mr-1">Jump to</span>
            {Object.entries(s.tabs).map(([tab, health]) => (
              <button
                key={tab}
                onClick={() => onNavigate?.(tab)}
                className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs hover:bg-white/[0.04] transition-colors"
              >
                <span className={`h-2 w-2 rounded-full ${TAB_HEALTH_DOT[health]}`} />
                {TAB_LABELS[tab] || tab}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
