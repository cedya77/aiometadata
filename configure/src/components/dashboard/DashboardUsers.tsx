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
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Activity,
  AlertCircle,
  BarChart3,
  Loader2,
  Shield,
  Settings,
  Trash2,
  Users,
} from "lucide-react";
import {
  useDashboardHeatmap,
  useClearUserData,
  type DashboardTab,
  type HeatmapData,
} from "@/hooks/useDashboardQueries";
import { useAdmin } from "@/contexts/AdminContext";
import { AnimatedNumber } from "../AnimatedNumber";

const LazyUserManagementModal = lazy(() =>
  import("../UserManagementModal").then((module) => ({ default: module.UserManagementModal }))
);

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOUR_LABELS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));

function ActivityHeatmap({ data, days, onDaysChange }: { data: HeatmapData | undefined; days: number; onDaysChange: (d: number) => void }) {
  const grid = data?.grid || Array.from({ length: 7 }, () => new Array(24).fill(0));
  const peak = data?.peak || 1;
  const [tooltip, setTooltip] = useState<{ day: number; hour: number; value: number; x: number; y: number } | null>(null);

  function getColor(value: number): string {
    if (value === 0) return 'bg-white/[0.03]';
    const ratio = value / peak;
    if (ratio < 0.15) return 'bg-blue-500/15';
    if (ratio < 0.3) return 'bg-blue-500/30';
    if (ratio < 0.5) return 'bg-blue-500/50';
    if (ratio < 0.7) return 'bg-blue-500/70';
    if (ratio < 0.85) return 'bg-blue-500/85';
    return 'bg-blue-500';
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-blue-500" />
            <div>
              <CardTitle className="text-lg">Request Activity</CardTitle>
              <CardDescription>Requests by day of week and hour</CardDescription>
            </div>
          </div>
          <div className="flex gap-1 rounded-lg border p-0.5">
            {[7, 14, 30].map((d) => (
              <button
                key={d}
                onClick={() => onDaysChange(d)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                  days === d ? 'bg-blue-500/15 text-blue-400' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="relative">
          <div className="flex">
            {/* Day labels */}
            <div className="flex flex-col justify-between pr-2 pt-6 pb-0.5">
              {DAY_LABELS.map((label) => (
                <span key={label} className="text-[11px] text-muted-foreground h-[22px] flex items-center">{label}</span>
              ))}
            </div>
            {/* Grid */}
            <div className="flex-1 min-w-0">
              {/* Hour labels */}
              <div className="flex mb-1">
                {HOUR_LABELS.map((label, i) => (
                  <span
                    key={label}
                    className="flex-1 text-center text-[10px] text-muted-foreground/60"
                    style={{ visibility: i % 3 === 0 ? 'visible' : 'hidden' }}
                  >
                    {label}
                  </span>
                ))}
              </div>
              {/* Cells */}
              <div className="flex flex-col gap-[3px]">
                {grid.map((row, dayIdx) => (
                  <div key={dayIdx} className="flex gap-[3px]">
                    {row.map((value, hourIdx) => (
                      <div
                        key={hourIdx}
                        className={`flex-1 h-[22px] rounded-[3px] transition-colors cursor-default ${getColor(value)} hover:ring-1 hover:ring-blue-400/50`}
                        onMouseEnter={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const parentRect = e.currentTarget.closest('.relative')!.getBoundingClientRect();
                          setTooltip({ day: dayIdx, hour: hourIdx, value, x: rect.left - parentRect.left + rect.width / 2, y: rect.top - parentRect.top });
                        }}
                        onMouseLeave={() => setTooltip(null)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Tooltip */}
          {tooltip && (
            <div
              className="absolute z-10 pointer-events-none px-2.5 py-1.5 rounded-lg bg-popover border shadow-lg text-xs -translate-x-1/2 -translate-y-full"
              style={{ left: tooltip.x, top: tooltip.y - 6 }}
            >
              <span className="font-medium">{tooltip.value.toLocaleString()}</span>
              <span className="text-muted-foreground"> requests</span>
              <div className="text-muted-foreground">{DAY_LABELS[tooltip.day]} {HOUR_LABELS[tooltip.hour]}:00</div>
            </div>
          )}

          {/* Legend */}
          <div className="flex items-center justify-end gap-1.5 mt-3 text-[11px] text-muted-foreground">
            <span>Less</span>
            {[0, 0.15, 0.3, 0.5, 0.7, 0.85, 1].map((ratio) => (
              <div
                key={ratio}
                className={`w-3 h-3 rounded-[2px] ${getColor(ratio === 0 ? 0 : ratio * peak)}`}
              />
            ))}
            <span>More</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function DashboardUsers({ data, loading, activeTab }: { data: any; loading: boolean; activeTab: DashboardTab }) {
  const { adminKey } = useAdmin();
  const [heatmapDays, setHeatmapDays] = useState(7);
  const heatmapQuery = useDashboardHeatmap({ activeTab, days: heatmapDays });

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
  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [showUserDetails, setShowUserDetails] = useState(false);

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

  const clearingUserData = clearUserDataMutation.isPending;

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

      {/* Activity Heatmap */}
      <ActivityHeatmap data={heatmapQuery.data as HeatmapData | undefined} days={heatmapDays} onDaysChange={setHeatmapDays} />

      {/* User Activity */}
      <Card>
        <CardHeader>
          <CardTitle>Recent User Activity</CardTitle>
          <CardDescription>Latest user interactions and status</CardDescription>
        </CardHeader>
        <CardContent>
          {userActivity.length > 0 ? (
            <div className="space-y-3">
              {userActivity.map((user: any) => (
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
      {showUserManagement ? (
        <Suspense fallback={null}>
          <LazyUserManagementModal
            isOpen={showUserManagement}
            onClose={() => setShowUserManagement(false)}
            adminKey={adminKey}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
