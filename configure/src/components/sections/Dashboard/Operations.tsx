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
import { Button } from "@/components/ui/button";
import { useClearCache, useExecuteMaintenanceTask, useClearErrorLogs } from "@/hooks/useDashboardQueries";
import {
    Clock,
    Database,
    Loader2,
    Play,
    RefreshCw,
    Settings,
    Shield,
    Square,
    Trash2
} from "lucide-react";
import { toast } from "sonner";

// Data is now fetched via TanStack Query at the Dashboard level (5s polling when tab is active)
export function DashboardOperations({ data, loading }) {
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