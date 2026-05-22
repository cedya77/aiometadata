import { useState, useEffect, useMemo } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Activity,
  Clock,
  Database,
  Zap,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Shield,
} from "lucide-react";
import {
  LineChart as RechartsLineChart,
  Line,
  AreaChart as RechartsAreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart as RechartsBarChart,
  Bar,
} from "recharts";
import { AnimatedNumber } from "../AnimatedNumber";

const PROVIDER_COLORS: Record<string, string> = {
  tmdb: "#3b82f6",
  tvdb: "#10b981",
  mal: "#f43f5e",
  anilist: "#06b6d4",
  kitsu: "#f97316",
  fanart: "#ec4899",
  tvmaze: "#f59e0b",
  trakt: "#a855f7",
  mdblist: "#6366f1",
  letterboxd: "#84cc16",
};


interface DashboardAnalyticsProps {
  data: any;
  isMobile: boolean;
}

function StatusDot({ status }: { status: string }) {
  const color = status === "healthy"
    ? "bg-green-500 shadow-green-500/40"
    : status === "warning"
    ? "bg-yellow-500 shadow-yellow-500/40"
    : "bg-red-500 shadow-red-500/40";
  return <div className={`w-2.5 h-2.5 rounded-full shadow-md ${color}`} />;
}

function StatCard({ icon: Icon, label, value, subtitle, color }: {
  icon: any;
  label: string;
  value: React.ReactNode;
  subtitle?: string;
  color: string;
}) {
  return (
    <div className="flex items-center gap-3 p-4 rounded-xl border bg-card">
      <div className={`flex items-center justify-center w-10 h-10 rounded-lg bg-${color}-500/10`}>
        <Icon className={`h-5 w-5 text-${color}-500`} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="text-xl font-bold">{value}</div>
        {subtitle && <p className="text-[10px] text-muted-foreground">{subtitle}</p>}
      </div>
    </div>
  );
}

const transformToLocalSlidingWindow = (data: any[]) => {
  if (!data || data.length === 0) return [];
  const dataMap = new Map(data.map(item => [item.hour, item]));
  const now = new Date();
  const result = [];
  for (let i = 23; i >= 0; i--) {
    const targetTime = new Date(now.getTime() - i * 60 * 60 * 1000);
    const serverHour = targetTime.getUTCHours();
    const localHour = targetTime.getHours();
    const match = dataMap.get(serverHour);
    result.push({
      displayHour: `${localHour}:00`,
      requests: match?.requests || 0,
      responseTime: match?.responseTime || 0,
    });
  }
  return result;
};

const normalizeHourlyData = (data: any[], providerKeys: string[]) => {
  if (!data) return [];
  const dataMap = new Map(data.map(item => [item.hour, item]));
  const normalized = [];
  const now = new Date();
  let lastKnownValues: any = Object.fromEntries(providerKeys.map(k => [k, 0]));
  for (let i = 23; i >= 0; i--) {
    const targetTime = new Date(now.getTime() - i * 60 * 60 * 1000);
    const serverHour = targetTime.getUTCHours();
    const localHour = targetTime.getHours();
    const match = dataMap.get(serverHour);
    const entry: any = { displayHour: `${localHour}:00`, hour: localHour };
    providerKeys.forEach(key => {
      if (match && match[key] !== undefined && match[key] !== null) {
        entry[key] = match[key];
        lastKnownValues[key] = match[key];
      } else {
        entry[key] = lastKnownValues[key];
      }
    });
    normalized.push(entry);
  }
  return normalized;
};

export function DashboardAnalytics({ data, isMobile }: DashboardAnalyticsProps) {
  const [requestMetrics, setRequestMetrics] = useState(() => ({
    requestsPerHour: data?.hourlyData || [],
    responseTimes: data?.hourlyData || [],
    successRate: data?.requestStats?.successRate || (data?.requestStats ? 100 - data.requestStats.errorRate : 0),
    failureRate: data?.requestStats?.errorRate || 0,
  }));

  const [cachePerformance, setCachePerformance] = useState(() => ({
    hitRate: data?.cachePerformance?.hitRate || 0,
    missRate: data?.cachePerformance?.missRate || 0,
    memoryUsage: data?.cachePerformance?.memoryUsage || 0,
    memoryUsagePercent: data?.cachePerformance?.memoryUsagePercent ?? null,
    evictionRate: data?.cachePerformance?.evictionRate || 0,
  }));

  const [providerPerformance, setProviderPerformance] = useState(() => data?.providerPerformance || []);
  const [providerHourlyData, setProviderHourlyData] = useState(() => data?.providerHourlyData || []);

  useEffect(() => {
    if (data) {
      const localSlidingMetrics = transformToLocalSlidingWindow(data.hourlyData || []);
      setProviderHourlyData(data.providerHourlyData || []);
      if (data.requestStats) {
        const successRate = data.requestStats.successRate || 100 - data.requestStats.errorRate;
        setRequestMetrics({
          requestsPerHour: localSlidingMetrics,
          responseTimes: localSlidingMetrics,
          successRate,
          failureRate: data.requestStats.errorRate,
        });
      }
      if (data.cachePerformance) setCachePerformance(data.cachePerformance);
      if (data.providerPerformance) setProviderPerformance(data.providerPerformance || []);
    }
  }, [data]);

  const providerKeys = useMemo(() => {
    return providerHourlyData.reduce((acc: string[], curr: any) => {
      Object.keys(curr).forEach((key) => {
        if (!acc.includes(key) && !["hour", "timestamp"].includes(key)) acc.push(key);
      });
      return acc;
    }, []);
  }, [providerHourlyData]);

  const slidingData = useMemo(() => normalizeHourlyData(providerHourlyData, providerKeys), [providerHourlyData, providerKeys]);

  const cacheMemoryUsagePercent = typeof cachePerformance.memoryUsagePercent === "number" && Number.isFinite(cachePerformance.memoryUsagePercent)
    ? Math.max(0, Math.min(100, cachePerformance.memoryUsagePercent))
    : null;
  const cacheMemoryUsageLabel = typeof cachePerformance.memoryUsage === "string" && cachePerformance.memoryUsage.trim()
    ? cachePerformance.memoryUsage
    : "N/A";

  const healthyCount = providerPerformance.filter((p: any) => p.status === "healthy").length;
  const warningCount = providerPerformance.filter((p: any) => p.status === "warning").length;
  const errorCount = providerPerformance.filter((p: any) => p.status !== "healthy" && p.status !== "warning").length;

  return (
    <div className="space-y-6">
      {/* Provider Status Strip */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-blue-500" />
              <div>
                <CardTitle className="text-lg">Provider Status</CardTitle>
                <CardDescription>Metadata source availability</CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-3 text-xs">
              {healthyCount > 0 && (
                <span className="flex items-center gap-1 text-green-600">
                  <CheckCircle2 className="h-3.5 w-3.5" /> {healthyCount}
                </span>
              )}
              {warningCount > 0 && (
                <span className="flex items-center gap-1 text-yellow-600">
                  <AlertTriangle className="h-3.5 w-3.5" /> {warningCount}
                </span>
              )}
              {errorCount > 0 && (
                <span className="flex items-center gap-1 text-red-600">
                  <XCircle className="h-3.5 w-3.5" /> {errorCount}
                </span>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {providerPerformance.map((provider: any, index: number) => (
              <div
                key={index}
                className="flex items-center gap-2.5 p-2.5 rounded-lg border bg-muted/20 hover:bg-muted/40 transition-colors"
              >
                <StatusDot status={provider.status} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate capitalize">{provider.name}</p>
                  <p className="text-[10px] text-muted-foreground">{Number(provider.responseTime)}ms</p>
                </div>
                {Number(provider.errorRate) > 0 && (
                  <span className="text-[10px] text-red-500 font-medium">{Number(provider.errorRate)}%</span>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={CheckCircle2}
          label="Success Rate"
          value={<AnimatedNumber value={Number(requestMetrics.successRate)} decimals={1} suffix="%" />}
          color="green"
        />
        <StatCard
          icon={Database}
          label="Cache Hit Rate"
          value={<AnimatedNumber value={Number(cachePerformance.hitRate)} suffix="%" />}
          subtitle={cacheMemoryUsagePercent !== null ? `${cacheMemoryUsagePercent.toFixed(0)}% memory` : cacheMemoryUsageLabel}
          color="blue"
        />
        <StatCard
          icon={Zap}
          label="Error Rate"
          value={<AnimatedNumber value={Number(requestMetrics.failureRate)} decimals={1} suffix="%" />}
          color="red"
        />
        <StatCard
          icon={Clock}
          label="Avg Latency"
          value={(() => {
            const times = requestMetrics.responseTimes.filter((d: any) => d.responseTime > 0);
            const avg = times.length > 0 ? Math.round(times.reduce((sum: number, d: any) => sum + d.responseTime, 0) / times.length) : 0;
            return `${avg}ms`;
          })()}
          color="amber"
        />
      </div>

      {/* Cache Performance Detail */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-blue-500" />
            <div>
              <CardTitle className="text-lg">Cache Performance</CardTitle>
              <CardDescription>Redis cache efficiency</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm">Hit Rate</span>
              <span className="text-sm font-bold text-blue-600">
                <AnimatedNumber value={Number(cachePerformance.hitRate)} suffix="%" />
              </span>
            </div>
            <Progress value={Number(cachePerformance.hitRate)} className="h-2" />
            <div className="grid grid-cols-3 gap-4 pt-2">
              <div className="text-center">
                <p className="text-xs text-muted-foreground">Miss Rate</p>
                <p className="text-sm font-semibold">{Number(cachePerformance.missRate)}%</p>
              </div>
              <div className="text-center">
                <p className="text-xs text-muted-foreground">Memory</p>
                <p className="text-sm font-semibold">
                  {cacheMemoryUsagePercent !== null ? `${cacheMemoryUsagePercent.toFixed(0)}%` : cacheMemoryUsageLabel}
                </p>
              </div>
              <div className="text-center">
                <p className="text-xs text-muted-foreground">Evictions</p>
                <p className="text-sm font-semibold">{Number(cachePerformance.evictionRate)}/s</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Provider Latency Chart */}
      {slidingData.length > 0 && providerKeys.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="h-5 w-5 text-emerald-500" />
                <div>
                  <CardTitle className="text-lg">Provider Latency</CardTitle>
                  <CardDescription>Response times per hour (lower is better)</CardDescription>
                </div>
              </div>
              <Badge variant="secondary" className="px-2 py-0.5 font-mono text-[10px]">
                <Activity className="h-3 w-3 mr-1 text-emerald-500 animate-pulse" />
                LIVE
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <RechartsAreaChart data={slidingData}>
                  <defs>
                    {providerKeys.map((key) => {
                      const color = PROVIDER_COLORS[key.toLowerCase()] || "#64748b";
                      return (
                        <linearGradient key={key} id={`grad-${key}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                          <stop offset="95%" stopColor={color} stopOpacity={0.02} />
                        </linearGradient>
                      );
                    })}
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" opacity={0.3} />
                  <XAxis
                    dataKey="displayHour"
                    tick={{ fontSize: 10, fill: "#94a3b8" }}
                    axisLine={false}
                    tickLine={false}
                    interval={isMobile ? "preserveStartEnd" : 2}
                  />
                  <YAxis
                    width={55}
                    tick={{ fontSize: 10, fill: "#94a3b8" }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => `${Math.floor(v)}ms`}
                  />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload) return null;
                      return (
                        <div className="rounded-xl border bg-background/95 backdrop-blur-md p-3 shadow-2xl ring-1 ring-black/5 min-w-[140px]">
                          <p className="text-[10px] font-bold text-muted-foreground mb-2 uppercase tracking-wider">{label}</p>
                          <div className="space-y-1.5">
                            {payload.map((entry: any, idx: number) => (
                              <div key={idx} className="flex items-center justify-between gap-4">
                                <div className="flex items-center gap-1.5">
                                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
                                  <span className="text-xs font-medium capitalize">{entry.dataKey}</span>
                                </div>
                                <span className="text-xs font-mono font-bold">{entry.value}ms</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    }}
                  />
                  {providerKeys.map((key) => {
                    const color = PROVIDER_COLORS[key.toLowerCase()] || "#64748b";
                    return (
                      <Area
                        key={key}
                        type="monotone"
                        dataKey={key}
                        stroke={color}
                        fill={`url(#grad-${key})`}
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 3 }}
                      />
                    );
                  })}
                </RechartsAreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Request Volume & Latency */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-indigo-500" />
              <div>
                <CardTitle className="text-lg">Request Volume</CardTitle>
                <CardDescription>Last 24 hours (local time)</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <RechartsLineChart data={requestMetrics.requestsPerHour}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#334155" opacity={0.2} />
                  <XAxis
                    dataKey="displayHour"
                    tick={{ fontSize: 9, fill: "#94a3b8" }}
                    axisLine={false}
                    tickLine={false}
                    interval={isMobile ? 5 : 3}
                  />
                  <YAxis tick={{ fontSize: 9, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#0f172a", borderColor: "#1e293b", borderRadius: "8px", fontSize: "11px" }}
                    itemStyle={{ color: "#f1f5f9" }}
                    labelStyle={{ color: "#94a3b8" }}
                    formatter={(value: any) => [value, "Requests"]}
                  />
                  <Line
                    type="monotone"
                    dataKey="requests"
                    stroke="#6366f1"
                    strokeWidth={2.5}
                    dot={false}
                    activeDot={{ r: 3, strokeWidth: 0, fill: "#818cf8" }}
                  />
                </RechartsLineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-emerald-500" />
              <div>
                <CardTitle className="text-lg">Avg Response Latency</CardTitle>
                <CardDescription>Last 24 hours (local time)</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <RechartsBarChart data={requestMetrics.responseTimes}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#334155" opacity={0.2} />
                  <XAxis
                    dataKey="displayHour"
                    tick={{ fontSize: 9, fill: "#94a3b8" }}
                    axisLine={false}
                    tickLine={false}
                    interval={isMobile ? 5 : 3}
                  />
                  <YAxis tick={{ fontSize: 9, fill: "#94a3b8" }} axisLine={false} tickLine={false} unit="ms" />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#0f172a", borderColor: "#1e293b", borderRadius: "8px", fontSize: "11px" }}
                    itemStyle={{ color: "#f1f5f9" }}
                    labelStyle={{ color: "#94a3b8" }}
                    formatter={(value: any) => [`${value}ms`, "Latency"]}
                  />
                  <Bar dataKey="responseTime" fill="#10b981" radius={[3, 3, 0, 0]} />
                </RechartsBarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
