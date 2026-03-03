import React, { useState, useEffect, useRef } from "react";
import { AreaChart, Card as TremorCard, Title, Text, Color, BarList, Flex, Bold } from "@tremor/react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useAdmin } from "@/contexts/AdminContext";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { 
  useDashboardOverview,
  useDashboardAnalytics,
  useDashboardContent,
  useDashboardPerformance,
  useDashboardSystem,
  useDashboardOperations,
  useDashboardUsers,
  useClearCache,
  useExecuteMaintenanceTask,
  useClearErrorLogs,
  useClearUserData,
  type DashboardTab,
} from "@/hooks/useDashboardQueries";
import { UserManagementModal } from "./UserManagementModal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Activity,
  BarChart3,
  Clock,
  Database,
  Eye,
  Globe,
  HardDrive,
  Loader2,
  Monitor,
  Search,
  Server,
  Settings,
  Shield,
  Star,
  TrendingUp,
  Users,
  Wrench,
  LineChart,
  BarChart,
  Zap,
  RefreshCw,
  Key,
  LogOut,
  AlertCircle,
  Trash2,
  Square,
  Play,
} from "lucide-react";
import {
  LineChart as RechartsLineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart as RechartsBarChart,
  Bar,
  Legend,
} from "recharts";
import { AnimatedNumber, FadeValue } from "./AnimatedNumber";

const formatBytes = (bytes: number): string => {
  if (!bytes || bytes === 0) return "0 MB";
  return Math.round(bytes / 1024 / 1024) + " MB";
};

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

const getMemoryContext = (memoryUsage: number, systemData: any): string => {
  // Check if we have container/heap info to determine context
  if (systemData?.systemOverview?.memoryUsage) {
    const heapUsed = systemData.systemOverview.memoryUsage.heapUsed;
    const heapTotal = systemData.systemOverview.memoryUsage.heapTotal;
    const heapPercent = (heapUsed / heapTotal) * 100;

    // If memory usage is close to heap percentage, we're showing heap usage
    if (Math.abs(memoryUsage - heapPercent) < 10) {
      return "of heap allocated";
    }
  }

  // Check if running in container (memoryUsage < 100% usually means container limit)
  if (memoryUsage < 90) {
    return "of container limit";
  }

  return "system memory";
};

const detectEnvironment = (systemData: any): string => {
  if (!systemData?.systemOverview) return "Unknown";

  const platform = systemData.systemOverview.platform;

  // Check for container indicators
  if (systemData.systemOverview.processId === 1) {
    return "Docker";
  }

  // Platform-based detection
  if (platform === "linux") {
    return "Linux";
  } else if (platform === "darwin") {
    return "macOS";
  } else if (platform === "win32") {
    return "Windows";
  }

  return platform || "Unknown";
};

// Dashboard Overview Component
function DashboardOverview({ data, systemData, loading }) {
  const [systemStatus, setSystemStatus] = useState(() => ({
    status: data?.systemOverview?.status || "healthy",
    uptime: data?.systemOverview?.uptime || "0h 0m",
    version: data?.systemOverview?.version || "N/A",
    lastUpdate: data?.systemOverview?.lastUpdate || new Date().toLocaleString(),
  }));

  const [quickStats, setQuickStats] = useState(() => ({
    totalRequests: data?.quickStats?.totalRequests || 0,
    cacheHitRate: data?.quickStats?.cacheHitRate || 0,
    activeUsers: data?.quickStats?.activeUsers || 0,
    errorRate: data?.quickStats?.errorRate || 0,
  }));

  const [recentActivity, setRecentActivity] = useState(systemData?.recentActivity || []);

  // Update state when data prop changes
  useEffect(() => {
    if (data) {
      // Update quick stats from overview data
      if (data.quickStats) {
        setQuickStats({
          totalRequests: data.quickStats.totalRequests,
          cacheHitRate: data.quickStats.cacheHitRate,
          activeUsers: data.quickStats.activeUsers,
          errorRate: data.quickStats.errorRate,
        });
      }

      // Update system status from systemOverview
      if (data.systemOverview) {
        setSystemStatus({
          status: data.systemOverview.status,
          uptime: data.systemOverview.uptime,
          version: data.systemOverview.version,
          lastUpdate: data.systemOverview.lastUpdate,
        });
      }
    }
  }, [data]);

  // Update recent activity when systemData changes
  useEffect(() => {
    if (systemData && systemData.recentActivity) {
      console.log(
        "[Dashboard Overview] Received recent activity:",
        systemData.recentActivity,
      );
      setRecentActivity(systemData.recentActivity);
    }
  }, [systemData]);

  return (
    <div className="space-y-6">
      {/* System Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm font-medium">
                System Status
              </CardTitle>
              {data?.systemOverview && (
                <Badge variant="outline" className="text-xs font-normal">
                  {detectEnvironment(data)}
                </Badge>
              )}
            </div>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center space-x-2">
              <Badge
                variant={
                  systemStatus.status === "healthy"
                    ? "default"
                    : systemStatus.status === "warning"
                      ? "secondary"
                      : "destructive"
                }
              >
                <FadeValue value={systemStatus.status} />
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Uptime: {systemStatus.uptime}
            </p>
            {/* Warning Display */}
            {data?.systemOverview?.issues &&
              data.systemOverview.issues.length > 0 && (
                <div className="mt-2 space-y-1">
                  {data.systemOverview.issues.map((issue, idx) => {
                    const isMemoryIssue = issue
                      .toLowerCase()
                      .includes("memory");
                    const isCritical = issue.toLowerCase().includes("critical");
                    return (
                      <p
                        key={idx}
                        className={`text-xs ${isCritical ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"}`}
                      >
                        {issue}
                        {isMemoryIssue && (
                          <span className="block text-[10px] mt-0.5 opacity-80">
                            Based on actual memory usage vs available memory
                          </span>
                        )}
                      </p>
                    );
                  })}
                </div>
              )}
            {/*  Memory Usage */}
            {data?.systemOverview?.memoryUsage && (
              <div className="mt-2 pt-2 border-t text-xs">
                <div className="space-y-1">
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">
                      Process Memory:
                    </span>
                    <span className="font-medium">
                      {formatBytes(data.systemOverview.memoryUsage.rss)}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">User Requests</CardTitle>
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              <AnimatedNumber value={quickStats.totalRequests} />
            </div>
            <p className="text-xs text-muted-foreground">Today</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Cache Hit Rate
            </CardTitle>
            <Database className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              <AnimatedNumber value={quickStats.cacheHitRate} suffix="%" />
            </div>
            <Progress value={quickStats.cacheHitRate} className="mt-2" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              <AnimatedNumber value={quickStats.activeUsers} />
            </div>
            <p className="text-xs text-muted-foreground">Currently online</p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
          <CardDescription>
            Latest metadata requests and system events
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {recentActivity.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Activity className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No recent activity</p>
                <p className="text-sm">
                  Activity will appear here as requests come in
                </p>
              </div>
            ) : (
              recentActivity.map((activity, index) => (
                <div
                  key={index}
                  className="p-3 border rounded-lg"
                >
                  {/* Desktop layout */}
                  <div className="hidden sm:flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <div
                        className={`w-2 h-2 rounded-full ${
                          activity.type === "metadata_request"
                            ? "bg-blue-500"
                            : activity.type === "catalog_request"
                              ? "bg-green-500"
                              : "bg-gray-500"
                        }`}
                      ></div>
                      <div>
                        <p className="font-medium">
                          {activity.type === "metadata_request"
                            ? "Metadata Request"
                            : activity.type === "catalog_request"
                              ? "Catalog Request"
                              : "API Request"}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {activity.details.endpoint} • {activity.timeAgo}
                        </p>
                      </div>
                    </div>
                    <Badge variant="outline">{activity.details.method}</Badge>
                  </div>
                  {/* Mobile layout */}
                  <div className="sm:hidden">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center space-x-2">
                        <div
                          className={`w-2 h-2 rounded-full ${
                            activity.type === "metadata_request"
                              ? "bg-blue-500"
                              : activity.type === "catalog_request"
                                ? "bg-green-500"
                                : "bg-gray-500"
                          }`}
                        ></div>
                        <p className="font-medium text-sm">
                          {activity.type === "metadata_request"
                            ? "Metadata Request"
                            : activity.type === "catalog_request"
                              ? "Catalog Request"
                              : "API Request"}
                        </p>
                      </div>
                      <Badge variant="outline" className="text-xs">{activity.details.method}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {activity.details.endpoint} • {activity.timeAgo}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {/* System Alerts */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Shield className="h-5 w-5" />
            <span>System Alerts</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data?.systemOverview?.issues && data.systemOverview.issues.length > 0 ? (
            <div className="space-y-2">
              {data.systemOverview.issues.map((issue, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 p-2 rounded-lg bg-destructive/10 text-destructive"
                >
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  <span className="text-sm">{issue}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-4 text-muted-foreground">
              <Shield className="h-12 w-12 mx-auto mb-4 opacity-50 text-green-500" />
              <p>All systems operational</p>
              <p className="text-sm">No critical alerts at this time</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// Analytics & Performance Component
function DashboardAnalytics({ data, loading, isMobile }) {
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
          <Flex justifyContent="between" alignItems="center">
            <div>
              <CardTitle className="text-xl font-bold tracking-tight">Provider Latency</CardTitle>
              <CardDescription>Response times per hour (lower is better)</CardDescription>
            </div>
            <Badge variant="secondary" className="px-3 py-1 font-mono text-xs">
              <Activity className="h-3 w-3 mr-2 text-emerald-500 animate-pulse" />
              LIVE METRICS
            </Badge>
          </Flex>
        </CardHeader>
        <CardContent>
          <AreaChart
            className="h-80 mt-8"
            data={slidingData}
            index="displayHour" // <-- Use the string label "19:00"
            categories={providerKeys}
            colors={providerKeys.map(key => providerColorMap[key.toLowerCase()] || "slate")}
            curveType="monotone"
            stack={false}
            showXAxis={true}
            showYAxis={true}
            yAxisWidth={65}
            // Force the chart to show fewer labels on mobile to prevent overlap
            startEndOnly={isMobile} 
            valueFormatter={(number) => `${Math.floor(number)}ms`}
            // Custom Tooltip for that "Vercel" look
            customTooltip={({ payload, active, label }) => {
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
            }}
          />
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
                  <RechartsLineChart data={requestMetrics.requestsPerHour}>
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
                  </RechartsLineChart>
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
                  <RechartsBarChart data={requestMetrics.responseTimes}>
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
                  </RechartsBarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// Performance Metrics Component
// Data is now fetched via TanStack Query at the Dashboard level
// All performance data including idResolverPerformance comes from the timing endpoint
function DashboardPerformance({ data, loading }) {
  const [timingMetrics, setTimingMetrics] = useState(() => {
    if (data) {
      return {
        ...data.dashboard,
        providerBreakdown: data.providerBreakdown,
        resolutionBreakdown: data.resolutionBreakdown,
        timingTrends: data.timingTrends,
      };
    }
    return {};
  });
  const [selectedMetric, setSelectedMetric] = useState("id_resolution_total");
  const [timeRange, setTimeRange] = useState("24h");
  
  // Extract idResolverPerformance from timing data (now included in timing endpoint)
  const idResolverPerformance = data?.idResolverPerformance || {
    totalResolutions: 0,
    wikiMappingEarlyReturns: { count: 0, percentage: 0 },
    cacheEarlyReturns: { count: 0, percentage: 0 },
    apiCallsRequired: { count: 0, percentage: 0 },
    animeResolutions: { count: 0, percentage: 0 },
    earlyReturnRate: 0,
  };

  useEffect(() => {
    if (data) {
      // The API returns nested structure: { dashboard: {...}, providerBreakdown: {...}, ... }
      // We need to merge the dashboard metrics with the other data
      const processedData = {
        ...data.dashboard, // Main timing metrics
        providerBreakdown: data.providerBreakdown,
        resolutionBreakdown: data.resolutionBreakdown,
        timingTrends: data.timingTrends,
      };
      setTimingMetrics(processedData);
    }
  }, [data]);

  const formatDuration = (ms) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  const getMetricColor = (average, metricType = "general") => {
    // Different thresholds for different metric types
    if (metricType === "search") {
      if (average < 3000) return "text-green-600"; // Under 3 seconds = green
      if (average < 5000) return "text-yellow-600"; // 3-5 seconds = yellow
      if (average < 8000) return "text-orange-600"; // 5-8 seconds = orange
      return "text-red-600"; // Over 8 seconds = red
    } else {
      // General metrics (ID resolution, API calls, etc.) - Match the updated status thresholds
      if (average < 500) return "text-green-600"; // Under 500ms = green (Excellent)
      if (average < 1500) return "text-yellow-600"; // 500ms-1.5s = yellow (Good)
      if (average < 3000) return "text-orange-600"; // 1.5s-3s = orange (Fair)
      return "text-red-600"; // Over 3s = red (Poor)
    }
  };

  const getMetricStatus = (average, metricType = "general") => {
    // Different thresholds for different metric types
    if (metricType === "search") {
      if (average < 3000) return "Excellent"; // Under 3 seconds = Excellent
      if (average < 5000) return "Good"; // 3-5 seconds = Good
      if (average < 8000) return "Fair"; // 5-8 seconds = Fair
      return "Poor"; // Over 8 seconds = Poor
    } else {
      // General metrics (ID resolution, API calls, etc.) - More realistic thresholds
      if (average < 500) return "Excellent"; // Under 500ms = Excellent
      if (average < 1500) return "Good"; // 500ms-1.5s = Good
      if (average < 3000) return "Fair"; // 1.5s-3s = Fair
      return "Poor"; // Over 3s = Poor
    }
  };

  const getMetricBadgeVariant = (average, metricType = "general") => {
    const status = getMetricStatus(average, metricType);
    switch (status) {
      case "Excellent":
        return "default"; // Green-ish badge
      case "Good":
        return "secondary"; // Gray badge
      case "Fair":
        return "outline"; // Orange-ish badge
      case "Poor":
        return "destructive"; // Red badge
      default:
        return "secondary";
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </div>
    );
  }

  const metrics = Object.keys(timingMetrics);

  return (
    <div className="space-y-6">
      {/* Performance Overview */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {metrics.slice(0, 4).map((metric) => {
          const stats = timingMetrics[metric]?.overall || {};
          const isSearchMetric =
            metric.startsWith("search_") || metric === "search_operation";
          const metricType = isSearchMetric ? "search" : "general";
          const colorThreshold = isSearchMetric ? 3000 : 1500;

          return (
            <Card key={metric}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium capitalize">
                  {metric.replace(/_/g, " ")}
                </CardTitle>
                <Clock className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  <span
                    className={getMetricColor(stats.average || 0, metricType)}
                  >
                    {formatDuration(stats.average || 0)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Avg: {formatDuration(stats.average || 0)} • P95:{" "}
                  {formatDuration(stats.p95 || 0)} • Count: {stats.count || 0}
                </p>
                <Badge
                  variant={getMetricBadgeVariant(
                    stats.average || 0,
                    metricType,
                  )}
                  className="mt-2"
                >
                  {getMetricStatus(stats.average || 0, metricType)}
                </Badge>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Detailed Metrics */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ID Resolution Metrics */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              ID Resolution Performance
            </CardTitle>
            <CardDescription>
              Time taken to resolve external IDs for movies and series
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {[
                "id_resolution_total",
                "id_resolution_cache",
                "id_resolution_anime",
                "id_resolution_wiki",
              ].map((metric) => {
                const stats = timingMetrics[metric]?.overall || {};
                if (stats.count === 0) return null;

                return (
                  <div key={metric} className="p-4 rounded-lg border">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <h4 className="font-medium capitalize">
                          {metric.replace(/_/g, " ")}
                        </h4>
                        <p className="text-sm text-muted-foreground">
                          {stats.count} operations
                        </p>
                      </div>
                      <div className="text-right">
                        <div
                          className={`text-lg font-bold ${getMetricColor(stats.average || 0)}`}
                        >
                          {formatDuration(stats.average || 0)}
                        </div>
                        <div className="text-xs text-muted-foreground">avg</div>
                      </div>
                    </div>

                    {/* Compact timing summary */}
                    <div className="mt-2 text-xs text-muted-foreground">
                      <span>min {formatDuration(stats.min || 0)}</span>
                      <span className="mx-2">•</span>
                      <span>p50 {formatDuration(stats.p50 || 0)}</span>
                      <span className="mx-2">•</span>
                      <span>p95 {formatDuration(stats.p95 || 0)}</span>
                      <span className="mx-2">•</span>
                      <span>max {formatDuration(stats.max || 0)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Search Provider Performance */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Search className="h-5 w-5" />
              Search Provider Performance
            </CardTitle>
            <CardDescription>
              Search response times by provider (TMDB, TVDB, TVMaze, MAL, etc.)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {[
                "search_tmdb",
                "search_tvdb",
                "search_tvmaze",
                "search_mal",
                "search_kitsu",
              ].map((metric) => {
                const stats = timingMetrics[metric]?.overall || {};
                if (stats.count === 0) return null;

                const providerName = metric
                  .replace("search_", "")
                  .toUpperCase();

                return (
                  <div
                    key={metric}
                    className="flex items-center justify-between p-3 rounded-lg border"
                  >
                    <div>
                      <h4 className="font-medium">{providerName} Search</h4>
                      <p className="text-sm text-muted-foreground">
                        {stats.count} searches
                      </p>
                    </div>
                    <div className="text-right">
                      <div
                        className={`text-lg font-bold ${getMetricColor(stats.average || 0, "search")}`}
                      >
                        {formatDuration(stats.average || 0)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        P95: {formatDuration(stats.p95 || 0)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* API Performance */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-5 w-5" />
              API Performance
            </CardTitle>
            <CardDescription>
              External API response times and lookup performance
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {[
                "api_lookup",
                "nameToImdb_lookup",
                "imdb_scrape_lookup",
                "tmdb_external_ids",
                "tvdb_remote_ids",
                "tvmaze_externals",
                "search_operation",
              ].map((metric) => {
                const stats = timingMetrics[metric]?.overall || {};
                if (stats.count === 0) return null;

                // Use search thresholds for search_operation, general for others
                const metricType =
                  metric === "search_operation" ? "search" : "general";

                return (
                  <div key={metric} className="p-4 rounded-lg border">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <h4 className="font-medium capitalize">
                          {metric.replace(/_/g, " ")}
                        </h4>
                        <p className="text-sm text-muted-foreground">
                          {stats.count} operations
                        </p>
                      </div>
                      <div className="text-right">
                        <div
                          className={`text-lg font-bold ${getMetricColor(stats.average || 0, metricType)}`}
                        >
                          {formatDuration(stats.average || 0)}
                        </div>
                        <div className="text-xs text-muted-foreground">avg</div>
                      </div>
                    </div>

                    {/* Compact timing summary */}
                    <div className="mt-2 text-xs text-muted-foreground">
                      <span>min {formatDuration(stats.min || 0)}</span>
                      <span className="mx-2">•</span>
                      <span>p50 {formatDuration(stats.p50 || 0)}</span>
                      <span className="mx-2">•</span>
                      <span>p95 {formatDuration(stats.p95 || 0)}</span>
                      <span className="mx-2">•</span>
                      <span>max {formatDuration(stats.max || 0)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Search Provider Performance */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Search className="h-5 w-5" />
              Search Provider Performance
            </CardTitle>
            <CardDescription>
              Performance of actual search operations by provider (TMDB, TVDB,
              TVMaze, MAL)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {Object.entries((timingMetrics as any).providerBreakdown || {})
                .filter(([key, data]) => (data as any).type === "search")
                .map(([key, providerData]) => {
                  const stats = providerData as any;
                  if (stats.count === 0) return null;

                  const providerName = stats.provider || key.toUpperCase();

                  return (
                    <div key={key} className="p-4 rounded-lg border">
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <h4 className="font-medium">
                            {providerName} Provider
                          </h4>
                          <p className="text-sm text-muted-foreground">
                            {stats.count} search operations
                          </p>
                        </div>
                        <div className="text-right">
                          <div
                            className={`text-lg font-bold ${getMetricColor(stats.average || 0, "search")}`}
                          >
                            {formatDuration(stats.average || 0)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            avg response
                          </div>
                          {stats.success_rate !== undefined && (
                            <div
                              className={`text-xs mt-1 ${
                                stats.success_rate >= 95
                                  ? "text-green-600"
                                  : stats.success_rate >= 90
                                    ? "text-yellow-600"
                                    : "text-red-600"
                              }`}
                            >
                              {stats.success_rate}% success
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Compact timing summary */}
                      <div className="mt-2 text-xs text-muted-foreground">
                        <span>min {formatDuration(stats.min || 0)}</span>
                        <span className="mx-2">•</span>
                        <span>p50 {formatDuration(stats.p50 || 0)}</span>
                        <span className="mx-2">•</span>
                        <span>p95 {formatDuration(stats.p95 || 0)}</span>
                        {stats.p99 ? (
                          <>
                            <span className="mx-2">•</span>
                            <span>p99 {formatDuration(stats.p99 || 0)}</span>
                          </>
                        ) : null}
                        <span className="mx-2">•</span>
                        <span>max {formatDuration(stats.max || 0)}</span>
                      </div>
                    </div>
                  );
                })}
              {Object.entries(
                (timingMetrics as any).providerBreakdown || {},
              ).filter(([key, data]) => (data as any).type === "search")
                .length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  <Search className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No search operations recorded yet</p>
                  <p className="text-sm">
                    Search providers will appear here after you perform searches
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Secondary API Call Performance */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              ID Resolution API Calls
            </CardTitle>
            <CardDescription>
              Performance of API calls during ID resolution (TMDB external IDs,
              TVDB remote IDs, TVMaze lookups, etc.)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {Object.entries((timingMetrics as any).providerBreakdown || {})
                .filter(([key, data]) => (data as any).type === "secondary")
                .map(([key, providerData]) => {
                  const stats = providerData as any;
                  if (stats.count === 0) return null;

                  const operationName = (stats.operation || key)
                    .replace(/_/g, " ")
                    .toUpperCase();

                  return (
                    <div
                      key={key}
                      className="p-4 rounded-lg border"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <h4 className="font-medium">{operationName}</h4>
                          <p className="text-sm text-muted-foreground">
                            {stats.count} ID resolution calls
                          </p>
                        </div>
                        <div className="text-right">
                          <div
                            className={`text-lg font-bold ${getMetricColor(stats.average || 0)}`}
                          >
                            {formatDuration(stats.average || 0)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            avg lookup
                          </div>
                        </div>
                      </div>

                      {/* Compact timing summary */}
                      <div className="mt-2 text-xs text-muted-foreground">
                        <span>min {formatDuration(stats.min || 0)}</span>
                        <span className="mx-2">•</span>
                        <span>p50 {formatDuration(stats.p50 || 0)}</span>
                        <span className="mx-2">•</span>
                        <span>p95 {formatDuration(stats.p95 || 0)}</span>
                        <span className="mx-2">•</span>
                        <span>max {formatDuration(stats.max || 0)}</span>
                      </div>
                    </div>
                  );
                })}
            </div>
          </CardContent>
        </Card>

        {/* Timing Trends Over Time */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Timing Trends
            </CardTitle>
            <CardDescription>
              Performance trends over different time periods (1h, 24h, 7d)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {["id_resolution_total", "search_operation", "api_lookup"].map(
                (metric) => {
                  const trends =
                    (timingMetrics as any).timingTrends?.[metric] || {};
                  if (!trends || Object.keys(trends).length === 0) return null;

                  return (
                    <div key={metric} className="p-4 rounded-lg border">
                      <div className="mb-3">
                        <h4 className="font-medium capitalize">
                          {metric.replace(/_/g, " ")}
                        </h4>
                        <p className="text-sm text-muted-foreground">
                          Performance trends across time periods
                        </p>
                      </div>

                      {/* Time period breakdown */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        {Object.entries(trends).map(([period, data]) => {
                          const trendData = data as any;
                          return (
                            <div
                              key={period}
                              className="text-center p-3 bg-muted rounded"
                            >
                              <div className="font-medium text-lg">
                                {formatDuration(trendData.average || 0)}
                              </div>
                              <div className="text-sm text-muted-foreground">
                                {period} average
                              </div>
                              <div className="text-xs text-muted-foreground mt-1">
                                {trendData.count || 0} operations
                              </div>
                              {trendData.p95 && (
                                <div className="text-xs text-orange-600 mt-1">
                                  P95: {formatDuration(trendData.p95)}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                },
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Performance Insights */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Performance Insights
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 rounded-lg bg-muted">
              <h4 className="font-medium mb-2">Cache Effectiveness</h4>
              <p className="text-sm text-muted-foreground">
                {timingMetrics?.["id_resolution_cache"]?.overall?.count > 0 ? (
                  <>
                    Cache hits are averaging{" "}
                    <span className="font-medium text-green-600">
                      {formatDuration(
                        timingMetrics?.["id_resolution_cache"]?.overall
                          ?.average || 0,
                      )}
                    </span>
                    , significantly faster than API lookups.
                  </>
                ) : (
                  "No cache data available yet."
                )}
              </p>
            </div>

            <div className="p-4 rounded-lg bg-muted">
              <h4 className="font-medium mb-2">API Performance</h4>
              <p className="text-sm text-muted-foreground">
                {timingMetrics?.["api_lookup"]?.overall?.average ? (
                  <>
                    External API calls average{" "}
                    <span className="font-medium">
                      {formatDuration(
                        timingMetrics?.["api_lookup"]?.overall?.average || 0,
                      )}
                    </span>
                    . Consider caching strategies for slower endpoints.
                  </>
                ) : (
                  "No API timing data available yet."
                )}
              </p>
            </div>

            <div className="p-4 rounded-lg bg-muted">
              <h4 className="font-medium mb-2">Search Performance</h4>
              <p className="text-sm text-muted-foreground">
                {timingMetrics?.["search_operation"]?.overall?.average ? (
                  <>
                    Search operations average{" "}
                    <span className="font-medium">
                      {formatDuration(
                        timingMetrics?.["search_operation"]?.overall?.average ||
                          0,
                      )}
                    </span>
                    .{" "}
                    {timingMetrics?.["search_operation"]?.overall?.average >
                    5000
                      ? "Consider optimizing search queries or implementing search caching."
                      : "Search performance looks good!"}
                  </>
                ) : (
                  "No search timing data available yet."
                )}
              </p>
            </div>

            <div className="p-4 rounded-lg bg-muted">
              <h4 className="font-medium mb-2">Provider Performance</h4>
              <p className="text-sm text-muted-foreground">
                {(() => {
                  const providers = [
                    "search_tmdb",
                    "search_tvdb",
                    "search_tvmaze",
                    "search_mal",
                  ];
                  const providerStats = providers
                    .map((provider) => ({
                      name: provider.replace("search_", "").toUpperCase(),
                      avg: timingMetrics?.[provider]?.overall?.average || 0,
                      count: timingMetrics?.[provider]?.overall?.count || 0,
                    }))
                    .filter((p) => p.count > 0);

                  if (providerStats.length === 0) {
                    return "No provider timing data available yet.";
                  }

                  const fastest = providerStats.reduce((min, p) =>
                    p.avg < min.avg ? p : min,
                  );
                  const slowest = providerStats.reduce((max, p) =>
                    p.avg > max.avg ? p : max,
                  );

                  return (
                    <>
                      <span className="font-medium text-green-600">
                        {fastest.name}
                      </span>{" "}
                      is fastest ({formatDuration(fastest.avg)})
                      {slowest.name !== fastest.name && (
                        <>
                          {" "}
                          while{" "}
                          <span className="font-medium text-orange-600">
                            {slowest.name}
                          </span>{" "}
                          is slowest ({formatDuration(slowest.avg)})
                        </>
                      )}
                    </>
                  );
                })()}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ID Resolver Performance */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4" />
            ID Resolver Performance
          </CardTitle>
          <CardDescription>
            Performance breakdown of ID resolution process
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Overview Stats */}
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="text-center p-4 bg-blue-50 rounded-lg">
                  <div className="text-2xl font-bold text-blue-600">
                    <AnimatedNumber value={idResolverPerformance.totalResolutions} />
                  </div>
                  <div className="text-sm text-blue-600">Total Resolutions</div>
                </div>
                <div className="text-center p-4 bg-green-50 rounded-lg">
                  <div className="text-2xl font-bold text-green-600">
                    <AnimatedNumber value={idResolverPerformance.earlyReturnRate} suffix="%" />
                  </div>
                  <div className="text-sm text-green-600">
                    Early Return Rate
                  </div>
                </div>
              </div>

              {/* Breakdown */}
              <div className="space-y-2">
                <div className="flex justify-between items-center p-2 bg-gray-50 rounded">
                  <span className="text-sm text-gray-900">Wiki Mappings</span>
                  <div className="text-right">
                    <div className="text-sm font-medium text-gray-900">
                      <AnimatedNumber value={idResolverPerformance.wikiMappingEarlyReturns.count} />
                    </div>
                    <div className="text-xs text-green-700">
                      <AnimatedNumber value={idResolverPerformance.wikiMappingEarlyReturns.percentage} suffix="%" />
                    </div>
                  </div>
                </div>
                <div className="flex justify-between items-center p-2 bg-gray-50 rounded">
                  <span className="text-sm text-gray-900">Cache Hits</span>
                  <div className="text-right">
                    <div className="text-sm font-medium text-gray-900">
                      <AnimatedNumber value={idResolverPerformance.cacheEarlyReturns.count} />
                    </div>
                    <div className="text-xs text-blue-700">
                      <AnimatedNumber value={idResolverPerformance.cacheEarlyReturns.percentage} suffix="%" />
                    </div>
                  </div>
                </div>
                <div className="flex justify-between items-center p-2 bg-gray-50 rounded">
                  <span className="text-sm text-gray-900">
                    Anime Resolutions
                  </span>
                  <div className="text-right">
                    <div className="text-sm font-medium text-gray-900">
                      <AnimatedNumber value={idResolverPerformance.animeResolutions.count} />
                    </div>
                    <div className="text-xs text-purple-700">
                      <AnimatedNumber value={idResolverPerformance.animeResolutions.percentage} suffix="%" />
                    </div>
                  </div>
                </div>
                <div className="flex justify-between items-center p-2 bg-red-50 rounded">
                  <span className="text-sm text-gray-900">
                    API Calls Required
                  </span>
                  <div className="text-right">
                    <div className="text-sm font-medium text-gray-900">
                      <AnimatedNumber value={idResolverPerformance.apiCallsRequired.count} />
                    </div>
                    <div className="text-xs text-red-700">
                      <AnimatedNumber value={idResolverPerformance.apiCallsRequired.percentage} suffix="%" />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Visual Chart */}
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <RechartsBarChart
                  data={[
                    {
                      name: "Wiki Mappings",
                      value:
                        idResolverPerformance.wikiMappingEarlyReturns
                          .percentage,
                      fill: "#10b981",
                    },
                    {
                      name: "Cache Hits",
                      value: idResolverPerformance.cacheEarlyReturns.percentage,
                      fill: "#3b82f6",
                    },
                    {
                      name: "Anime",
                      value: idResolverPerformance.animeResolutions.percentage,
                      fill: "#8b5cf6",
                    },
                    {
                      name: "API Calls",
                      value: idResolverPerformance.apiCallsRequired.percentage,
                      fill: "#ef4444",
                    },
                  ]}
                  layout="horizontal"
                  margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    type="number"
                    domain={[0, 100]}
                    tickFormatter={(value) => `${value}%`}
                  />
                  <YAxis type="category" dataKey="name" width={80} />
                  <Tooltip formatter={(value) => [`${value}%`, "Percentage"]} />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]} />
                </RechartsBarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* IMDb Ratings Stats */}
      {data?.imdbRatingsStats && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              IMDb Ratings Performance
            </CardTitle>
            <CardDescription>
              Dataset hit/miss statistics
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 rounded-lg border">
                <div>
                  <h4 className="font-medium">Dataset Hits</h4>
                  <p className="text-sm text-muted-foreground">
                    From IMDb official dataset
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold text-green-600">
                    <AnimatedNumber value={data.imdbRatingsStats.datasetHits} />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    <AnimatedNumber value={data.imdbRatingsStats.datasetPercentage} suffix="%" />
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border">
                <div>
                  <h4 className="font-medium">Dataset Misses</h4>
                  <p className="text-sm text-muted-foreground">
                    Not found in dataset
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold text-orange-600">
                    <AnimatedNumber value={data.imdbRatingsStats.datasetMisses} />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    <AnimatedNumber value={data.imdbRatingsStats.missPercentage} suffix="%" />
                  </div>
                </div>
              </div>

              <div className="pt-2 border-t">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Total Requests:</span>
                  <span className="font-medium">
                    <AnimatedNumber value={data.imdbRatingsStats.totalRequests} />
                  </span>
                </div>
                <div className="flex justify-between text-sm mt-1">
                  <span className="text-muted-foreground">Ratings Loaded:</span>
                  <span className="font-medium">
                    <AnimatedNumber value={data.imdbRatingsStats.ratingsLoaded} />
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// Content Intelligence Component
// Data is now fetched via TanStack Query at the Dashboard level
function DashboardContent({ data, loading }) {
  const [searchLimit, setSearchLimit] = useState(10);

  // Extract data from props (fetched by TanStack Query)
  const popularContent = data?.popularContent || [];
  const searchPatterns = data?.searchPatterns || [];
  const contentQuality = data?.contentQuality || {
    missingMetadata: 0,
    failedMappings: 0,
    correctionRequests: 0,
    successRate: 0,
  };

  // fetches all data
  const filteredSearchPatterns = searchPatterns.slice(0, searchLimit);

  return (
    <div className="space-y-6">
      {/* Popular Content */}
      <Card>
        <CardHeader>
          <CardTitle>Popular Content</CardTitle>
          <CardDescription>
            Most requested titles and their ratings
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {popularContent.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Globe className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No popular content yet</p>
                <p className="text-sm">
                  Content will appear here as users request metadata
                </p>
              </div>
            ) : (
              popularContent.map((content, index) => (
                <div
                  key={index}
                  className="p-3 border rounded-lg"
                >
                  {/* Desktop layout */}
                  <div className="hidden sm:flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <Badge
                        variant={
                          content.type === "movie" || content.type === "series"
                            ? "default"
                            : "secondary"
                        }
                      >
                        {content.type}
                      </Badge>
                      <span className="font-medium">{content.title}</span>
                    </div>
                    <div className="flex items-center space-x-4">
                      <div className="text-right">
                        <p className="text-sm text-muted-foreground">Requests</p>
                        <p className="font-medium">{content.requests}</p>
                      </div>
                      {content.rating && (
                        <div className="text-right">
                          <p className="text-sm text-muted-foreground">Rating</p>
                          <p className="font-medium">
                            ⭐ {String(content.rating)}
                          </p>
                        </div>
                      )}
                      {content.year && (
                        <div className="text-right">
                          <p className="text-sm text-muted-foreground">Year</p>
                          <p className="font-medium">{String(content.year)}</p>
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Mobile layout */}
                  <div className="sm:hidden">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center space-x-2 min-w-0">
                        <Badge
                          variant={
                            content.type === "movie" || content.type === "series"
                              ? "default"
                              : "secondary"
                          }
                          className="flex-shrink-0"
                        >
                          {content.type}
                        </Badge>
                        <span className="font-medium truncate">{content.title}</span>
                      </div>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Requests</span>
                      <span className="font-medium">{content.requests}</span>
                    </div>
                    {content.rating && (
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Rating</span>
                        <span className="font-medium">⭐ {String(content.rating)}</span>
                      </div>
                    )}
                    {content.year && (
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Year</span>
                        <span className="font-medium">{String(content.year)}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {/* Search Patterns */}
      <Card>
        <CardHeader>
          <CardTitle>Search Patterns</CardTitle>
          <CardDescription>
            Most common search queries (shows today + yesterday)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Show</span>
            <select
              value={searchLimit}
              onChange={(e) => setSearchLimit(parseInt(e.target.value) || 10)}
              className="px-2 py-1 border rounded-md bg-background text-sm"
            >
              <option value={10}>Top 10</option>
              <option value={20}>Top 20</option>
              <option value={50}>Top 50</option>
            </select>
          </div>
          {filteredSearchPatterns.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <BarChart3 className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No search patterns yet</p>
              <p className="text-sm">
                Search queries will appear here as users search for content
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-3">
              {(() => {
                const counts = filteredSearchPatterns.map((p: any) => p.count);
                const min = Math.min(...counts);
                const max = Math.max(...counts);
                const scale = (count: number) => {
                  if (max === min) return 16; // px
                  const t = (count - min) / (max - min);
                  return Math.round(14 + t * 22); // 14px -> 36px
                };
                return filteredSearchPatterns.map((p: any, idx: number) => (
                  <span
                    key={idx}
                    title={`"${p.query}" • Count: ${p.count}`}
                    className="select-none cursor-default inline-block"
                    style={{
                      fontSize: `${scale(p.count)}px`,
                      lineHeight: 1.1,
                      color: "hsl(220 60% 55%)",
                    }}
                  >
                    {p.query}
                  </span>
                ));
              })()}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Content Quality Metrics - Placeholder, hidden for now
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Content Quality</CardTitle>
            <CardDescription>
              Metadata completeness and accuracy
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Missing Metadata</span>
                <span className="text-2xl font-bold text-orange-600">
                  {contentQuality.missingMetadata}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Failed Mappings</span>
                <span className="text-2xl font-bold text-red-600">
                  {contentQuality.failedMappings}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Success Rate</span>
                <span className="text-2xl font-bold text-green-600">
                  {contentQuality.successRate}%
                </span>
              </div>
              <Progress value={contentQuality.successRate} className="mt-2" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Correction Requests</CardTitle>
            <CardDescription>
              User feedback and correction submissions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-center py-8">
              <div className="text-3xl font-bold text-blue-600 mb-2">
                {contentQuality.correctionRequests}
              </div>
              <p className="text-sm text-muted-foreground">
                Pending corrections
              </p>
              <Button className="mt-4" variant="outline">
                View All
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
      */}

      {/* Content Trends Placeholder - Hidden for now
      <Card>
        <CardHeader>
          <CardTitle>Content Trends</CardTitle>
          <CardDescription>
            Popular genres and seasonal patterns
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-12 text-muted-foreground">
            <Globe className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>Content Trend Charts</p>
            <p className="text-sm">
              Charts will be implemented in the next step
            </p>
          </div>
        </CardContent>
      </Card>
      */}
    </div>
  );
}

// System Management Component
function DashboardSystem({ data, loading }) {
  const [systemConfig, setSystemConfig] = useState(() => data?.systemConfig || {
    language: "en-US",
    metaProvider: "tvdb",
    artProvider: "tvdb",
    animeIdProvider: "imdb",
    cacheEnabled: true,
    redisConnected: false,
    totalUsers: 0,
    sampleSize: 0,
    lastUpdated: new Date().toISOString(),
    aggregatedStats: {
      metaProviders: { movie: [], series: [], anime: [] },
      languages: [],
      features: {
        cacheEnabled: 100,
        blurThumbs: 0,
        skipFiller: 0,
        skipRecap: 0,
        allowEpisodeMarking: 0,
      },
    },
  });

  const [resourceUsage, setResourceUsage] = useState(() => data?.resourceUsage || {
    memoryUsage: 0,
    cpuUsage: 0,
    diskUsage: 0,
    requestsPerMin: 0,
  });

  const [providerStatus, setProviderStatus] = useState(() => data?.providerStatus || []);
  const [recentActivity, setRecentActivity] = useState(() => data?.recentActivity || []);

  useEffect(() => {
    if (data) {
      // Only update if data.systemConfig exists to prevent undefined crash
      if (data.systemConfig) {
        setSystemConfig(data.systemConfig);
      }
      if (data.resourceUsage) {
        setResourceUsage(data.resourceUsage);
      }
      if (data.providerStatus) {
        setProviderStatus(data.providerStatus);
      }
      if (data.recentActivity) {
        setRecentActivity(data.recentActivity);
      }
    }
  }, [data]);

  return (
    <div className="space-y-6">
      {/* User Configuration Statistics - Header Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-center gap-3">
            <div className="p-2 rounded-lg bg-muted">
              <Users className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <CardTitle className="text-lg">User Configuration Statistics</CardTitle>
              <CardDescription>
                How {systemConfig.totalUsers || 0} users configure their addon
                {systemConfig.sampleSize &&
                  systemConfig.sampleSize < systemConfig.totalUsers &&
                  ` (${systemConfig.sampleSize} sampled)`}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Provider Preferences Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          { title: "Movies", icon: Monitor, data: systemConfig.aggregatedStats?.metaProviders?.movie, color: "blue" },
          { title: "Series", icon: TrendingUp, data: systemConfig.aggregatedStats?.metaProviders?.series, color: "emerald" },
          { title: "Anime", icon: Zap, data: systemConfig.aggregatedStats?.metaProviders?.anime, color: "pink" },
        ].map((category) => (
          <Card key={category.title} className="overflow-hidden">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{category.title} Providers</CardTitle>
              <category.icon className={`h-4 w-4 text-${category.color}-500`} />
            </CardHeader>
            <CardContent className="pt-0">
              <div className="space-y-3">
                {category.data?.slice(0, 3).map((provider, index) => (
                  <div key={index} className="space-y-1">
                    <div className="flex justify-between items-center text-sm">
                      <span className="font-medium">{provider.name.toUpperCase()}</span>
                      <span className="text-muted-foreground">{provider.percentage}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          index === 0 ? `bg-${category.color}-500` :
                          index === 1 ? `bg-${category.color}-400` : `bg-${category.color}-300`
                        }`}
                        style={{ width: `${provider.percentage}%` }}
                      />
                    </div>
                  </div>
                )) || (
                  <p className="text-sm text-muted-foreground text-center py-4">No data available</p>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Language Distribution & Feature Usage Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Language Distribution */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Language Distribution</CardTitle>
            <Globe className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {systemConfig.aggregatedStats?.languages?.slice(0, 5).map((lang, index) => {
                const colors = ["bg-violet-500", "bg-blue-500", "bg-cyan-500", "bg-teal-500", "bg-emerald-500"];
                return (
                  <div key={index} className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${colors[index]}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-sm font-medium truncate">{lang.name}</span>
                        <span className="text-sm text-muted-foreground ml-2">{lang.percentage}%</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full ${colors[index]} transition-all duration-500`}
                          style={{ width: `${lang.percentage}%` }}
                        />
                      </div>
                    </div>
                  </div>
                );
              }) || (
                <p className="text-sm text-muted-foreground text-center py-4">No language data available</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Feature Usage */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Feature Adoption</CardTitle>
            <Settings className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              {/* Watch Tracking */}
              <div className="p-4 rounded-xl bg-card border shadow-sm">
                <div className="flex items-center gap-2 mb-4">
                  <Eye className="h-5 w-5 text-blue-500" />
                  <p className="text-sm font-bold">Watch Tracking Adoption</p>
                </div>
                
                <BarList
                  data={[
                    { name: "AniList", value: systemConfig.aggregatedStats?.features?.anilistWatchTracking || 0, icon: () => <div className="w-2 h-2 rounded-full bg-blue-500 mr-2" /> },
                    { name: "MDBList", value: systemConfig.aggregatedStats?.features?.mdblistWatchTracking || 0, icon: () => <div className="w-2 h-2 rounded-full bg-indigo-500 mr-2" /> },
                    { name: "Simkl", value: systemConfig.aggregatedStats?.features?.simklWatchTracking || 0, icon: () => <div className="w-2 h-2 rounded-full bg-red-500 mr-2" /> },
                    { name: "Trakt", value: systemConfig.aggregatedStats?.features?.traktWatchTracking || 0, icon: () => <div className="w-2 h-2 rounded-full bg-red-600 mr-2" /> },
                  ]}                  className="mt-2"
                  valueFormatter={(number: number) => `${number}%`}
                  color="blue"
                />
                
                <Flex className="mt-6 pt-4 border-t border-border">
                  <Text className="truncate">
                    <Bold>AniList</Bold> is currently the most popular tracker
                  </Text>
                </Flex>
              </div>

              {/* Rating Posters */}
              <div className="p-3 rounded-lg bg-muted/50">
                <div className="flex items-center gap-2 mb-2">
                  <Star className="h-4 w-4 text-yellow-500" />
                  <p className="text-xs font-medium">Rating Posters</p>
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">RPDB</span>
                    <span className="font-semibold">{systemConfig.aggregatedStats?.features?.ratingPostersRpdb || 0}%</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">TOP</span>
                    <span className="font-semibold">{systemConfig.aggregatedStats?.features?.ratingPostersTop || 0}%</span>
                  </div>
                </div>
              </div>

              {/* AI Search */}
              <div className="p-3 rounded-lg bg-muted/50">
                <div className="flex items-center gap-2 mb-2">
                  <Search className="h-4 w-4 text-blue-500" />
                  <p className="text-xs font-medium">AI Search</p>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground text-sm">Enabled</span>
                  <span className="text-lg font-semibold">{systemConfig.aggregatedStats?.features?.aiSearchEnabled || 0}%</span>
                </div>
              </div>

              {/* MAL Features */}
              <div className="p-3 rounded-lg bg-muted/50">
                <div className="flex items-center gap-2 mb-2">
                  <Zap className="h-4 w-4 text-violet-500" />
                  <p className="text-xs font-medium">MAL Features</p>
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Skip Filler</span>
                    <span className="font-semibold">{systemConfig.aggregatedStats?.features?.skipFiller || 0}%</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Skip Recap</span>
                    <span className="font-semibold">{systemConfig.aggregatedStats?.features?.skipRecap || 0}%</span>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Resource Monitoring */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Resource Usage</CardTitle>
            <CardDescription>System resource consumption</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Memory Usage</span>
                  <div className="text-right">
                    <span
                      className={`font-medium ${
                        resourceUsage.memoryUsage > 90
                        ? "text-red-600"
                        : resourceUsage.memoryUsage > 75
                          ? "text-orange-600"
                          : "text-green-600"
                    }`}
                  >
                    <AnimatedNumber value={resourceUsage.memoryUsage} suffix="%" />
                  </span>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {resourceUsage.memoryUsage > 70
                      ? data?.systemConfig?.redisConnected
                        ? "of container limit"
                        : "of heap allocated"
                      : getMemoryContext(resourceUsage.memoryUsage, data)}
                  </p>
                </div>
              </div>
              <Progress
                value={resourceUsage.memoryUsage}
                className={`h-2 ${
                  resourceUsage.memoryUsage > 90
                    ? "[&>div]:bg-red-600"
                    : resourceUsage.memoryUsage > 75
                      ? "[&>div]:bg-orange-600"
                      : ""
                }`}
              />
              {resourceUsage.memoryUsage > 90 && (
                <p className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  High memory usage - consider restarting or clearing cache
                </p>
              )}
              {resourceUsage.memoryUsage > 75 &&
                resourceUsage.memoryUsage <= 90 && (
                  <p className="text-xs text-orange-600 dark:text-orange-400 flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" />
                    Memory usage elevated - monitor closely
                  </p>
                )}
            </div>

            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span>CPU Usage</span>
                <span
                  className={`font-medium ${
                    resourceUsage.cpuUsage > 80
                      ? "text-red-600"
                      : resourceUsage.cpuUsage > 60
                        ? "text-orange-600"
                        : "text-green-600"
                  }`}
                >
                  <AnimatedNumber value={resourceUsage.cpuUsage} suffix="%" />
                </span>
              </div>
              <Progress
                value={resourceUsage.cpuUsage}
                className={`h-2 ${
                  resourceUsage.cpuUsage > 80
                    ? "[&>div]:bg-red-600"
                    : resourceUsage.cpuUsage > 60
                      ? "[&>div]:bg-orange-600"
                      : ""
                }`}
              />
            </div>

            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span>Disk Usage</span>
                <span
                  className={`font-medium ${
                    resourceUsage.diskUsage > 90
                      ? "text-red-600"
                      : resourceUsage.diskUsage > 75
                        ? "text-orange-600"
                        : "text-green-600"
                  }`}
                >
                  <AnimatedNumber value={resourceUsage.diskUsage} suffix="%" />
                </span>
              </div>
              <Progress
                value={resourceUsage.diskUsage}
                className={`h-2 ${
                  resourceUsage.diskUsage > 90
                    ? "[&>div]:bg-red-600"
                    : resourceUsage.diskUsage > 75
                      ? "[&>div]:bg-orange-600"
                      : ""
                }`}
              />
            </div>
          </div>
        </CardContent>
      </Card>

        <Card>
          <CardHeader>
            <CardTitle>Request Rate</CardTitle>
            <CardDescription>Current request throughput</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-center py-8">
              <div className="text-3xl font-bold text-blue-600 mb-2">
                <AnimatedNumber value={resourceUsage.requestsPerMin} />
              </div>
              <p className="text-sm text-muted-foreground">req/min</p>
              <p className="text-xs text-muted-foreground mt-2">
                Rolling average this hour
              </p>
            </div>
        </CardContent>
      </Card>
      </div>

      {/* Provider Status */}
      <Card>
        <CardHeader>
          <CardTitle>Provider Status</CardTitle>
          <CardDescription>
            Health and performance of metadata providers
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[...providerStatus]
              .sort((a, b) => (b.stats?.callsToday || 0) - (a.stats?.callsToday || 0))
              .map((provider, index) => (
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
                          : provider.status === "degraded"
                            ? "bg-yellow-500"
                            : provider.status === "down"
                              ? "bg-red-500"
                              : "bg-gray-400"
                      }`}
                    ></div>
                    <div>
                      <span className="font-medium">{provider.name}</span>
                      {provider.keyStatus && (
                        <span className={`ml-2 text-xs ${
                          provider.keyStatus === "Disabled"
                            ? "text-muted-foreground"
                            : "text-green-600 dark:text-green-400"
                        }`}>
                          ({provider.keyStatus})
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center space-x-4">
                    {provider.stats ? (
                      <>
                        <div className="text-right">
                          <p className="text-sm font-medium">
                            <AnimatedNumber value={provider.stats.callsToday} />
                          </p>
                          <p className="text-xs text-muted-foreground">calls today</p>
                        </div>
                        <div className="text-right min-w-[60px]">
                          <p className={`text-sm font-medium ${
                            provider.stats.successRate === null
                              ? "text-muted-foreground"
                              : provider.stats.successRate >= 95
                                ? "text-green-600"
                                : provider.stats.successRate >= 80
                                  ? "text-yellow-600"
                                  : "text-red-600"
                          }`}>
                            {provider.stats.successRate !== null 
                              ? <AnimatedNumber value={provider.stats.successRate} suffix="%" />
                              : "—"}
                          </p>
                          <p className="text-xs text-muted-foreground">success</p>
                        </div>
                      </>
                    ) : (
                      <span className="text-sm text-muted-foreground">No tracking data</span>
                    )}
                    <Badge
                      variant={
                        provider.status === "healthy"
                          ? "default"
                          : provider.status === "degraded"
                            ? "secondary"
                            : provider.status === "down"
                              ? "destructive"
                              : "outline"
                      }
                      className="min-w-[70px] justify-center"
                    >
                      {provider.status === "unknown" ? "No data" : provider.status}
                    </Badge>
                  </div>
                </div>

                {/* Mobile layout */}
                <div className="sm:hidden">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div
                        className={`w-3 h-3 rounded-full flex-shrink-0 ${
                          provider.status === "healthy"
                            ? "bg-green-500"
                            : provider.status === "degraded"
                              ? "bg-yellow-500"
                              : provider.status === "down"
                                ? "bg-red-500"
                                : "bg-gray-400"
                        }`}
                      ></div>
                      <span className="font-medium truncate">{provider.name}</span>
                    </div>
                    <Badge
                      variant={
                        provider.status === "healthy"
                          ? "default"
                          : provider.status === "degraded"
                            ? "secondary"
                            : provider.status === "down"
                              ? "destructive"
                              : "outline"
                      }
                      className="flex-shrink-0"
                    >
                      {provider.status === "unknown" ? "No data" : provider.status}
                    </Badge>
                  </div>
                  {provider.stats ? (
                    <div className="flex items-center justify-between mt-2 text-sm">
                      <div>
                        <span className="font-medium"><AnimatedNumber value={provider.stats.callsToday} /></span>
                        <span className="text-muted-foreground ml-1">calls</span>
                      </div>
                      <div>
                        <span className={`font-medium ${
                          provider.stats.successRate === null
                            ? "text-muted-foreground"
                            : provider.stats.successRate >= 95
                              ? "text-green-600"
                              : provider.stats.successRate >= 80
                                ? "text-yellow-600"
                                : "text-red-600"
                        }`}>
                          {provider.stats.successRate !== null 
                            ? <AnimatedNumber value={provider.stats.successRate} suffix="%" />
                            : "—"}
                        </span>
                        <span className="text-muted-foreground ml-1">success</span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground mt-2">No tracking data</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* System Health */}
      <Card>
        <CardHeader>
          <CardTitle>System Health</CardTitle>
          <CardDescription>
            Overall system status and recommendations
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(() => {
            // Calculate overall health status
            const issues: { message: string; severity: "warning" | "critical" }[] = [];
            
            // Check Redis
            if (!systemConfig.redisConnected) {
              issues.push({ message: "Redis disconnected", severity: "critical" });
            }
            
            // Check memory usage
            if (resourceUsage.memoryUsage > 90) {
              issues.push({ message: `Memory usage critical (${resourceUsage.memoryUsage}%)`, severity: "critical" });
            } else if (resourceUsage.memoryUsage > 75) {
              issues.push({ message: `Memory usage elevated (${resourceUsage.memoryUsage}%)`, severity: "warning" });
            }
            
            // Check CPU usage
            if (resourceUsage.cpuUsage > 90) {
              issues.push({ message: `CPU usage critical (${resourceUsage.cpuUsage}%)`, severity: "critical" });
            } else if (resourceUsage.cpuUsage > 75) {
              issues.push({ message: `CPU usage elevated (${resourceUsage.cpuUsage}%)`, severity: "warning" });
            }
            
            const hasCritical = issues.some(i => i.severity === "critical");
            const hasWarning = issues.some(i => i.severity === "warning");
            const overallStatus = hasCritical ? "critical" : hasWarning ? "warning" : "healthy";
            
            const statusConfig = {
              healthy: {
                bg: "bg-green-50 dark:bg-green-950/30",
                border: "border-green-200 dark:border-green-800",
                dot: "bg-green-500",
                text: "text-green-800 dark:text-green-200",
                badge: "bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200",
                label: "Healthy",
                message: "All systems operational"
              },
              warning: {
                bg: "bg-amber-50 dark:bg-amber-950/30",
                border: "border-amber-200 dark:border-amber-800",
                dot: "bg-amber-500",
                text: "text-amber-800 dark:text-amber-200",
                badge: "bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200",
                label: "Warning",
                message: "Some issues detected"
              },
              critical: {
                bg: "bg-red-50 dark:bg-red-950/30",
                border: "border-red-200 dark:border-red-800",
                dot: "bg-red-500",
                text: "text-red-800 dark:text-red-200",
                badge: "",
                label: "Critical",
                message: "Immediate attention required"
              }
            };
            
            const config = statusConfig[overallStatus];
            
            return (
              <div className="space-y-4">
                <div className={`flex items-center justify-between p-3 ${config.bg} ${config.border} border rounded-lg`}>
                  <div className="flex items-center space-x-3">
                    <div className={`w-3 h-3 ${config.dot} rounded-full ${overallStatus === "healthy" ? "animate-pulse" : ""}`}></div>
                    <span className={`text-sm font-medium ${config.text}`}>
                      {config.message}
                    </span>
                  </div>
                  <Badge variant={overallStatus === "critical" ? "destructive" : "default"} className={config.badge}>
                    {config.label}
                  </Badge>
                </div>
                {issues.length > 0 && (
                  <div className="text-sm space-y-1">
                    {issues.map((issue, idx) => (
                      <p key={idx} className={issue.severity === "critical" ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"}>
                        • {issue.message}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
        </CardContent>
      </Card>
    </div>
  );
}

// Operational Tools Component
// Data is now fetched via TanStack Query at the Dashboard level (5s polling when tab is active)
function DashboardOperations({ data, loading }) {
  // TanStack Query mutations for actions (auth handled internally by mutation hooks)
  const clearCacheMutation = useClearCache();
  const executeTaskMutation = useExecuteMaintenanceTask();
  const clearErrorsMutation = useClearErrorLogs();

  const [cacheStats, setCacheStats] = useState(() => {
    if (data?.cacheStats) {
      return {
        totalKeys: data.cacheStats.totalKeys || 0,
        memoryUsage: data.cacheStats.memoryUsage || "0 MB",
        hitRate: data.cacheStats.hitRate || 0,
        evictionRate: data.cacheStats.evictionRate || 0,
        hits: data.cacheStats.hits || 0,
        misses: data.cacheStats.misses || 0,
        cachedErrors: data.cacheStats.cachedErrors || 0,
        byType: data.cacheStats.byType || {},
      };
    }
    return {
      totalKeys: 0,
      memoryUsage: "0 MB",
      hitRate: 0,
      evictionRate: 0,
      hits: 0,
      misses: 0,
      cachedErrors: 0,
      byType: {},
    };
  });

  const [errorLogs, setErrorLogs] = useState(() => data?.errorLogs || []);
  const [maintenanceTasks, setMaintenanceTasks] = useState(() => data?.maintenanceTasks || []);
  const [executingTasks, setExecutingTasks] = useState<Set<number>>(new Set());

  // Update state when data prop changes
  useEffect(() => {
    if (data) {
      setErrorLogs(data.errorLogs || []);
      setMaintenanceTasks(data.maintenanceTasks || []);

      // Update cache stats from API response
      if (data.cacheStats) {
        setCacheStats({
          totalKeys: data.cacheStats.totalKeys || 0,
          memoryUsage: data.cacheStats.memoryUsage || "0 MB",
          hitRate: data.cacheStats.hitRate || 0,
          evictionRate: data.cacheStats.evictionRate || 0,
          hits: data.cacheStats.hits || 0,
          misses: data.cacheStats.misses || 0,
          cachedErrors: data.cacheStats.cachedErrors || 0,
          byType: data.cacheStats.byType || {},
        });
      }
    }
  }, [data]);


  // Use mutation for cache clearing
  const handleClearCache = async (type: 'all' | 'expired' | 'metadata') => {
    clearCacheMutation.mutate(type, {
      onSuccess: (result) => {
        const message = result.keyCount !== undefined
          ? `Cache ${type} cleared successfully! ${result.keyCount} essential keys remain.`
          : `Cache ${type} cleared successfully!`;
        toast.success("Cache Cleared", { description: message });
      },
      onError: (error) => {
        toast.error("Cache Clear Failed", { description: error.message });
      },
    });
  };

  // Use mutation for maintenance tasks
  const handleMaintenanceTask = async (taskId: number, action: string) => {
    const warmingTaskIds = [7, 8, 9];
    const isWarmingTask = warmingTaskIds.includes(taskId);
    
    if (!isWarmingTask) {
      setExecutingTasks(prev => new Set(prev).add(taskId));
    }
    
    executeTaskMutation.mutate({ taskId, action }, {
      onSuccess: (result) => {
        if (result.success) {
          toast.success(result.message);
        } else {
          toast.error(result.message || 'Failed to execute task');
        }
      },
      onError: (error) => {
        toast.error(`Failed to execute task: ${error.message}`);
      },
      onSettled: () => {
        if (!isWarmingTask) {
          setExecutingTasks(prev => {
            const newSet = new Set(prev);
            newSet.delete(taskId);
            return newSet;
          });
        }
      },
    });
  };

  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());

  const toggleErrorDetails = (errorId: string) => {
    setExpandedErrors(prev => {
      const newSet = new Set(prev);
      if (newSet.has(errorId)) {
        newSet.delete(errorId);
      } else {
        newSet.add(errorId);
      }
      return newSet;
    });
  };

  // Use mutation for clearing errors
  const handleClearAllErrors = async () => {
    clearErrorsMutation.mutate(undefined, {
      onSuccess: (result) => {
        setErrorLogs([]);
        setExpandedErrors(new Set());
        toast.success("Errors Cleared", { description: result.message });
      },
      onError: (error) => {
        toast.error("Clear Errors Failed", { description: error.message });
      },
    });
  };

  // Derive loading states from mutations
  const cacheClearing = clearCacheMutation.isPending;
  const clearingErrors = clearErrorsMutation.isPending;

  return (
    <div className="space-y-6">
      {/* Cache Management */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5" />
            <CardTitle>Cache Management</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Keys</span>
              <p className="text-lg font-semibold"><AnimatedNumber value={cacheStats.totalKeys} /></p>
            </div>
            <div>
              <span className="text-muted-foreground">Redis Memory</span>
              <p className="text-lg font-semibold">{cacheStats.memoryUsage}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Hit Rate</span>
              <p className="text-lg font-semibold"><AnimatedNumber value={cacheStats.hitRate} suffix="%" /></p>
            </div>
            <div>
              <span className="text-muted-foreground">Hits / Misses</span>
              <p className="text-lg font-semibold">
                <AnimatedNumber value={cacheStats.hits} />
                <span className="text-muted-foreground font-normal"> / </span>
                <AnimatedNumber value={cacheStats.misses} />
              </p>
            </div>
          </div>
          <div className="flex justify-center mt-3 pt-3 border-t">
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                onClick={() => handleClearCache("expired")}
                variant="outline"
                size="sm"
                disabled={cacheClearing}
              >
                {cacheClearing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Clock className="h-4 w-4 mr-1.5" />
                    Clear Expired
                  </>
                )}
              </Button>
              <Button
                onClick={() => handleClearCache("metadata")}
                variant="outline"
                size="sm"
                disabled={cacheClearing}
              >
                {cacheClearing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Database className="h-4 w-4 mr-1.5" />
                    Clear Metadata
                  </>
                )}
              </Button>
              <Button
                onClick={() => handleClearCache("all")}
                variant="outline"
                size="sm"
                disabled={cacheClearing}
                className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
              >
                {cacheClearing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Trash2 className="h-4 w-4 mr-1.5" />
                    Clear All
                  </>
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Error Management */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <div>
            <CardTitle>Error Management</CardTitle>
            <CardDescription>Recent errors and warnings from the system</CardDescription>
          </div>
          {errorLogs.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearAllErrors}
              disabled={clearingErrors}
            >
              {clearingErrors ? (
                <>
                  <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                  Clearing...
                </>
              ) : (
                "Clear All"
              )}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {errorLogs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mb-3">
                  <Shield className="w-6 h-6 text-green-600" />
                </div>
                <p className="text-sm font-medium text-muted-foreground">No errors recorded</p>
                <p className="text-xs text-muted-foreground mt-1">System is running smoothly</p>
              </div>
            ) : (
              errorLogs.map((error) => (
                <div
                  key={error.id}
                  className="border rounded-lg overflow-hidden"
                >
                  <div
                    className="flex items-center justify-between p-3 cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => toggleErrorDetails(error.id)}
                  >
                    <div className="flex items-center space-x-3 flex-1 min-w-0">
                      <div
                        className={`w-3 h-3 rounded-full flex-shrink-0 ${
                          error.level === "error"
                            ? "bg-red-500"
                            : error.level === "warning"
                              ? "bg-yellow-500"
                              : "bg-blue-500"
                        }`}
                      ></div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">{error.message}</p>
                        <p className="text-sm text-muted-foreground">
                          {error.timeAgo || error.timestamp} • Occurred {error.count} time
                          {error.count > 1 ? "s" : ""}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2 flex-shrink-0">
                      <Badge
                        variant={
                          error.level === "error" ? "destructive" : "secondary"
                        }
                      >
                        {error.level}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {expandedErrors.has(error.id) ? "▲" : "▼"}
                      </span>
                    </div>
                  </div>
                  {expandedErrors.has(error.id) && error.details && Object.keys(error.details).length > 0 && (
                    <div className="px-3 pb-3 pt-0 border-t bg-muted/30">
                      <div className="pt-3 space-y-2">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Details</p>
                        <div className="grid gap-1.5">
                          {Object.entries(error.details).map(([key, value]) => (
                            <div key={key} className="flex justify-between text-sm">
                              <span className="text-muted-foreground capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}:</span>
                              <span className="font-mono text-xs">{String(value)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                  {expandedErrors.has(error.id) && (!error.details || Object.keys(error.details).length === 0) && (
                    <div className="px-3 pb-3 pt-0 border-t bg-muted/30">
                      <div className="pt-3">
                        <p className="text-xs text-muted-foreground">No additional details available</p>
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {/* Maintenance Tasks */}
      <Card>
        <CardHeader>
          <CardTitle>Maintenance Tasks</CardTitle>
          <CardDescription>
            Scheduled and running maintenance operations
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {maintenanceTasks.map((task) => (
              <div
                key={task.id}
                className="p-4 border rounded-lg"
              >
                {/* Desktop layout */}
                <div className="hidden sm:flex items-center justify-between">
                  <div className="flex items-center space-x-3 flex-1">
                    <div
                      className={`w-3 h-3 rounded-full ${
                        task.status === "completed"
                          ? "bg-green-500"
                          : task.status === "running"
                            ? "bg-blue-500"
                            : task.status === "disabled"
                              ? "bg-gray-400"
                              : "bg-yellow-500"
                      }`}
                    ></div>
                    <div className="flex-1">
                      <div className="flex items-center space-x-2">
                        <p className="font-medium">{task.name}</p>
                      </div>
                      <p className="text-sm text-muted-foreground mb-1">
                        {task.description}
                      </p>
                      <div className="flex items-center space-x-4 text-xs text-muted-foreground">
                        <span>Last run: {task.lastRun}</span>
                        <span>Next: {task.nextRun}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Badge
                      variant={
                        task.status === "completed"
                          ? "default"
                          : task.status === "running"
                            ? "secondary"
                            : task.status === "disabled" || task.status === "pending"
                              ? "outline"
                              : "destructive"
                      }
                    >
                      {task.status}
                    </Badge>
                    {task.action && (
                      <Button 
                        size="sm" 
                        variant={
                          task.action === "stop" ? "destructive" : 
                          task.action === "enable" ? "default" : "outline"
                        }
                        onClick={() => handleMaintenanceTask(task.id, task.action)}
                        disabled={task.status === "error" || executingTasks.has(task.id)}
                      >
                        {executingTasks.has(task.id) ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                            Running...
                          </>
                        ) : task.action === "stop" ? (
                          "Stop"
                        ) : task.action === "enable" ? (
                          "Enable"
                        ) : task.action === "restart" ? (
                          <>
                            <RefreshCw className="h-4 w-4 mr-1" />
                            Force
                          </>
                        ) : (
                          "Run Now"
                        )}
                      </Button>
                    )}
                  </div>
                </div>

                {/* Mobile layout */}
                <div className="sm:hidden">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0 flex-1">
                      <div
                        className={`w-3 h-3 rounded-full flex-shrink-0 mt-1 ${
                          task.status === "completed"
                            ? "bg-green-500"
                            : task.status === "running"
                              ? "bg-blue-500"
                              : task.status === "disabled"
                                ? "bg-gray-400"
                                : "bg-yellow-500"
                        }`}
                      ></div>
                      <div className="min-w-0">
                        <p className="font-medium">{task.name}</p>
                      </div>
                    </div>
                    <Badge
                      variant={
                        task.status === "completed"
                          ? "default"
                          : task.status === "running"
                            ? "secondary"
                            : task.status === "disabled" || task.status === "pending"
                              ? "outline"
                              : "destructive"
                      }
                      className="flex-shrink-0"
                    >
                      {task.status}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
                    <div className="flex items-center gap-3">
                      <span>Last: {task.lastRun}</span>
                      <span>Next: {task.nextRun}</span>
                    </div>
                    {task.action && (
                      <Button 
                        size="sm" 
                        variant={
                          task.action === "stop" ? "destructive" : 
                          task.action === "enable" ? "default" : "outline"
                        }
                        onClick={() => handleMaintenanceTask(task.id, task.action)}
                        disabled={task.status === "error" || executingTasks.has(task.id)}
                        className="h-7 text-xs"
                      >
                        {executingTasks.has(task.id) ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : task.action === "stop" ? (
                          "Stop"
                        ) : task.action === "enable" ? (
                          "Enable"
                        ) : task.action === "restart" ? (
                          "Force"
                        ) : (
                          "Run"
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
          <CardDescription>Common administrative tasks and warming controls</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Button 
              variant="outline" 
              className="h-20 flex-col"
              onClick={() => handleMaintenanceTask(7, 'restart')}
            >
              <Database className="h-6 w-6 mb-2" />
              <span className="text-sm">Essential Warming</span>
            </Button>
            <Button 
              variant="outline" 
              className="h-20 flex-col"
              onClick={() => handleMaintenanceTask(8, 'restart')}
            >
              <RefreshCw className="h-6 w-6 mb-2" />
              <span className="text-sm">MAL Warming</span>
            </Button>
            <Button 
              variant="outline" 
              className="h-20 flex-col"
              onClick={() => handleMaintenanceTask(9, 'restart')}
            >
              <Settings className="h-6 w-6 mb-2" />
              <span className="text-sm">Comprehensive</span>
            </Button>
          </div>
          <div className="mt-4 pt-4 border-t">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Button 
                variant="destructive" 
                className="h-16 flex-col gap-1"
                onClick={() => {
                  handleMaintenanceTask(7, 'stop');
                  handleMaintenanceTask(8, 'stop');
                  handleMaintenanceTask(9, 'stop');
                }}
              >
                <Square className="h-4 w-4" />
                <span className="text-sm font-medium">Stop All Warming</span>
              </Button>
              <Button 
                variant="default" 
                className="h-16 flex-col gap-1"
                onClick={() => {
                  handleMaintenanceTask(7, 'restart');
                  handleMaintenanceTask(8, 'restart');
                  handleMaintenanceTask(9, 'restart');
                }}
              >
                <Play className="h-4 w-4" />
                <span className="text-sm font-medium">Start All Warming</span>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// User Management Component
function DashboardUsers({ data, loading }) {
  const { adminKey } = useAdmin();
  
  // TanStack Query mutation for clearing user data
  const clearUserDataMutation = useClearUserData();

  const [userStats, setUserStats] = useState(() => ({
    totalUsers: data?.totalUsers || 0,
    activeUsers: data?.activeUsers || 0,
    newUsersToday: data?.newUsersToday || 0,
    totalRequests: data?.totalRequests || 0,
  }));

  const [userActivity, setUserActivity] = useState(() => data?.userActivity || []);
  const [accessControl, setAccessControl] = useState(() => data?.accessControl || {
    adminUsers: 0,
    apiKeyUsers: 0,
    rateLimitedUsers: 0,
    blockedUsers: 0,
  });

  const [error, setError] = useState(null);
  const [showUserManagement, setShowUserManagement] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  const [showUserDetails, setShowUserDetails] = useState(false);

  // Clear inflated user data using mutation
  const handleClearUserData = () => {
    if (!adminKey) {
      toast.error("Admin key required", {
        description: "You need admin access to clear user data",
      });
      return;
    }

    clearUserDataMutation.mutate(undefined, {
      onSuccess: (result) => {
        if (result.success) {
          toast.success("User Data Cleared", {
            description: "Inflated user data has been cleared. New tracking will be more accurate.",
          });
        } else {
          toast.error("Clear Failed", {
            description: result.message || "Failed to clear user data",
          });
        }
      },
      onError: (error) => {
        toast.error("Clear Error", {
          description: error.message,
        });
      },
    });
  };

  // Derive loading state from mutation
  const clearingUserData = clearUserDataMutation.isPending;

  // Update state when data prop changes
  useEffect(() => {
    if (data) {
      setUserStats({
        totalUsers: data.totalUsers || 0,
        activeUsers: data.activeUsers || 0,
        newUsersToday: data.newUsersToday || 0,
        totalRequests: data.totalRequests || 0,
      });
      setUserActivity(data.userActivity || []);
      setAccessControl(
        data.accessControl || {
          adminUsers: 0,
          apiKeyUsers: 0,
          rateLimitedUsers: 0,
          blockedUsers: 0,
        },
      );
      setError(null);
    }
  }, [data]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
            <p className="text-muted-foreground">Loading user data...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="text-red-500 mb-4">
              <AlertCircle className="h-12 w-12 mx-auto" />
            </div>
            <p className="text-red-600 font-medium">Failed to load user data</p>
            <p className="text-sm text-muted-foreground mt-2">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* User Statistics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              <AnimatedNumber value={userStats.totalUsers} />
            </div>
            <p className="text-xs text-muted-foreground">Registered users</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Users</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold"><AnimatedNumber value={userStats.activeUsers} /></div>
            <p className="text-xs text-muted-foreground">Currently online</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">New Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold"><AnimatedNumber value={userStats.newUsersToday} /></div>
            <p className="text-xs text-muted-foreground">Today</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Total Requests
            </CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              <AnimatedNumber value={userStats.totalRequests || 0} />
            </div>
            <p className="text-xs text-muted-foreground">All time requests</p>
          </CardContent>
        </Card>
      </div>

      {/* User Activity */}
      <Card>
        <CardHeader>
          <CardTitle>Recent User Activity</CardTitle>
          <CardDescription>Latest user interactions and status</CardDescription>
        </CardHeader>
        <CardContent>
          {userActivity.length > 0 ? (
            <div className="space-y-3">
              {userActivity.map((user) => (
                <div
                  key={user.id}
                  className="p-3 border rounded-lg"
                >
                  {/* Desktop layout */}
                  <div className="hidden sm:flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <div
                        className={`w-3 h-3 rounded-full ${
                          user.status === "active"
                            ? "bg-green-500"
                            : user.status === "idle"
                              ? "bg-yellow-500"
                              : "bg-blue-500"
                        }`}
                      ></div>
                      <div>
                        <p className="font-medium">{user.username}</p>
                        <p className="text-sm text-muted-foreground">
                          Last seen: {user.lastSeen} • {user.requests} requests
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Badge
                        variant={
                          user.status === "active"
                            ? "default"
                            : user.status === "idle"
                              ? "secondary"
                              : "outline"
                        }
                      >
                        {user.status}
                      </Badge>
                      <Button 
                        size="sm" 
                        variant="outline"
                        onClick={() => {
                          setSelectedUser(user);
                          setShowUserDetails(true);
                        }}
                      >
                        View Details
                      </Button>
                    </div>
                  </div>
                  {/* Mobile layout */}
                  <div className="sm:hidden">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center space-x-2">
                        <div
                          className={`w-3 h-3 rounded-full ${
                            user.status === "active"
                              ? "bg-green-500"
                              : user.status === "idle"
                                ? "bg-yellow-500"
                                : "bg-blue-500"
                          }`}
                        ></div>
                        <p className="font-medium">{user.username}</p>
                      </div>
                      <Badge
                        variant={
                          user.status === "active"
                            ? "default"
                            : user.status === "idle"
                              ? "secondary"
                              : "outline"
                        }
                      >
                        {user.status}
                      </Badge>
                    </div>
                    <div className="flex justify-between text-sm mb-2">
                      <span className="text-muted-foreground">Last seen: {user.lastSeen}</span>
                      <span className="text-muted-foreground">{user.requests} requests</span>
                    </div>
                    <Button 
                      size="sm" 
                      variant="outline"
                      className="w-full"
                      onClick={() => {
                        setSelectedUser(user);
                        setShowUserDetails(true);
                      }}
                    >
                      View Details
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No recent user activity</p>
              <p className="text-sm">
                User activity will appear here as users interact with the addon
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Access Control - Placeholder, hidden for now
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Access Control</CardTitle>
            <CardDescription>
              User permissions and access levels
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Admin Users</span>
                <span className="text-2xl font-bold text-red-600">
                  {accessControl.adminUsers}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">API Key Users</span>
                <span className="text-2xl font-bold text-blue-600">
                  {accessControl.apiKeyUsers}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Rate Limited</span>
                <span className="text-2xl font-bold text-orange-600">
                  {accessControl.rateLimitedUsers}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Blocked Users</span>
                <span className="text-2xl font-bold text-red-600">
                  {accessControl.blockedUsers}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
        */}

        <Card>
          <CardHeader>
            <CardTitle>User Management</CardTitle>
            <CardDescription>
              Administrative actions for user data and tracking
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <Button 
                variant="outline" 
                className="w-full"
                onClick={() => setShowUserManagement(true)}
              >
                <Users className="h-4 w-4 mr-2" />
                Manage Users
              </Button>
              {/* Placeholder buttons - hidden for now
              <Button variant="outline" className="w-full">
                <Shield className="h-4 w-4 mr-2" />
                Access Control
              </Button>
              <Button variant="outline" className="w-full">
                <Activity className="h-4 w-4 mr-2" />
                User Analytics
              </Button>
              <Button variant="outline" className="w-full">
                <Settings className="h-4 w-4 mr-2" />
                User Settings
              </Button>
              */}
              <Button 
                variant="destructive" 
                className="w-full"
                onClick={handleClearUserData}
                disabled={clearingUserData}
              >
                {clearingUserData ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 mr-2" />
                )}
                {clearingUserData ? "Clearing..." : "Clear User Data"}
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                Clears inflated active user data to reset tracking accuracy
              </p>
            </div>
          </CardContent>
        </Card>
      {/* Closing div for Access Control grid - commented out
      </div>
      */}

      {/* User Analytics Placeholder - Hidden for now
      <Card>
        <CardHeader>
          <CardTitle>User Analytics</CardTitle>
          <CardDescription>User behavior patterns and trends</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-12 text-muted-foreground">
            <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>User Analytics Charts</p>
            <p className="text-sm">
              Charts will be implemented in the next step
            </p>
          </div>
        </CardContent>
      </Card>
      */}

      {/* User Activity Details Dialog */}
      <Dialog open={showUserDetails} onOpenChange={setShowUserDetails}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>User Activity Details</DialogTitle>
            <DialogDescription>
              Detailed information about this user's activity
            </DialogDescription>
          </DialogHeader>
          {selectedUser && (
            <div className="space-y-4 mt-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-sm font-medium text-muted-foreground">IP Address</Label>
                  <p className="text-sm font-mono mt-1">
                    {selectedUser.anonymizedIP && selectedUser.anonymizedIP !== "unknown"
                      ? selectedUser.anonymizedIP
                      : "Unknown"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {selectedUser.anonymizedIP && selectedUser.anonymizedIP !== "unknown"
                      ? "Anonymized IP (first 3 octets)"
                      : "IP address not available"}
                  </p>
                </div>
                <div>
                  <Label className="text-sm font-medium text-muted-foreground">Status</Label>
                  <div className="mt-1">
                    <Badge
                      variant={
                        selectedUser.status === "active"
                          ? "default"
                          : selectedUser.status === "idle"
                            ? "secondary"
                            : "outline"
                      }
                    >
                      {selectedUser.status}
                    </Badge>
                  </div>
                </div>
              </div>

              <div>
                <Label className="text-sm font-medium text-muted-foreground">Identifier Hash</Label>
                <p className="text-sm font-mono mt-1 text-muted-foreground">{selectedUser.id}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Internal identifier hash (for tracking)
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-sm font-medium text-muted-foreground">Total Requests</Label>
                  <p className="text-sm font-semibold mt-1">{selectedUser.requests}</p>
                </div>
                <div>
                  <Label className="text-sm font-medium text-muted-foreground">Last Seen</Label>
                  <p className="text-sm mt-1">{selectedUser.lastSeen}</p>
                </div>
              </div>

              <div>
                <Label className="text-sm font-medium text-muted-foreground">Last Endpoint</Label>
                <p className="text-sm font-mono mt-1 break-all">{selectedUser.lastEndpoint || "N/A"}</p>
              </div>

              <div>
                <Label className="text-sm font-medium text-muted-foreground">User Agent</Label>
                <p className="text-sm mt-1 break-all text-muted-foreground">
                  {selectedUser.userAgent || "Unknown"}
                </p>
              </div>

              <div className="pt-4 border-t">
                <p className="text-xs text-muted-foreground">
                  <strong>Note:</strong> The IP address shown is anonymized (first 3 octets for IPv4, first 3 groups for IPv6) 
                  for privacy. The identifier hash is created from the anonymized IP and browser type. 
                  This does not correspond to a registered user UUID.
                </p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* User Management Modal */}
      <UserManagementModal
        isOpen={showUserManagement}
        onClose={() => setShowUserManagement(false)}
        adminKey={adminKey}
      />
    </div>
  );
}

// Blocking Admin Login Modal Component
interface AdminLoginModalProps {
  isOpen: boolean;
  onSuccess: () => void;
  onGuestSuccess: () => void;
  onCancel: () => void;
  adminKeyNotConfigured?: boolean;
  guestModeEnabled?: boolean;
}

function AdminLoginModal({ 
  isOpen, 
  onSuccess, 
  onGuestSuccess,
  onCancel, 
  adminKeyNotConfigured,
  guestModeEnabled 
}: AdminLoginModalProps) {
  const { login, loginAsGuest, isLoading } = useAdmin();
  const [inputAdminKey, setInputAdminKey] = useState("");
  const [error, setError] = useState("");
  const [showAdminInput, setShowAdminInput] = useState(false);

  const handleLogin = async () => {
    if (!inputAdminKey.trim()) {
      setError("Please enter an admin key");
      return;
    }

    setError("");
    const success = await login(inputAdminKey);
    if (success) {
      setInputAdminKey("");
      setError("");
      setShowAdminInput(false);
      onSuccess();
    } else {
      setError("Invalid admin key. Please try again.");
    }
  };

  const handleGuestLogin = () => {
    loginAsGuest();
    onGuestSuccess();
  };

  const handleGoBack = () => {
    // Navigate away from dashboard 
    const stored = sessionStorage.getItem('lastConfigureUrl');
    window.location.href = stored || '/configure';
  };

  const handleBackToOptions = () => {
    setShowAdminInput(false);
    setInputAdminKey("");
    setError("");
  };

  // Show specific message when ADMIN_KEY is not configured AND guest mode is disabled
  if (adminKeyNotConfigured && !guestModeEnabled) {
    return (
      <Dialog open={isOpen} onOpenChange={() => {}}>
        <DialogContent 
          className="sm:max-w-md mx-4" 
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-amber-500" />
              Dashboard Access Unavailable
            </DialogTitle>
            <DialogDescription>
              Dashboard access requires the ADMIN_KEY environment variable to be configured on the server.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="p-3 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-md text-sm text-amber-700 dark:text-amber-300">
              <p className="font-medium mb-1">Configuration Required</p>
              <p>Please set the ADMIN_KEY environment variable on your server to enable dashboard access.</p>
            </div>
            <div className="flex justify-end">
              <Button variant="outline" onClick={handleGoBack}>
                Go Back
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // Show admin login input when "Admin Login" is clicked
  if (showAdminInput) {
    return (
      <Dialog open={isOpen} onOpenChange={() => {}}>
        <DialogContent 
          className="sm:max-w-md mx-4"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Admin Authentication
            </DialogTitle>
            <DialogDescription>
              Enter your admin key to access all dashboard features.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {error && (
              <div className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-md text-sm text-red-700 dark:text-red-300">
                {error}
              </div>
            )}
            {/* Show warning if ADMIN_KEY is not configured but guest mode is enabled */}
            {adminKeyNotConfigured && guestModeEnabled && (
              <div className="p-3 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-md text-sm text-amber-700 dark:text-amber-300">
                <p className="font-medium mb-1">Admin Access Unavailable</p>
                <p>ADMIN_KEY is not configured on the server. You can continue as a guest to view public metrics.</p>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="admin-key-modal">Admin Key</Label>
              <Input
                id="admin-key-modal"
                type="password"
                value={inputAdminKey}
                onChange={(e) => setInputAdminKey(e.target.value)}
                placeholder="Enter admin key"
                onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                autoFocus
                disabled={adminKeyNotConfigured}
              />
            </div>
            <div className="flex justify-between gap-2">
              <Button variant="outline" onClick={handleBackToOptions}>
                Back
              </Button>
              <Button onClick={handleLogin} disabled={isLoading || adminKeyNotConfigured}>
                {isLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Authenticating...
                  </>
                ) : (
                  "Login"
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // Show login options: Admin Login and Guest (if enabled)
  return (
    <Dialog open={isOpen} onOpenChange={() => {}}>
      <DialogContent 
        className="sm:max-w-md mx-4"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Dashboard Access
          </DialogTitle>
          <DialogDescription>
            {guestModeEnabled 
              ? "Choose how you'd like to access the dashboard."
              : "Enter your admin key to access the dashboard."
            }
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {/* Admin Login Option */}
          <Button 
            className="w-full justify-start h-auto py-4" 
            variant="outline"
            onClick={() => setShowAdminInput(true)}
          >
            <div className="flex items-center gap-3">
              <Key className="h-5 w-5 text-primary" />
              <div className="text-left">
                <p className="font-medium">Admin Login</p>
                <p className="text-xs text-muted-foreground">Full access to all dashboard features</p>
              </div>
            </div>
          </Button>

          {/* Guest Option - Only shown when guest mode is enabled */}
          {guestModeEnabled && (
            <Button 
              className="w-full justify-start h-auto py-4" 
              variant="outline"
              onClick={handleGuestLogin}
            >
              <div className="flex items-center gap-3">
                <Users className="h-5 w-5 text-muted-foreground" />
                <div className="text-left">
                  <p className="font-medium">Continue as Guest</p>
                  <p className="text-xs text-muted-foreground">View public metrics without authentication</p>
                </div>
              </div>
            </Button>
          )}

          <div className="flex justify-start pt-2">
            <Button variant="ghost" size="sm" onClick={handleGoBack}>
              Go Back
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Access level type for tracking current user access
type AccessLevel = 'none' | 'guest' | 'admin';

// Admin Status Badge Component - Shows admin/guest status and logout button
interface AdminStatusBadgeProps {}

function AdminStatusBadge({}: AdminStatusBadgeProps) {
  const { isAdmin, isGuest, adminKey, logout } = useAdmin();

  // Determine current access level based on AdminContext state
  const accessLevel: AccessLevel = isAdmin ? 'admin' : isGuest ? 'guest' : 'none';

  const handleLogout = () => {
    logout();
  };

  // Don't show badge if not authenticated
  if (accessLevel === 'none') {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      {accessLevel === 'admin' ? (
        <Badge variant="default" className="bg-green-600">
          <Shield className="h-3 w-3 mr-1" />
          Admin
        </Badge>
      ) : (
        <Badge variant="secondary" className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
          <Users className="h-3 w-3 mr-1" />
          Guest
        </Badge>
      )}
      {(adminKey || isGuest) && (
        <Button variant="outline" size="sm" onClick={handleLogout}>
          <LogOut className="h-4 w-4 mr-1" />
          Logout
        </Button>
      )}
    </div>
  );
}

// Main Dashboard Component
export function Dashboard() {
  const { isAdmin, isGuest, adminKey, isLoading, adminKeyConfigured, guestModeEnabled } = useAdmin();
  const { isMobile } = useBreakpoint();
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [activeTab, setActiveTab] = useState<DashboardTab>('overview');

  // Access level state management - tracks current access level based on AdminContext state
  const accessLevel: AccessLevel = isAdmin ? 'admin' : isGuest ? 'guest' : 'none';

  // TanStack Query hooks with tab-aware polling
  const queryOptions = { activeTab, enabled: isAdmin || isGuest };
  
  const overviewQuery = useDashboardOverview(queryOptions);
  const analyticsQuery = useDashboardAnalytics(queryOptions);
  const contentQuery = useDashboardContent(queryOptions);
  const performanceQuery = useDashboardPerformance(queryOptions);
  const systemQuery = useDashboardSystem(queryOptions);
  const operationsQuery = useDashboardOperations(queryOptions);
  const usersQuery = useDashboardUsers(queryOptions);

  // Refetch data when tab changes (only if not already fetching)
  const prevTabRef = useRef<DashboardTab | null>(null);
  useEffect(() => {
    // Skip initial mount
    if (prevTabRef.current === null) {
      prevTabRef.current = activeTab;
      return;
    }
    
    // Only refetch if tab actually changed
    if (prevTabRef.current !== activeTab) {
      prevTabRef.current = activeTab;
      
      // Only trigger refetch if not already fetching to prevent request piling
      switch (activeTab) {
        case 'overview':
          if (!overviewQuery.isFetching) overviewQuery.refetch();
          if (!systemQuery.isFetching) systemQuery.refetch();
          break;
        case 'analytics':
          if (!analyticsQuery.isFetching) analyticsQuery.refetch();
          break;
        case 'content':
          if (!contentQuery.isFetching) contentQuery.refetch();
          break;
        case 'performance':
          if (!performanceQuery.isFetching) performanceQuery.refetch();
          break;
        case 'system':
          if (!systemQuery.isFetching) systemQuery.refetch();
          break;
        case 'operations':
          if (isAdmin && !operationsQuery.isFetching) operationsQuery.refetch();
          break;
        case 'users':
          if (isAdmin && !usersQuery.isFetching) usersQuery.refetch();
          break;
      }
    }
  }, [activeTab]);

  // Compute loading state - only show loading on initial load
  const isInitialLoading = overviewQuery.isLoading && !overviewQuery.data;

  // Build dashboard data object for child components (maintains backward compatibility)
  const dashboardData = {
    overview: overviewQuery.data,
    analytics: analyticsQuery.data,
    content: contentQuery.data,
    performance: performanceQuery.data,
    system: systemQuery.data,
    operations: operationsQuery.data,
    users: usersQuery.data,
    loading: isInitialLoading,
    error: overviewQuery.error?.message || null,
  };

  // Show login modal when not authenticated (neither admin nor guest)
  useEffect(() => {
    if (!isLoading && !isAdmin && !isGuest) {
      setShowLoginModal(true);
    } else if (isAdmin || isGuest) {
      setShowLoginModal(false);
    }
  }, [isLoading, isAdmin, isGuest]);

  // Handle successful admin login
  const handleLoginSuccess = () => {
    setShowLoginModal(false);
  };

  // Handle successful guest login
  const handleGuestSuccess = () => {
    setShowLoginModal(false);
  };

  // Handle login cancel (go back)
  const handleLoginCancel = () => {
    const stored = sessionStorage.getItem('lastConfigureUrl');
    window.location.href = stored || '/configure';
  };

  // Show loading state while checking authentication (only on initial load)
  // Don't show loading spinner during login attempts - keep the modal visible
  if (isLoading && !showLoginModal) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Checking authentication...</p>
        </div>
      </div>
    );
  }

  // Show login modal if not authenticated (neither admin nor guest)
  // Don't render any dashboard content behind the modal
  if (!isAdmin && !isGuest) {
    return (
      <AdminLoginModal
        isOpen={showLoginModal}
        onSuccess={handleLoginSuccess}
        onGuestSuccess={handleGuestSuccess}
        onCancel={handleLoginCancel}
        adminKeyNotConfigured={!adminKeyConfigured}
        guestModeEnabled={guestModeEnabled}
      />
    );
  }

  // Calculate grid columns based on admin status
  const gridCols = isAdmin ? "grid-cols-6" : "grid-cols-4";

  // Dashboard pages configuration - base pages available to all authenticated users
  const dashboardPages = [
    {
      value: "overview",
      title: "Overview",
      component: (
        <DashboardOverview
          data={dashboardData.overview}
          systemData={dashboardData.system}
          loading={dashboardData.loading}
        />
      ),
    },
    {
      value: "analytics",
      title: "Analytics",
      component: (
        <DashboardAnalytics
          data={dashboardData.analytics}
          loading={dashboardData.loading}
          isMobile={isMobile}
        />
      ),
    },
    {
      value: "content",
      title: "Content",
      component: (
        <DashboardContent
          data={dashboardData.content}
          loading={dashboardData.loading}
        />
      ),
    },
    {
      value: "performance",
      title: "Performance",
      component: (
        <DashboardPerformance
          data={dashboardData.performance}
          loading={dashboardData.loading}
        />
      ),
    },
    {
      value: "system",
      title: "System",
      component: (
        <DashboardSystem
          data={dashboardData.system}
          loading={dashboardData.loading}
        />
      ),
    },
  ];

  if (accessLevel === 'admin') {
    dashboardPages.push(
      {
        value: "operations",
        title: "Operations",
        component: (
          <DashboardOperations
            data={dashboardData.operations}
            loading={dashboardData.loading}
          />
        ),
      },
      {
        value: "users",
        title: "Users",
        component: (
          <DashboardUsers
            data={dashboardData.users}
            loading={dashboardData.loading}
          />
        ),
      },
    );
  }

  // Mobile layout with accordion
  if (isMobile) {
    return (
      <div className="w-full p-4">
        <div className="flex flex-col items-start justify-between gap-4 mb-6">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
            <p className="text-sm text-muted-foreground">
              Monitor your addon's performance, health, and usage statistics
            </p>
          </div>
          <AdminStatusBadge />
        </div>


        <Accordion 
          type="single" 
          collapsible 
          className="w-full"
          onValueChange={(value) => value && setActiveTab(value as DashboardTab)}
        >
          {dashboardPages.map((page, index) => (
            <AccordionItem
              value={page.value}
              key={page.value}
              className={
                index === dashboardPages.length - 1 ? "border-b-0" : "border-b"
              }
            >
              <AccordionTrigger className="text-lg font-medium hover:no-underline py-4">
                {page.title}
              </AccordionTrigger>
              <AccordionContent className="pt-2 pb-6">
                {page.component}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    );
  }

  // Desktop layout with tabs
  return (
    <div className="space-y-4 sm:space-y-6 p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
            Dashboard
          </h2>
          <p className="text-sm sm:text-base text-muted-foreground">
            Monitor your addon's performance, health, and usage statistics
          </p>
        </div>
        <AdminStatusBadge />
      </div>

      {/* Metrics Disabled Banner */}
      {(dashboardData.overview as any)?.metricsDisabled && (
        <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-3 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
            Metrics have been disabled on this instance
          </p>
        </div>
      )}

      <Tabs defaultValue="overview" className="w-full" onValueChange={(value) => setActiveTab(value as DashboardTab)}>
        <TabsList className="inline-flex h-10 items-center justify-center rounded-md p-1 text-muted-foreground w-full gap-x-1 bg-muted overflow-x-auto">
          <TabsTrigger
            value="overview"
            className="text-xs sm:text-sm whitespace-nowrap"
          >
            Overview
          </TabsTrigger>
          <TabsTrigger
            value="analytics"
            className="text-xs sm:text-sm whitespace-nowrap"
          >
            Analytics
          </TabsTrigger>
          <TabsTrigger
            value="content"
            className="text-xs sm:text-sm whitespace-nowrap"
          >
            Content
          </TabsTrigger>
          <TabsTrigger
            value="performance"
            className="text-xs sm:text-sm whitespace-nowrap"
          >
            Perf
          </TabsTrigger>
          <TabsTrigger
            value="system"
            className="text-xs sm:text-sm whitespace-nowrap"
          >
            System
          </TabsTrigger>
          {/* Ops and Users tabs only visible for admin users */}
          {accessLevel === 'admin' && (
            <>
              <TabsTrigger
                value="operations"
                className="text-xs sm:text-sm whitespace-nowrap"
              >
                Ops
              </TabsTrigger>
              <TabsTrigger
                value="users"
                className="text-xs sm:text-sm whitespace-nowrap"
              >
                Users
              </TabsTrigger>
            </>
          )}
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <DashboardOverview
            data={dashboardData.overview}
            systemData={dashboardData.system}
            loading={dashboardData.loading}
          />
        </TabsContent>

        <TabsContent value="analytics" className="mt-6">
          <DashboardAnalytics
            data={dashboardData.analytics}
            loading={dashboardData.loading}
            isMobile={isMobile}
          />
        </TabsContent>

        <TabsContent value="content" className="mt-6">
          <DashboardContent
            data={dashboardData.content}
            loading={dashboardData.loading}
          />
        </TabsContent>

        <TabsContent value="performance" className="mt-6">
          <DashboardPerformance
            data={dashboardData.performance}
            loading={dashboardData.loading}
          />
        </TabsContent>

        <TabsContent value="system" className="mt-6">
          <DashboardSystem
            data={dashboardData.system}
            loading={dashboardData.loading}
          />
        </TabsContent>

        {/* Ops and Users tab content only rendered for admin users */}
        {accessLevel === 'admin' && (
          <>
            <TabsContent value="operations" className="mt-6">
              <DashboardOperations
                data={dashboardData.operations}
                loading={dashboardData.loading}
              />
            </TabsContent>

            <TabsContent value="users" className="mt-6">
              <DashboardUsers
                data={dashboardData.users}
                loading={dashboardData.loading}
              />
            </TabsContent>
          </>
        )}
      </Tabs>
    </div>
  );
}
