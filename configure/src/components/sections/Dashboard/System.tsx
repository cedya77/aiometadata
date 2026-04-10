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
import {
    Users,
    Monitor,
    TrendingUp,
    Zap,
    Globe,
    Settings,
    Eye,
    Star,
    Search,
    AlertCircle
} from "lucide-react";

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

export function DashboardSystem({ data, loading }) {
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
                
                <div className="mt-2 space-y-2">
                  {[
                    { name: "AniList", value: systemConfig.aggregatedStats?.features?.anilistWatchTracking || 0, color: "bg-blue-500" },
                    { name: "MDBList", value: systemConfig.aggregatedStats?.features?.mdblistWatchTracking || 0, color: "bg-indigo-500" },
                    { name: "Simkl", value: systemConfig.aggregatedStats?.features?.simklWatchTracking || 0, color: "bg-red-500" },
                    { name: "Trakt", value: systemConfig.aggregatedStats?.features?.traktWatchTracking || 0, color: "bg-red-600" },
                  ].map(item => (
                    <div key={item.name} className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${item.color}`} />
                      <span className="text-sm flex-1">{item.name}</span>
                      <span className="text-sm text-muted-foreground">{item.value}%</span>
                    </div>
                  ))}
                </div>
                
                <div className="flex mt-6 pt-4 border-t border-border">
                  <p className="text-sm text-muted-foreground">
                    <span className="font-bold">AniList</span> is currently the most popular tracker
                  </p>
                </div>
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