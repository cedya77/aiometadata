import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  BarChart3,
  Clock,
  Globe,
  Loader2,
  Search,
  TrendingUp,
  Zap,
} from "lucide-react";
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart as RechartsBarChart,
  Bar,
} from "recharts";
import { AnimatedNumber } from "../AnimatedNumber";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function getMetricColor(average: number, metricType = "general"): string {
  if (metricType === "search") {
    if (average < 3000) return "text-green-600";
    if (average < 5000) return "text-yellow-600";
    if (average < 8000) return "text-orange-600";
    return "text-red-600";
  } else {
    if (average < 500) return "text-green-600";
    if (average < 1500) return "text-yellow-600";
    if (average < 3000) return "text-orange-600";
    return "text-red-600";
  }
}

function getMetricStatus(average: number, metricType = "general"): string {
  if (metricType === "search") {
    if (average < 3000) return "Excellent";
    if (average < 5000) return "Good";
    if (average < 8000) return "Fair";
    return "Poor";
  } else {
    if (average < 500) return "Excellent";
    if (average < 1500) return "Good";
    if (average < 3000) return "Fair";
    return "Poor";
  }
}

function getMetricBadgeVariant(average: number, metricType = "general"): "default" | "secondary" | "outline" | "destructive" {
  const status = getMetricStatus(average, metricType);
  switch (status) {
    case "Excellent":
      return "default";
    case "Good":
      return "secondary";
    case "Fair":
      return "outline";
    case "Poor":
      return "destructive";
    default:
      return "secondary";
  }
}

export function DashboardPerformance({ data, loading }: { data: any; loading: boolean }) {
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
      const processedData = {
        ...data.dashboard,
        providerBreakdown: data.providerBreakdown,
        resolutionBreakdown: data.resolutionBreakdown,
        timingTrends: data.timingTrends,
      };
      setTimingMetrics(processedData);
    }
  }, [data]);

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
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
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
                .map(([_key, providerData]) => {
                  const stats = providerData as any;
                  if (stats.count === 0) return null;

                  const providerName = stats.provider || _key.toUpperCase();

                  return (
                    <div key={_key} className="p-4 rounded-lg border">
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
              ).filter(([, data]) => (data as any).type === "search")
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
                .filter(([, data]) => (data as any).type === "secondary")
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
                  <Tooltip formatter={(value: number) => [`${value}%`, "Percentage"]} />
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
