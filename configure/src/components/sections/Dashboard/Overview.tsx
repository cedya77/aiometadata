import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { FadeValue, AnimatedNumber } from "@/components/AnimatedNumber";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription
} from "@/components/ui/card";
import { Progress } from "@radix-ui/react-progress";
import {
  Activity,
  BarChart3,
  Database,
  Users,
  Shield,
  AlertCircle
} from "lucide-react";

const formatBytes = (bytes: number): string => {
  if (!bytes || bytes === 0) return "0 MB";
  return Math.round(bytes / 1024 / 1024) + " MB";
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

export function DashboardOverview({ data, systemData, loading }) {
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