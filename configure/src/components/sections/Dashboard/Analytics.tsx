import { useState, useEffect } from "react";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import {
    Card,
    CardHeader,
    CardTitle,
    CardDescription,
    CardContent
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@radix-ui/react-progress";
import { Activity, Clock } from "lucide-react";
import { 
    ResponsiveContainer,
    CartesianGrid,
    XAxis,
    YAxis,
    Tooltip,
    Area,
    Line,
    Bar,
    AreaChart,
    LineChart,
    BarChart
} from "recharts";

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
    const entry: any = { 
      displayHour: `${localHour}:00`, 
      hour: localHour 
    };

    providerKeys.forEach(key => {
      if (match && match[key] !== undefined && match[key] !== null) {
        entry[key] = match[key];
        lastKnownValues[key] = match[key];
      } else {
        // Keep the line flat using the last recorded value
        entry[key] = lastKnownValues[key];
      }
    });

    normalized.push(entry);
  }

  return normalized;
};

export function DashboardAnalytics({ data, loading, isMobile }) {
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
  const [idResolverPerformance, setIdResolverPerformance] = useState(() => data?.idResolverPerformance || {
    totalResolutions: 0,
    wikiMappingEarlyReturns: { count: 0, percentage: 0 },
    cacheEarlyReturns: { count: 0, percentage: 0 },
    apiCallsRequired: { count: 0, percentage: 0 },
    animeResolutions: { count: 0, percentage: 0 },
    earlyReturnRate: 0,
  });

  const providerColorMap: Record<string, string> = {
    tmdb: "blue",
    tvdb: "emerald",
    mal: "rose",
    anilist: "cyan",
    kitsu: "orange",
    fanart: "pink",
    tvmaze: "amber",
    trakt: "purple",
    mdblist: "indigo",
    letterboxd: "lime",
  };

  useEffect(() => {
    if (data) {
      const localSlidingMetrics = transformToLocalSlidingWindow(data.hourlyData || []);
      setProviderHourlyData(data.providerHourlyData || []);

      if (data.requestStats) {
        const successRate =
          data.requestStats.successRate || 100 - data.requestStats.errorRate;
        setRequestMetrics({
          requestsPerHour: localSlidingMetrics,
          responseTimes: localSlidingMetrics,
          successRate: successRate,
          failureRate: data.requestStats.errorRate,
        });
      }

      // We get cache and provider performance from the overview data prop
      if (data.cachePerformance) {
        setCachePerformance(data.cachePerformance);
      }
      if (data.providerPerformance) {
        setProviderPerformance(data.providerPerformance || []);
      }

      if (data.idResolverPerformance) {
        setIdResolverPerformance(data.idResolverPerformance);
      }
    }
  }, [data]);

  // Get all unique provider keys from the data to ensure all lines are rendered
  const providerKeys = providerHourlyData.reduce((acc: string[], curr) => {
    Object.keys(curr).forEach((key) => {
      if (!acc.includes(key) && !["hour", "timestamp"].includes(key)) {
        acc.push(key);
      }
    });
    return acc;
  }, []);

  const slidingData = normalizeHourlyData(providerHourlyData, providerKeys);
  const cacheMemoryUsagePercent =
    typeof cachePerformance.memoryUsagePercent === "number" &&
    Number.isFinite(cachePerformance.memoryUsagePercent)
      ? Math.max(0, Math.min(100, cachePerformance.memoryUsagePercent))
      : null;
  const cacheMemoryUsageLabel =
    typeof cachePerformance.memoryUsage === "string" && cachePerformance.memoryUsage.trim()
      ? cachePerformance.memoryUsage
      : "N/A";

  return (
    <div className="space-y-6">
      {/* Request Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Request Success Rate</CardTitle>
            <CardDescription>
              Success vs failure for tracked responses
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  Success (HTTP 2xx-3xx)
                </span>
                <span className="text-2xl font-bold text-green-600">
                  <AnimatedNumber value={Number(requestMetrics.successRate)} decimals={1} suffix="%" />
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  Failure (HTTP 4xx-5xx)
                </span>
                <span className="text-2xl font-bold text-red-600">
                  <AnimatedNumber value={Number(requestMetrics.failureRate)} decimals={1} suffix="%" />
                </span>
              </div>
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                <div
                  className="bg-green-600 h-2 rounded-full transition-all duration-500"
                  style={{ width: `${Number(requestMetrics.successRate)}%` }}
                ></div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cache Performance</CardTitle>
            <CardDescription>Redis cache hit/miss ratios</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Hit Rate</span>
                <span className="text-2xl font-bold text-blue-600">
                  <AnimatedNumber value={Number(cachePerformance.hitRate)} suffix="%" />
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Memory Usage</span>
                <span className="text-2xl font-bold text-orange-600">
                  {cacheMemoryUsagePercent !== null ? (
                    <AnimatedNumber value={cacheMemoryUsagePercent} suffix="%" />
                  ) : (
                    cacheMemoryUsageLabel
                  )}
                </span>
              </div>
              <Progress
                value={Number(cachePerformance.hitRate)}
                className="mt-2"
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Provider Performance */}
      <Card>
        <CardHeader>
          <CardTitle>Provider Performance</CardTitle>
          <CardDescription>
            Response times and error rates for each metadata provider
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {providerPerformance.map((provider, index) => (
              <div
                key={index}
                className="p-3 border rounded-lg"
              >
                {/* Desktop layout */}
                <div className="hidden sm:flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <div
                      className={`w-3 h-3 rounded-full ${
                        provider.status === "healthy"
                          ? "bg-green-500"
                          : provider.status === "warning"
                            ? "bg-yellow-500"
                            : "bg-red-500"
                      }`}
                    ></div>
                    <span className="font-medium">{provider.name}</span>
                  </div>
                  <div className="flex items-center space-x-6">
                    <div className="text-right">
                      <p className="text-sm text-muted-foreground">
                        Response Time
                      </p>
                      <p className="font-medium">
                        {Number(provider.responseTime)}ms
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-muted-foreground">Error Rate</p>
                      <p className="font-medium">{Number(provider.errorRate)}%</p>
                    </div>
                    <Badge
                      variant={
                        provider.status === "healthy" ? "default" : "secondary"
                      }
                    >
                      {provider.status}
                    </Badge>
                  </div>
                </div>
                {/* Mobile layout */}
                <div className="sm:hidden">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center space-x-2">
                      <div
                        className={`w-3 h-3 rounded-full ${
                          provider.status === "healthy"
                            ? "bg-green-500"
                            : provider.status === "warning"
                              ? "bg-yellow-500"
                              : "bg-red-500"
                        }`}
                      ></div>
                      <span className="font-medium">{provider.name}</span>
                    </div>
                    <Badge
                      variant={
                        provider.status === "healthy" ? "default" : "secondary"
                      }
                    >
                      {provider.status}
                    </Badge>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Response Time</span>
                    <span className="font-medium">{Number(provider.responseTime)}ms</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Error Rate</span>
                    <span className="font-medium">{Number(provider.errorRate)}%</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Provider Response Time Chart */}
      <Card className="overflow-hidden border-none shadow-lg bg-background/50 backdrop-blur-sm">
        <CardHeader className="pb-4">
          <div className="flex justify-between items-center">
            <div>
              <CardTitle className="text-xl font-bold tracking-tight">Provider Latency</CardTitle>
              <CardDescription>Response times per hour (lower is better)</CardDescription>
            </div>
            <Badge variant="secondary" className="px-3 py-1 font-mono text-xs">
              <Activity className="h-3 w-3 mr-2 text-emerald-500 animate-pulse" />
              LIVE METRICS
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={320}>
            <AreaChart data={slidingData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="displayHour"
                tick={{ fontSize: 12 }}
                tickLine={false}
                interval={isMobile ? 'preserveStartEnd' : 'preserveEnd'}
              />
              <YAxis
                width={65}
                tick={{ fontSize: 12 }}
                tickLine={false}
                tickFormatter={(n) => `${Math.floor(n)}ms`}
              />
              <Tooltip content={({ payload, active, label }) => {
                if (!active || !payload) return null;
                return (
                  <div className="rounded-xl border bg-background/95 backdrop-blur-md p-3 shadow-2xl ring-1 ring-black/5 min-w-[140px]">
                    <p className="text-[10px] font-black text-muted-foreground mb-2 uppercase tracking-widest">{label}:00 HRS</p>
                    <div className="space-y-2">
                      {payload.map((category: any, idx: number) => (
                        <div key={idx} className="flex items-center justify-between gap-4">
                          <div className="flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: category.color }} />
                            <span className="text-xs font-semibold text-foreground capitalize">{category.dataKey}</span>
                          </div>
                          <span className="text-xs font-mono font-bold text-primary">{category.value}ms</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }} />
              {providerKeys.map((key) => (
                <Area
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stroke={providerColorMap[key.toLowerCase()] || '#64748b'}
                  fill={providerColorMap[key.toLowerCase()] || '#64748b'}
                  fillOpacity={0.1}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Performance Charts Section */}
      <Card>
        <CardHeader>
          <CardTitle>Performance Trends</CardTitle>
          <CardDescription>
            Volume and latency patterns over the last 24 hours (Local Time)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-12">
            {/* Request Volume Chart */}
            <div>
              <h4 className="text-sm font-medium mb-4 text-muted-foreground flex items-center gap-2">
                <Activity className="h-4 w-4" /> Request Volume
              </h4>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={requestMetrics.requestsPerHour}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#334155" opacity={0.2} />
                    <XAxis
                      dataKey="displayHour" // Changed from "hour"
                      tick={{ fontSize: 10, fill: '#94a3b8' }}
                      axisLine={false}
                      tickLine={false}
                      interval={isMobile ? 5 : 2}
                    />
                    <YAxis 
                      tick={{ fontSize: 10, fill: '#94a3b8' }} 
                      axisLine={false} 
                      tickLine={false} 
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '8px', fontSize: '12px' }}
                      itemStyle={{ color: '#f1f5f9' }}
                      labelStyle={{ color: '#94a3b8', marginBottom: '4px' }}
                      formatter={(value) => [value, "Requests"]}
                    />
                    <Line
                      type="monotone"
                      dataKey="requests"
                      stroke="#6366f1" // Indigo
                      strokeWidth={3}
                      dot={false}
                      activeDot={{ r: 4, strokeWidth: 0, fill: '#818cf8' }}
                      animationDuration={1500}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Response Times Chart */}
            <div>
              <h4 className="text-sm font-medium mb-4 text-muted-foreground flex items-center gap-2">
                <Clock className="h-4 w-4" /> Avg Response Latency
              </h4>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={requestMetrics.responseTimes}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#334155" opacity={0.2} />
                    <XAxis
                      dataKey="displayHour" // Changed from "hour"
                      tick={{ fontSize: 10, fill: '#94a3b8' }}
                      axisLine={false}
                      tickLine={false}
                      interval={isMobile ? 5 : 2}
                    />
                    <YAxis 
                      tick={{ fontSize: 10, fill: '#94a3b8' }} 
                      axisLine={false} 
                      tickLine={false}
                      unit="ms"
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '8px', fontSize: '12px' }}
                      itemStyle={{ color: '#f1f5f9' }}
                      labelStyle={{ color: '#94a3b8', marginBottom: '4px' }}
                      formatter={(value) => [`${value}ms`, "Latency"]}
                    />
                    <Bar
                      dataKey="responseTime"
                      fill="#10b981" // Emerald
                      radius={[4, 4, 0, 0]}
                      animationDuration={1500}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}