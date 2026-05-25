import { useState, useEffect, lazy, Suspense } from "react";
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
import {
  Clock,
  Database,
  HardDrive,
  Image,
  Loader2,
  RefreshCw,
  Settings,
  Shield,
  Square,
  Play,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  useDashboardMemory,
  useClearCache,
  useExecuteMaintenanceTask,
  useClearErrorLogs,
  usePurgePosterCache,
  usePosterCacheStats,
  type DashboardTab,
} from "@/hooks/useDashboardQueries";
import { AnimatedNumber } from "../AnimatedNumber";

const formatBytes = (bytes: number): string => {
  if (!bytes || bytes === 0) return "0 MB";
  return Math.round(bytes / 1024 / 1024) + " MB";
};

export function DashboardOperations({ data, loading, activeTab }: { data: any; loading: boolean; activeTab: DashboardTab }) {
  const memoryQuery = useDashboardMemory({ activeTab });
  const memoryData = memoryQuery.data as any;

  const clearCacheMutation = useClearCache();
  const executeTaskMutation = useExecuteMaintenanceTask();
  const clearErrorsMutation = useClearErrorLogs();
  const purgePosterCacheMutation = usePurgePosterCache();
  const posterCacheStatsQuery = usePosterCacheStats({ activeTab });

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

  useEffect(() => {
    if (data) {
      setErrorLogs(data.errorLogs || []);
      setMaintenanceTasks(data.maintenanceTasks || []);

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

  const handlePurgePosterCache = () => {
    purgePosterCacheMutation.mutate(undefined, {
      onSuccess: () => {
        toast.success("Poster Cache Purge Scheduled", { description: "Cache will be cleared within 30 seconds." });
        setTimeout(() => posterCacheStatsQuery.refetch(), 35000);
      },
      onError: (error) => {
        toast.error("Poster Cache Purge Failed", { description: error.message });
      },
    });
  };

  const cacheClearing = clearCacheMutation.isPending;
  const clearingErrors = clearErrorsMutation.isPending;

  return (
    <div className="space-y-6">
      {/* Cache & Poster Management */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
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

      {posterCacheStatsQuery.data !== undefined && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Image className="h-5 w-5" />
              <CardTitle>Poster Cache</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {posterCacheStatsQuery.data ? (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Cached Images</span>
                    <p className="text-lg font-semibold"><AnimatedNumber value={posterCacheStatsQuery.data.cached_images} /></p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Disk Usage</span>
                    <p className="text-lg font-semibold">{posterCacheStatsQuery.data.disk_usage}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Max Size</span>
                    <p className="text-lg font-semibold">{posterCacheStatsQuery.data.max_size}</p>
                  </div>
                </div>
                <div className="flex justify-center mt-3 pt-3 border-t">
                  <Button
                    onClick={handlePurgePosterCache}
                    variant="outline"
                    size="sm"
                    disabled={purgePosterCacheMutation.isPending}
                    className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                  >
                    {purgePosterCacheMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Trash2 className="h-4 w-4 mr-1.5" />
                        Purge Poster Cache
                      </>
                    )}
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Poster cache not configured or unreachable.</p>
            )}
          </CardContent>
        </Card>
      )}
      </div>

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
              errorLogs.map((error: any) => (
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
                        className={`w-3 h-3 rounded-full shrink-0 ${
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
                    <div className="flex items-center space-x-2 shrink-0">
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
                          {Object.entries(error.details).map(([key, value]: [string, any]) => (
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

      {/* Memory Profiler */}
      {memoryData && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <HardDrive className="h-5 w-5" />
              <div>
                <CardTitle>Heap Profile</CardTitle>
                <CardDescription>V8 heap and in-memory cache sizes (live)</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {/* Process Memory */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-sm mb-4">
              {[
                { label: "RSS", value: memoryData.process?.rss },
                { label: "Heap Used", value: memoryData.process?.heapUsed },
                { label: "Heap Total", value: memoryData.process?.heapTotal },
                { label: "External", value: memoryData.process?.external },
                { label: "ArrayBuffers", value: memoryData.process?.arrayBuffers },
              ].map((item) => (
                <div key={item.label}>
                  <span className="text-muted-foreground">{item.label}</span>
                  <p className="text-lg font-semibold">{formatBytes(item.value)}</p>
                </div>
              ))}
            </div>

            {memoryData.v8?.maxOldSpace > 0 && (
              <div className="mb-4">
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-muted-foreground">Heap Used / Max Old Space</span>
                  <span className="font-medium">
                    {formatBytes(memoryData.process?.heapUsed)} / {memoryData.v8.maxOldSpace} MB
                  </span>
                </div>
                <Progress
                  value={Math.round((memoryData.process?.heapUsed / (memoryData.v8.maxOldSpace * 1024 * 1024)) * 100)}
                  className={`h-2 ${
                    memoryData.process?.heapUsed / (memoryData.v8.maxOldSpace * 1024 * 1024) > 0.9
                      ? "[&>div]:bg-red-600"
                      : memoryData.process?.heapUsed / (memoryData.v8.maxOldSpace * 1024 * 1024) > 0.75
                        ? "[&>div]:bg-orange-600"
                        : ""
                  }`}
                />
              </div>
            )}

            {/* In-Memory Caches */}
            <div className="border-t pt-3">
              <p className="text-sm font-medium mb-3">In-Memory Caches</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 text-sm">
                {memoryData.caches && Object.entries(memoryData.caches).map(([module, stats]: [string, any]) => {
                  if (!stats || typeof stats !== 'object') return null;
                  const entries = Object.entries(stats).filter(([, v]) => typeof v !== 'object' || v === null);
                  if (entries.length === 0) return null;
                  const sectionLabels: Record<string, string> = {
                    cache: 'Cache',
                    idMapper: 'ID Mapper',
                    tmdb: 'TMDB',
                    tvdb: 'TVDB',
                    mal: 'MAL',
                    fanart: 'Fanart',
                    trakt: 'Trakt',
                    anilist: 'AniList',
                    configCache: 'Config Cache',
                  };
                  return (
                    <div key={module} className="border rounded-lg p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                        {sectionLabels[module] || module}
                      </p>
                      <div className="space-y-1">
                        {entries.map(([key, value]: [string, any]) => {
                          const isLarge = typeof value === 'number' && value > 1000;
                          return (
                            <div key={key} className="flex justify-between">
                              <span className="text-muted-foreground truncate mr-2">{key}</span>
                              <span className={`font-mono tabular-nums ${isLarge ? 'text-orange-600 font-semibold' : ''}`}>
                                {typeof value === 'number' ? value.toLocaleString() : String(value)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

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
            {maintenanceTasks.map((task: any) => (
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
                        className={`w-3 h-3 rounded-full shrink-0 mt-1 ${
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
                      className="shrink-0"
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

                {task.warmingDetail && task.warmingDetail.uuids?.length > 0 && (
                  task.warmingDetail.isRunning ? (
                    <div className="mt-3 pt-3 border-t space-y-3">
                      {/* Live progress header */}
                      {task.warmingDetail.totalCatalogs > 0 && (
                        <div className="rounded-lg p-3 bg-blue-500/10 border border-blue-500/20">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <div className="relative flex h-2.5 w-2.5">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500" />
                              </div>
                              <span className="text-xs font-medium">Warming in progress</span>
                            </div>
                            <span className="text-xs tabular-nums">
                              <AnimatedNumber value={task.warmingDetail.catalogsWarmed} /> / {task.warmingDetail.totalCatalogs} catalogs
                            </span>
                          </div>
                          <div className="relative h-2 w-full overflow-hidden rounded-full bg-black/20">
                            <div
                              className="h-full rounded-full transition-all duration-700 ease-out bg-gradient-to-r from-blue-500 to-cyan-400"
                              style={{ width: `${(task.warmingDetail.catalogsWarmed / task.warmingDetail.totalCatalogs) * 100}%` }}
                            />
                          </div>
                        </div>
                      )}

                      {/* Per-UUID live cards */}
                      <div className="grid gap-2">
                        {task.warmingDetail.uuids.map((u: any) => {
                          const isComplete = u.totalCatalogs > 0 && u.catalogsWarmed >= u.totalCatalogs;
                          const isActive = !isComplete && u.totalCatalogs > 0 && u.catalogsWarmed < u.totalCatalogs;
                          const isPending = !isComplete && u.catalogsWarmed === 0 && (!u.totalCatalogs || u.totalCatalogs === 0);
                          const progress = u.totalCatalogs > 0 ? (u.catalogsWarmed / u.totalCatalogs) * 100 : 0;
                          return (
                            <div
                              key={u.uuid}
                              className={`rounded-md border p-2.5 transition-colors ${
                                isActive
                                  ? 'border-blue-500/40 bg-blue-500/5'
                                  : isComplete
                                    ? 'border-green-500/30 bg-green-500/5'
                                    : 'border-border/50 bg-muted/30'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0">
                                  <div className={`w-2 h-2 rounded-full shrink-0 ${
                                    isActive ? 'bg-blue-500 animate-pulse' : isComplete ? 'bg-green-500' : 'bg-muted-foreground/30'
                                  }`} />
                                  <code className="text-xs font-mono text-muted-foreground">{u.uuid}</code>
                                  {isComplete && <Badge variant="outline" className="text-[10px] h-4 px-1 border-green-500/40 text-green-600">done</Badge>}
                                  {isPending && <Badge variant="outline" className="text-[10px] h-4 px-1">queued</Badge>}
                                </div>
                                {u.totalCatalogs > 0 && (
                                  <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                                    <AnimatedNumber value={u.catalogsWarmed} />/{u.totalCatalogs}
                                    {u.duration && !isActive && <span className="hidden sm:inline"> · {u.duration}</span>}
                                  </span>
                                )}
                              </div>
                              {u.totalCatalogs > 0 && (
                                <div className="relative h-1 w-full overflow-hidden rounded-full bg-black/10 mt-2">
                                  <div
                                    className={`h-full rounded-full transition-all duration-700 ease-out ${
                                      isActive ? 'bg-blue-500' : isComplete ? 'bg-green-500' : 'bg-muted-foreground/30'
                                    }`}
                                    style={{ width: `${progress}%` }}
                                  />
                                </div>
                              )}
                              {isActive && u.currentCatalog && (
                                <p className="mt-1.5 text-[11px] text-blue-400 truncate">
                                  Warming: {u.currentCatalog}
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : task.warmingDetail.uuids.some((u: any) => u.totalCatalogs > 0) ? (
                    <div className="mt-3 pt-3 border-t">
                      <div className="grid gap-1">
                        {task.warmingDetail.uuids.map((u: any) => (
                          <div key={u.uuid} className="flex items-center gap-2 text-xs text-muted-foreground">
                            <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-green-500/60" />
                            <code className="font-mono">{u.uuid}</code>
                            {u.totalCatalogs > 0 && (
                              <span className="ml-auto tabular-nums whitespace-nowrap">
                                {u.catalogsWarmed}/{u.totalCatalogs} catalogs{u.duration && <> · {u.duration}</>}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null
                )}
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
