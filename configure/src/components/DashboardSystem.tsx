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
  AlertCircle,
  Eye,
  Filter,
  Globe,
  Layers,
  Monitor,
  Palette,
  Search,
  Settings,
  Shield,
  Sparkles,
  Tv,
  Users,
} from "lucide-react";
import { AnimatedNumber } from "./AnimatedNumber";

interface DashboardSystemProps {
  data: any;
}

function DistributionBar({ items, maxItems = 5 }: { items: Array<{ name: string; percentage: number; count: number }>; maxItems?: number }) {
  const visible = items?.slice(0, maxItems) || [];
  if (visible.length === 0) return <p className="text-sm text-muted-foreground text-center py-3">No data</p>;

  return (
    <div className="space-y-2.5">
      {visible.map((item, i) => {
        const colors = ["bg-blue-500", "bg-emerald-500", "bg-violet-500", "bg-amber-500", "bg-rose-500"];
        return (
          <div key={item.name} className="space-y-1">
            <div className="flex justify-between items-center text-sm">
              <span className="font-medium truncate capitalize">{item.name}</span>
              <span className="text-muted-foreground shrink-0 ml-2">{item.percentage}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full ${colors[i % colors.length]} transition-all duration-500`}
                style={{ width: `${item.percentage}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StatCard({ label, value, icon: Icon, color = "text-muted-foreground" }: { label: string; value: string | number; icon: any; color?: string }) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border bg-card">
      <div className={`p-2 rounded-lg bg-muted ${color}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <p className="text-sm font-semibold">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

function FeaturePercent({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between items-center text-sm py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold">{value}%</span>
    </div>
  );
}

export function DashboardSystem({ data }: DashboardSystemProps) {
  const [systemConfig, setSystemConfig] = useState(() => data?.systemConfig || {
    totalUsers: 0,
    sampleSize: 0,
    redisConnected: false,
    aggregatedStats: null,
  });

  const [resourceUsage, setResourceUsage] = useState(() => data?.resourceUsage || {
    memoryUsage: 0,
    cpuUsage: 0,
    diskUsage: 0,
    requestsPerMin: 0,
  });

  const [providerStatus, setProviderStatus] = useState<any[]>(() => data?.providerStatus || []);

  useEffect(() => {
    if (data) {
      if (data.systemConfig) setSystemConfig(data.systemConfig);
      if (data.resourceUsage) setResourceUsage(data.resourceUsage);
      if (data.providerStatus) setProviderStatus(data.providerStatus);
    }
  }, [data]);

  const stats = systemConfig.aggregatedStats;
  const features = stats?.features || {};
  const contentFilters = stats?.contentFilters || {};
  const catalogStats = stats?.catalogStats || { avg: 0, median: 0, total: 0 };

  const topStreamingServices = useMemo(() => {
    return stats?.streamingServices?.slice(0, 8) || [];
  }, [stats?.streamingServices]);

  const healthIssues = useMemo(() => {
    const issues: { message: string; severity: "warning" | "critical" }[] = [];
    if (!systemConfig.redisConnected) issues.push({ message: "Redis disconnected", severity: "critical" });
    if (resourceUsage.memoryUsage > 90) issues.push({ message: `Memory critical (${resourceUsage.memoryUsage}%)`, severity: "critical" });
    else if (resourceUsage.memoryUsage > 75) issues.push({ message: `Memory elevated (${resourceUsage.memoryUsage}%)`, severity: "warning" });
    if (resourceUsage.cpuUsage > 90) issues.push({ message: `CPU critical (${resourceUsage.cpuUsage}%)`, severity: "critical" });
    else if (resourceUsage.cpuUsage > 75) issues.push({ message: `CPU elevated (${resourceUsage.cpuUsage}%)`, severity: "warning" });
    return issues;
  }, [systemConfig.redisConnected, resourceUsage]);

  const overallHealth = healthIssues.some(i => i.severity === "critical") ? "critical" : healthIssues.some(i => i.severity === "warning") ? "warning" : "healthy";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-muted">
            <Users className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">User Configuration Insights</h3>
            <p className="text-sm text-muted-foreground">
              {systemConfig.totalUsers || 0} users
              {systemConfig.sampleSize && systemConfig.sampleSize < systemConfig.totalUsers &&
                ` (${systemConfig.sampleSize} sampled)`}
            </p>
          </div>
        </div>
        <Badge variant={overallHealth === "healthy" ? "default" : overallHealth === "warning" ? "secondary" : "destructive"}>
          {overallHealth === "healthy" ? "All Systems Healthy" : overallHealth === "warning" ? "Warning" : "Critical"}
        </Badge>
      </div>

      {/* Catalog Usage Overview */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="Avg/User" value={catalogStats.avg || "—"} icon={Layers} color="text-blue-500" />
        <StatCard label="Median" value={catalogStats.median || "—"} icon={Layers} color="text-indigo-500" />
        <StatCard label="Max" value={catalogStats.max || "—"} icon={Layers} color="text-rose-500" />
        <StatCard label="P25 / P75" value={`${catalogStats.p25 || 0} / ${catalogStats.p75 || 0}`} icon={Layers} color="text-amber-500" />
        <StatCard label="Total Catalogs" value={catalogStats.total || "—"} icon={Activity} color="text-emerald-500" />
        <StatCard label="AI Search" value={`${features.aiSearchEnabled || 0}%`} icon={Sparkles} color="text-violet-500" />
      </div>

      {/* Catalog Sources & Meta Providers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-blue-500" />
              <CardTitle className="text-sm font-medium">Catalog Sources</CardTitle>
            </div>
            <CardDescription className="text-xs">Where users add catalogs from</CardDescription>
          </CardHeader>
          <CardContent>
            <DistributionBar items={stats?.catalogSources} maxItems={8} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Monitor className="h-4 w-4 text-emerald-500" />
              <CardTitle className="text-sm font-medium">Meta Providers</CardTitle>
            </div>
            <CardDescription className="text-xs">Metadata source preferences</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {["movie", "series", "anime"].map((type) => (
                <div key={type}>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">{type}</p>
                  <div className="flex gap-2 flex-wrap">
                    {stats?.metaProviders?.[type]?.slice(0, 4).map((p: any) => (
                      <Badge key={p.name} variant="secondary" className="text-xs">
                        {p.name.toUpperCase()} {p.percentage}%
                      </Badge>
                    )) || <span className="text-xs text-muted-foreground">No data</span>}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Art Providers & Search Providers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Palette className="h-4 w-4 text-pink-500" />
              <CardTitle className="text-sm font-medium">Art Providers</CardTitle>
            </div>
            <CardDescription className="text-xs">Who provides posters, backgrounds & logos</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {["movie", "series", "anime"].map((type) => {
                const artType = stats?.artProviders?.[type];
                if (!artType) return null;
                return (
                  <div key={type}>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">{type}</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                      {["poster", "background", "logo"].map((artKind) => {
                        const items = artType[artKind] || [];
                        const top = items.slice(0, 3);
                        const otherPct = items.length > 3 ? items.slice(3).reduce((sum: number, p: any) => sum + p.percentage, 0) : 0;
                        return (
                          <div key={artKind}>
                            <p className="text-[10px] text-muted-foreground mb-1 capitalize">{artKind}</p>
                            {top.map((p: any) => (
                              <div key={p.name} className="flex justify-between">
                                <span className="capitalize truncate">{p.name}</span>
                                <span className="text-muted-foreground ml-1">{p.percentage}%</span>
                              </div>
                            ))}
                            {otherPct > 0 && (
                              <div className="flex justify-between text-muted-foreground">
                                <span>other</span>
                                <span className="ml-1">{otherPct}%</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-indigo-500" />
              <CardTitle className="text-sm font-medium">Search Providers</CardTitle>
            </div>
            <CardDescription className="text-xs">Search engine preferences by type</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {[
                { key: "movie", label: "Movie" },
                { key: "series", label: "Series" },
                { key: "anime_series", label: "Anime" },
              ].map(({ key, label }) => (
                <div key={key}>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">{label}</p>
                  <div className="flex gap-2 flex-wrap">
                    {stats?.searchProviders?.[key]?.slice(0, 3).map((p: any) => (
                      <Badge key={p.name} variant="secondary" className="text-xs">
                        {p.name.replace('.search', '')} {p.percentage}%
                      </Badge>
                    )) || <span className="text-xs text-muted-foreground">No data</span>}
                  </div>
                </div>
              ))}
              {stats?.aiProvider?.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">AI Provider</p>
                  <div className="flex gap-2 flex-wrap">
                    {stats.aiProvider.slice(0, 3).map((p: any) => (
                      <Badge key={p.name} variant="outline" className="text-xs capitalize">
                        {p.name} {p.percentage}%
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Language, Streaming & Feature Adoption */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-violet-500" />
              <CardTitle className="text-sm font-medium">Languages</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <DistributionBar items={stats?.languages} maxItems={5} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Tv className="h-4 w-4 text-cyan-500" />
              <CardTitle className="text-sm font-medium">Streaming Services</CardTitle>
            </div>
            <CardDescription className="text-xs">Most selected services</CardDescription>
          </CardHeader>
          <CardContent>
            {topStreamingServices.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-3">No data</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {topStreamingServices.map((s: any) => (
                  <Badge key={s.name} variant="secondary" className="text-xs">
                    {s.name} <span className="ml-1 text-muted-foreground">({s.count})</span>
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Eye className="h-4 w-4 text-blue-500" />
              <CardTitle className="text-sm font-medium">Watch Tracking</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-0.5">
              <FeaturePercent label="Trakt" value={features.traktWatchTracking || 0} />
              <FeaturePercent label="AniList" value={features.anilistWatchTracking || 0} />
              <FeaturePercent label="Simkl" value={features.simklWatchTracking || 0} />
              <FeaturePercent label="MDBList" value={features.mdblistWatchTracking || 0} />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Content Filters & Features */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-amber-500" />
              <CardTitle className="text-sm font-medium">Content Filters</CardTitle>
            </div>
            <CardDescription className="text-xs">How users customize filtering</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0.5">
              <FeaturePercent label="SFW Mode" value={contentFilters.sfw || 0} />
              <FeaturePercent label="Include Adult" value={contentFilters.includeAdult || 0} />
              <FeaturePercent label="Hide Unreleased (Digital)" value={contentFilters.hideUnreleasedDigital || 0} />
              <FeaturePercent label="Hide Unreleased (Shows)" value={contentFilters.hideUnreleasedShows || 0} />
              <FeaturePercent label="Hide Watched (Trakt)" value={contentFilters.hideWatchedTrakt || 0} />
              <FeaturePercent label="Hide Watched (AniList)" value={contentFilters.hideWatchedAnilist || 0} />
              <FeaturePercent label="Hide Watched (MDBList)" value={contentFilters.hideWatchedMdblist || 0} />
              <FeaturePercent label="Exclusion Keywords" value={contentFilters.exclusionKeywords || 0} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Settings className="h-4 w-4 text-slate-500" />
              <CardTitle className="text-sm font-medium">Other Features</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0.5">
              <FeaturePercent label="Rating Posters (RPDB)" value={features.ratingPostersRpdb || 0} />
              <FeaturePercent label="Rating Posters (Top)" value={features.ratingPostersTop || 0} />
              <FeaturePercent label="Skip Filler" value={features.skipFiller || 0} />
              <FeaturePercent label="Skip Recap" value={features.skipRecap || 0} />
              <FeaturePercent label="Poster Proxy" value={contentFilters.posterProxy || 0} />
              <FeaturePercent label="Force Anime Detection" value={contentFilters.forceAnimeDetection || 0} />
            </div>
            {stats?.animeIdProviders?.length > 0 && (
              <div className="mt-4 pt-3 border-t">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Anime ID Provider</p>
                <div className="flex gap-2 flex-wrap">
                  {stats.animeIdProviders.slice(0, 3).map((p: any) => (
                    <Badge key={p.name} variant="outline" className="text-xs uppercase">
                      {p.name} {p.percentage}%
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* System Health & Resources */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-green-500" />
              <CardTitle className="text-sm font-medium">System Health</CardTitle>
            </div>
            <Badge variant={overallHealth === "healthy" ? "default" : overallHealth === "critical" ? "destructive" : "secondary"}>
              {overallHealth}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {healthIssues.length > 0 && (
              <div className="space-y-1 mb-3">
                {healthIssues.map((issue, idx) => (
                  <p key={idx} className={`text-sm flex items-center gap-1.5 ${issue.severity === "critical" ? "text-red-500" : "text-amber-500"}`}>
                    <AlertCircle className="h-3.5 w-3.5" />
                    {issue.message}
                  </p>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              {/* Memory */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span>Memory</span>
                  <span className={`font-medium ${resourceUsage.memoryUsage > 90 ? "text-red-500" : resourceUsage.memoryUsage > 75 ? "text-amber-500" : "text-green-500"}`}>
                    <AnimatedNumber value={resourceUsage.memoryUsage} suffix="%" />
                  </span>
                </div>
                <Progress
                  value={resourceUsage.memoryUsage}
                  className={`h-2 ${resourceUsage.memoryUsage > 90 ? "[&>div]:bg-red-500" : resourceUsage.memoryUsage > 75 ? "[&>div]:bg-amber-500" : ""}`}
                />
              </div>

              {/* CPU */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span>CPU</span>
                  <span className={`font-medium ${resourceUsage.cpuUsage > 80 ? "text-red-500" : resourceUsage.cpuUsage > 60 ? "text-amber-500" : "text-green-500"}`}>
                    <AnimatedNumber value={resourceUsage.cpuUsage} suffix="%" />
                  </span>
                </div>
                <Progress
                  value={resourceUsage.cpuUsage}
                  className={`h-2 ${resourceUsage.cpuUsage > 80 ? "[&>div]:bg-red-500" : resourceUsage.cpuUsage > 60 ? "[&>div]:bg-amber-500" : ""}`}
                />
              </div>

              {/* Disk */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span>Disk</span>
                  <span className={`font-medium ${resourceUsage.diskUsage > 90 ? "text-red-500" : resourceUsage.diskUsage > 75 ? "text-amber-500" : "text-green-500"}`}>
                    <AnimatedNumber value={resourceUsage.diskUsage} suffix="%" />
                  </span>
                </div>
                <Progress
                  value={resourceUsage.diskUsage}
                  className={`h-2 ${resourceUsage.diskUsage > 90 ? "[&>div]:bg-red-500" : resourceUsage.diskUsage > 75 ? "[&>div]:bg-amber-500" : ""}`}
                />
              </div>

              {/* Requests */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span>Throughput</span>
                  <span className="font-medium text-blue-500">
                    <AnimatedNumber value={resourceUsage.requestsPerMin} /> req/min
                  </span>
                </div>
                <div className="h-2" />
              </div>
            </div>

            {/* Provider Status */}
            {providerStatus.length > 0 && (
              <div className="pt-3 border-t">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Provider Status</p>
                  <p className="text-[10px] text-muted-foreground">calls today</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {[...providerStatus]
                    .sort((a, b) => (b.stats?.callsToday || 0) - (a.stats?.callsToday || 0))
                    .map((provider, i) => (
                    <div key={i} className="flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs">
                      <div className={`w-2 h-2 rounded-full ${
                        provider.status === "healthy" ? "bg-green-500" :
                        provider.status === "degraded" ? "bg-yellow-500" :
                        provider.status === "down" ? "bg-red-500" : "bg-gray-400"
                      }`} />
                      <span className="font-medium">{provider.name}</span>
                      {provider.stats?.callsToday > 0 && (
                        <span className="text-muted-foreground">{provider.stats.callsToday.toLocaleString()}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
