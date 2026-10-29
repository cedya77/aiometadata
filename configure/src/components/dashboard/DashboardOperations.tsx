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
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Clock,
  Database,
  HardDrive,
  Image,
  Loader2,
  RefreshCw,
  Settings,
  Shield,
  Sliders,
  Square,
  Play,
  Trash2,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";

const TASK_ACTION_ICONS: Record<string, typeof Image> = {
  image: Image,
  clock: Clock,
};
import {
  useDashboardMemory,
  useClearCache,
  useExecuteMaintenanceTask,
  useClearErrorLogs,
  usePurgePosterCache,
  usePosterCacheStats,
  useInvalidateCachedImage,
  useClearArtById,
  type ClearArtByIdResult,
  useClearCacheById,
  useColdStoreStats,
  usePurgeColdStore,
  useSweepColdStore,
  type DashboardTab,
} from "@/hooks/useDashboardQueries";
import { AnimatedNumber } from "../AnimatedNumber";
import { ImageCachePolicyDialog } from "./ImageCachePolicyDialog";
import { IMAGE_TYPE_LABELS } from "@/lib/imageClassLabels";

const formatBytes = (bytes: number): string => {
  if (!bytes || bytes === 0) return "0 MB";
  return Math.round(bytes / 1024 / 1024) + " MB";
};

/** Compact size for cold-store figures, which start far below the 1 MB floor above. */
const formatSize = (bytes: number): string => {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
};

const formatAge = (timestamp: number | null): string => {
  if (!timestamp) return "—";
  const days = Math.round(Math.abs(Date.now() - timestamp) / 86400000);
  if (days >= 1) return `${days}d`;
  const hours = Math.round(Math.abs(Date.now() - timestamp) / 3600000);
  return hours >= 1 ? `${hours}h` : "<1h";
};

const MEDIA_ID_RE = [
  /^tt\d{7,10}$/i,
  /^(?:tmdb|tvdb|tvdbc|kitsu|mal|anilist|anidb):[A-Za-z0-9._-]+$/i,
  /^tun_[A-Za-z0-9._:-]+$/i,
];
const totalTasks = (stats: any): number => (stats?.totalCatalogs || 0) + (stats?.totalPinned || 0);
const warmedTasks = (stats: any): number => (stats?.catalogsWarmed || 0) + (stats?.pinnedWarmed || 0);
const looksLikeMediaId = (token: string) => MEDIA_ID_RE.some((re) => re.test(token.trim()));

const COLD_TIER_LABELS: Record<string, string> = {
  frozen: "Frozen",
  stable: "Stable",
  partial: "Partial",
};

const COLD_TIER_HINTS: Record<string, string> = {
  frozen: "Older than FROZEN_AGE — longest disk TTL",
  stable: "Recently finished — shorter disk TTL",
  partial: "Served from a language fallback — short disk TTL, re-checked within COLD_TTL_PARTIAL",
};


export function DashboardOperations({ data, loading, activeTab }: { data: any; loading: boolean; activeTab: DashboardTab }) {
  const memoryQuery = useDashboardMemory({ activeTab });
  const memoryData = memoryQuery.data as any;

  const clearCacheMutation = useClearCache();
  const clearByIdMutation = useClearCacheById();
  const [clearToken, setClearToken] = useState("");
  const [clearPreview, setClearPreview] = useState<{ count: number; samples: string[]; matchMode?: string; coldStoreCount?: number; titleInfo?: { title: string; year?: number | null; type?: string } | null } | null>(null);
  const executeTaskMutation = useExecuteMaintenanceTask();
  const clearErrorsMutation = useClearErrorLogs();
  const purgePosterCacheMutation = usePurgePosterCache();
  const posterCacheStatsQuery = usePosterCacheStats({ activeTab });
  const invalidateImageMutation = useInvalidateCachedImage();
  const clearArtByIdMutation = useClearArtById();

  // Three states, not two. An operator running standalone nginx (README Option B)
  // has real figures and a working purge with the built-in store off, and must
  // keep both — `builtin === false` on its own is the wrong gate for hiding them.
  const posterCacheStats = posterCacheStatsQuery.data as
    | { builtin?: boolean; external?: 'ok' | 'unreachable' | 'none'; by_type?: unknown; [key: string]: any }
    | null
    | undefined;
  const posterProxyMode = posterCacheStats?.builtin === false;
  const posterExternal = posterCacheStats?.external;
  const posterHasFigures = !posterProxyMode || posterExternal === 'ok';

  const coldStoreStatsQuery = useColdStoreStats({ activeTab });
  const purgeColdStoreMutation = usePurgeColdStore();
  const sweepColdStoreMutation = useSweepColdStore();
  const [coldStoreMetaId, setColdStoreMetaId] = useState("");
  const [coldPurgingScope, setColdPurgingScope] = useState<"all" | "title" | null>(null);

  // Targeted "act on one id" operations live in dialogs so their inputs stay out
  // of the resting layout. Each closes on a successful action (see the handlers).
  const [clearByIdOpen, setClearByIdOpen] = useState(false);
  const [refreshImageOpen, setRefreshImageOpen] = useState(false);
  const [clearArtOpen, setClearArtOpen] = useState(false);
  const [clearArtId, setClearArtId] = useState("");
  const [clearArtResult, setClearArtResult] = useState<ClearArtByIdResult | null>(null);
  const [dropTitleOpen, setDropTitleOpen] = useState(false);

  // Each clear defaults to hitting both tiers — clearing only one leaves the
  // other still serving the entry — but stays opt-out so an operator can keep
  // the expensive disk tier while refreshing Redis, or vice versa.
  const [clearByIdIncludeDisk, setClearByIdIncludeDisk] = useState(true);
  const [dropTitleIncludeRedis, setDropTitleIncludeRedis] = useState(true);

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

  const handleClearById = (dryRun: boolean) => {
    const token = clearToken.trim();
    if (!token) return;
    clearByIdMutation.mutate({ token, dryRun, includeColdStore: clearByIdIncludeDisk }, {
      onSuccess: (result) => {
        if (result.dryRun) {
          setClearPreview({
            count: result.deletedCount,
            samples: result.samples,
            matchMode: (result as any).matchMode,
            coldStoreCount: (result as any).coldStoreCount,
            titleInfo: (result as any).titleInfo,
          });
          toast.info("Preview", { description: result.message });
        } else {
          setClearPreview(null);
          setClearToken("");
          setClearByIdOpen(false);
          toast.success("Cache Cleared", { description: result.message });
        }
      },
      onError: (error) => {
        setClearPreview(null);
        toast.error("Clear Failed", { description: error.message });
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

  const [purgingType, setPurgingType] = useState<string | null>(null);
  const [refreshUrl, setRefreshUrl] = useState("");
  const [policyDialogOpen, setPolicyDialogOpen] = useState(false);

  const handleRefreshImage = () => {
    const url = refreshUrl.trim();
    if (!url) return;
    invalidateImageMutation.mutate(url, {
      onSuccess: (result) => {
        if (result?.removed?.length) {
          toast.success("Image Refreshed", { description: result.message });
          setRefreshUrl("");
          setRefreshImageOpen(false);
        } else {
          // Not an error: the next request will fetch it fresh either way. Keep
          // the dialog open so a mistyped URL can be corrected without reopening.
          toast.info("Not Cached", { description: result?.message || "That image was not in the cache." });
        }
      },
      onError: (error) => {
        toast.error("Refresh Failed", { description: error.message });
      },
    });
  };

  const handleClearArtById = () => {
    const id = clearArtId.trim();
    if (!id) return;
    setClearArtResult(null);
    clearArtByIdMutation.mutate(id, {
      onSuccess: (result) => setClearArtResult(result),
      onError: (error) => toast.error("Clear Failed", { description: error.message }),
    });
  };

  const handlePurgePosterCache = (type?: string) => {
    if (type && !window.confirm(`Clear all cached ${IMAGE_TYPE_LABELS[type] || type} images? They will be re-fetched on demand.`)) {
      return;
    }
    setPurgingType(type ?? "all");
    purgePosterCacheMutation.mutate(type, {
      onSuccess: (result) => {
        const label = type ? (IMAGE_TYPE_LABELS[type] || type) : "All images";
        if (typeof result?.freed_bytes === "number") {
          // Built-in cache purges synchronously and reports what it reclaimed.
          toast.success("Image Cache Cleared", { description: `${label}: ${formatBytes(result.freed_bytes)} freed.` });
          posterCacheStatsQuery.refetch();
        } else {
          // Standalone nginx clears on its own polling interval.
          toast.success("Poster Cache Purge Scheduled", { description: "Cache will be cleared within 30 seconds." });
          setTimeout(() => posterCacheStatsQuery.refetch(), 35000);
        }
      },
      onError: (error) => {
        toast.error("Image Cache Purge Failed", { description: error.message });
      },
      onSettled: () => setPurgingType(null),
    });
  };

  const handlePurgeColdStore = (metaId?: string) => {
    if (!metaId && !window.confirm("Drop every entry from the meta cold store? Stable titles will be re-fetched from their providers on the next request.")) {
      return;
    }
    setColdPurgingScope(metaId ? "title" : "all");
    purgeColdStoreMutation.mutate({ metaId, includeRedis: dropTitleIncludeRedis }, {
      onSuccess: (result: any) => {
        if (metaId && result?.removed === 0) {
          // Keep the dialog open and the input intact so a mistyped id can be fixed.
          toast.info("Nothing to remove", { description: `No cold-store entries for ${metaId}.` });
        } else {
          const redisNote = result?.redisRemoved
            ? ` + ${result.redisRemoved} Redis key(s)`
            : "";
          toast.success("Cold Store Purged", {
            description: metaId
              ? `${metaId}: ${result?.removed ?? 0} component(s) dropped${redisNote}.`
              : `${result?.removed ?? 0} component(s) dropped.`,
          });
          if (metaId) {
            setColdStoreMetaId("");
            setDropTitleOpen(false);
          }
        }
      },
      onError: (error) => {
        toast.error("Cold Store Purge Failed", { description: error.message });
      },
      onSettled: () => setColdPurgingScope(null),
    });
  };

  const handleSweepColdStore = () => {
    sweepColdStoreMutation.mutate(undefined, {
      onSuccess: (result: any) => {
        toast.success("Cold Store Swept", {
          description: result?.removed
            ? `${result.removed} expired or inactive row(s) dropped.`
            : "Nothing expired or inactive.",
        });
      },
      onError: (error) => {
        toast.error("Cold Store Sweep Failed", { description: error.message });
      },
    });
  };

  const cacheClearing = clearCacheMutation.isPending;
  const clearingErrors = clearErrorsMutation.isPending;

  const errorCounts = errorLogs.reduce(
    (acc: { error: number; warning: number; info: number }, e: any) => {
      if (e.level === "error") acc.error += 1;
      else if (e.level === "warning") acc.warning += 1;
      else acc.info += 1;
      return acc;
    },
    { error: 0, warning: 0, info: 0 }
  );

  return (
    <div className="space-y-6">
      {/* Redis L1 cache — full width above the two disk-backed stores */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5" />
            <CardTitle>Cache Management</CardTitle>
            <Badge variant="outline" className="ml-auto font-normal">Redis · L1</Badge>
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
              <Dialog
                open={clearByIdOpen}
                onOpenChange={(o) => { setClearByIdOpen(o); if (!o) setClearPreview(null); }}
              >
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Trash2 className="h-4 w-4 mr-1.5" />
                    Clear by ID…
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Clear cached entries by ID</DialogTitle>
                    <DialogDescription>
                      Removes every cached entry whose key contains this value — a meta id
                      (<code>tt0111161</code>, <code>mal:64019</code>) or a catalog id
                      (<code>movielens.toppicks</code>). Preview first to see what matches.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-3">
                    <Input
                      autoFocus
                      placeholder="tt0111161 or movielens.toppicks"
                      value={clearToken}
                      onChange={(e) => { setClearToken(e.target.value); setClearPreview(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter") handleClearById(true); }}
                      disabled={clearByIdMutation.isPending}
                    />
                    {/* Make the match mode visible before anything is deleted. */}
                    {clearToken.trim().length >= 3 && (
                      <p className="text-xs -mt-1">
                        {looksLikeMediaId(clearToken) ? (
                          <span className="text-muted-foreground">
                            Recognized media id — clears <span className="font-medium text-foreground">this title only</span>.
                            {clearPreview?.titleInfo?.title && (
                              <>
                                {" "}
                                <span className="font-medium text-foreground">
                                  {clearPreview.titleInfo.title}
                                  {clearPreview.titleInfo.year ? ` (${clearPreview.titleInfo.year})` : ""}
                                </span>
                              </>
                            )}
                          </span>
                        ) : (
                          <span className="text-amber-600 dark:text-amber-500">
                            Not a complete media id — clears <span className="font-medium">any entry containing this text</span>. Preview first.
                          </span>
                        )}
                      </p>
                    )}
                    {/* Only meaningful when there is a disk tier to clear. */}
                    {coldStoreStatsQuery.data?.configured && (
                      <div className="flex items-center justify-between gap-3 rounded-md border p-2.5">
                        <div className="space-y-0.5">
                          <Label htmlFor="clear-by-id-disk" className="text-sm">Clear on disk too</Label>
                          <p className="text-xs text-muted-foreground">
                            Also drop matching cold-store entries. Without this the title is
                            restored from disk on the next request.
                          </p>
                        </div>
                        <Switch
                          id="clear-by-id-disk"
                          checked={clearByIdIncludeDisk}
                          onCheckedChange={(v) => { setClearByIdIncludeDisk(v); setClearPreview(null); }}
                          disabled={clearByIdMutation.isPending}
                        />
                      </div>
                    )}
                    {clearPreview && (
                      <div className="rounded-md border bg-muted/40 p-2 space-y-1">
                        <p className="text-xs font-medium">
                          {clearPreview.count.toLocaleString()} matching entries
                          {clearPreview.coldStoreCount ? ` (${clearPreview.coldStoreCount} on disk)` : ""}
                          {clearPreview.matchMode && (
                            <Badge variant="outline" className="ml-2 font-normal">
                              {clearPreview.matchMode === "exact" ? "exact match" : "substring"}
                            </Badge>
                          )}
                        </p>
                        {clearPreview.samples.length > 0 && (
                          <ul className="text-[11px] font-mono text-muted-foreground space-y-0.5 max-h-40 overflow-auto">
                            {clearPreview.samples.map((k) => <li key={k} className="whitespace-nowrap">{k}</li>)}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                  <DialogFooter>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setClearByIdOpen(false)}
                      disabled={clearByIdMutation.isPending}
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={() => handleClearById(true)}
                      variant="outline"
                      size="sm"
                      disabled={clearByIdMutation.isPending || clearToken.trim().length < 3}
                    >
                      {clearByIdMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Preview"}
                    </Button>
                    <Button
                      onClick={() => handleClearById(false)}
                      variant="outline"
                      size="sm"
                      disabled={clearByIdMutation.isPending || clearToken.trim().length < 3}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                    >
                      <Trash2 className="h-4 w-4 mr-1.5" />
                      Clear
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* On-disk stores: image cache and meta cold store, paired by storage tier.
          Either spans the full row when the other is unavailable, so no gap opens. */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
      {posterCacheStatsQuery.data !== undefined && (
        <Card className={!coldStoreStatsQuery.data ? "xl:col-span-2" : undefined}>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Image className="h-5 w-5" />
              <CardTitle>Image Cache</CardTitle>
              <Badge variant="outline" className="ml-auto font-normal">On-disk</Badge>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {posterCacheStatsQuery.data ? (
              <>
                {posterHasFigures && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
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
                    {posterCacheStatsQuery.data.ttl && (
                      <div>
                        <span className="text-muted-foreground">Validity</span>
                        <p className="text-lg font-semibold">{posterCacheStatsQuery.data.ttl}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Nothing of ours is stored, and no external cache answered. The
                    rules are still in force — they decide the response headers. */}
                {posterProxyMode && posterExternal === 'unreachable' && (
                  <p className="text-sm text-muted-foreground">
                    Image cache not configured or unreachable.
                  </p>
                )}
                {posterProxyMode && posterExternal === 'none' && (
                  <p className="text-sm text-muted-foreground">
                    Nothing is stored here — art passes through and is served with the
                    headers your per-provider rules decide. Open <em>Advanced…</em> to set them.
                  </p>
                )}

                {/* Per-type breakdown. Absent when an external proxy serves the
                    cache, since it cannot report which class an image belongs to. */}
                {posterCacheStatsQuery.data.by_type && Object.keys(posterCacheStatsQuery.data.by_type).length > 0 && (
                  <div className="mt-4 pt-3 border-t space-y-1">
                    {Object.entries(posterCacheStatsQuery.data.by_type as Record<string, any>).map(([type, stats]) => (
                      <div key={type} className="flex items-center justify-between gap-3 text-sm py-1">
                        <span className="font-medium">{IMAGE_TYPE_LABELS[type] || type}</span>
                        <div className="flex items-center gap-3">
                          <span className="text-muted-foreground tabular-nums">
                            {stats.count.toLocaleString()} · {stats.human}
                          </span>
                          <Button
                            onClick={() => handlePurgePosterCache(type)}
                            variant="ghost"
                            size="sm"
                            disabled={purgePosterCacheMutation.isPending}
                            className="h-7 px-2 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                          >
                            {purgePosterCacheMutation.isPending && purgingType === type ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap justify-center items-center gap-2 mt-3 pt-3 border-t">
                  {/* Refresh one image — a stale URL should not require wiping a whole class. */}
                  {posterCacheStatsQuery.data.by_type && (
                    <Dialog open={refreshImageOpen} onOpenChange={setRefreshImageOpen}>
                      <DialogTrigger asChild>
                        <Button variant="outline" size="sm">
                          <RefreshCw className="h-4 w-4 mr-1.5" />
                          Refresh an image…
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Refresh a cached image</DialogTitle>
                          <DialogDescription>
                            Drops one image from the cache so it is re-fetched on the next
                            request. Accepts the upstream URL or a <code>/poster-cache/</code> URL.
                          </DialogDescription>
                        </DialogHeader>
                        <Input
                          autoFocus
                          placeholder="Paste an image or /poster-cache/ URL"
                          value={refreshUrl}
                          onChange={(e) => setRefreshUrl(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleRefreshImage(); }}
                          disabled={invalidateImageMutation.isPending}
                        />
                        <DialogFooter>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRefreshImageOpen(false)}
                            disabled={invalidateImageMutation.isPending}
                          >
                            Cancel
                          </Button>
                          <Button
                            onClick={handleRefreshImage}
                            variant="outline"
                            size="sm"
                            disabled={!refreshUrl.trim() || invalidateImageMutation.isPending}
                          >
                            {invalidateImageMutation.isPending ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              "Refresh"
                            )}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  )}
                  {posterCacheStatsQuery.data.by_type && (
                    <Dialog open={clearArtOpen} onOpenChange={(open) => {
                      setClearArtOpen(open);
                      if (!open) { setClearArtId(""); setClearArtResult(null); }
                    }}>
                      <DialogTrigger asChild>
                        <Button variant="outline" size="sm">
                          <Image className="h-4 w-4 mr-1.5" />
                          Clear art by ID…
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Clear cached art for a title</DialogTitle>
                          <DialogDescription>
                            Finds cached art whose URL carries the ID and drops it. Providers
                            that serve content-hash filenames — TMDB, TVDB, MAL, fanart —
                            cannot be matched this way and are left alone.
                          </DialogDescription>
                        </DialogHeader>
                        <Input
                          autoFocus
                          placeholder="tt1234567, tmdb:278, tvdb:81189"
                          value={clearArtId}
                          onChange={(e) => { setClearArtId(e.target.value); setClearArtResult(null); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleClearArtById(); }}
                          disabled={clearArtByIdMutation.isPending}
                        />
                        {clearArtId.trim() && !looksLikeMediaId(clearArtId) && !clearArtResult && (
                          <p className="text-xs text-amber-400/80">
                            That does not look like a media ID — expected something like
                            <code className="mx-1">tt1234567</code> or <code>tmdb:278</code>.
                          </p>
                        )}
                        {clearArtByIdMutation.isPending && (
                          <p className="text-xs text-muted-foreground">
                            Reading stored image URLs — the first search after a restart takes a moment.
                          </p>
                        )}
                        {clearArtResult && (
                          <div className="rounded-lg border p-3 space-y-2 text-xs">
                            {clearArtResult.removed > 0 ? (
                              <div>
                                <span className="font-medium">
                                  Cleared {clearArtResult.removed} image{clearArtResult.removed !== 1 ? 's' : ''}
                                </span>
                                <span className="text-muted-foreground">
                                  {' '}({formatSize(clearArtResult.freed_bytes)})
                                </span>
                                <div className="mt-1 flex flex-wrap gap-x-3 text-muted-foreground tabular-nums">
                                  {Object.entries(clearArtResult.clearedByClass).map(([cls, n]) => (
                                    <span key={cls}>{n} {IMAGE_TYPE_LABELS[cls] || cls}</span>
                                  ))}
                                </div>
                              </div>
                            ) : (
                              <div className="text-muted-foreground">
                                No cached art carries that ID in its URL.
                              </div>
                            )}
                            {clearArtResult.searchability.unsearchable > 0 && (
                              <div className="pt-2 border-t text-muted-foreground">
                                <span className="text-amber-400/80">
                                  {clearArtResult.searchability.unsearchable} of{' '}
                                  {clearArtResult.searchability.total} cached images could not be searched
                                </span>
                                <div className="mt-1 flex flex-wrap gap-x-3 tabular-nums">
                                  {Object.entries(clearArtResult.searchability.unsearchableByClass).map(([cls, n]) => (
                                    <span key={cls}>{n} {IMAGE_TYPE_LABELS[cls] || cls}</span>
                                  ))}
                                </div>
                                <p className="mt-1">
                                  Their URLs are content hashes with no ID in them. Use
                                  {' '}<em>Refresh an image…</em> with the URL, or clear the whole type.
                                </p>
                              </div>
                            )}
                          </div>
                        )}
                        <DialogFooter>
                          <Button variant="ghost" size="sm" onClick={() => setClearArtOpen(false)}
                            disabled={clearArtByIdMutation.isPending}>
                            Close
                          </Button>
                          <Button onClick={handleClearArtById} variant="outline" size="sm"
                            disabled={!clearArtId.trim() || clearArtByIdMutation.isPending}>
                            {clearArtByIdMutation.isPending ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : "Clear"}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  )}
                  {/* Per-provider policies. Offered whenever they decide something:
                      for the built-in cache, and for the headers on art we merely
                      pass through. */}
                  {(posterCacheStatsQuery.data.by_type || posterProxyMode) && (
                    <Button variant="outline" size="sm" onClick={() => setPolicyDialogOpen(true)}>
                      <Sliders className="h-4 w-4 mr-1.5" />
                      Advanced…
                    </Button>
                  )}
                  {/* Gated on there being something to clear, not on which store it
                      is: with the built-in cache off the purge endpoint forwards to
                      the external proxy, so this still works there. */}
                  {posterHasFigures && (
                    <Button
                      onClick={() => handlePurgePosterCache()}
                      variant="outline"
                      size="sm"
                      disabled={purgePosterCacheMutation.isPending}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                    >
                      {purgePosterCacheMutation.isPending && purgingType === "all" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <>
                          <Trash2 className="h-4 w-4 mr-1.5" />
                          Clear All Images
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Image cache not configured or unreachable.</p>
            )}
          </CardContent>
          <ImageCachePolicyDialog open={policyDialogOpen} onOpenChange={setPolicyDialogOpen} />
        </Card>
      )}

      {coldStoreStatsQuery.data && (
        <Card className={posterCacheStatsQuery.data === undefined ? "xl:col-span-2" : undefined}>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <HardDrive className="h-5 w-5" />
              <CardTitle>Meta Cold Store</CardTitle>
              <Badge variant="outline" className="ml-auto font-normal">On-disk</Badge>
              {!coldStoreStatsQuery.data.configured && (
                <Badge variant="outline">Disabled</Badge>
              )}
            </div>
            <CardDescription>
              Disk tier holding metadata that never changes — old films, ended series, finished
              anime. Serves them when Redis evicts, instead of re-fetching from providers.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            {!coldStoreStatsQuery.data.configured ? (
              <p className="text-sm text-muted-foreground">
                Not enabled. Set <code className="text-xs">META_COLD_STORE_ENABLED=true</code> and
                restart to persist stable metadata on disk.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Titles</span>
                    <p className="text-lg font-semibold"><AnimatedNumber value={coldStoreStatsQuery.data.titles} /></p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Components</span>
                    <p className="text-lg font-semibold"><AnimatedNumber value={coldStoreStatsQuery.data.rows} /></p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Disk Usage</span>
                    <p className="text-lg font-semibold">{formatSize(coldStoreStatsQuery.data.bytes)}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground" title="Lookups served from disk vs. fell through to the provider">
                      Hits / Misses
                    </span>
                    <p className="text-lg font-semibold">
                      <AnimatedNumber value={coldStoreStatsQuery.data.hits} />
                      <span className="text-muted-foreground font-normal"> / </span>
                      <AnimatedNumber value={coldStoreStatsQuery.data.misses} />
                    </p>
                  </div>
                </div>

                {/* Disk budget against META_COLD_STORE_MAX_BYTES; LRU eviction kicks in at the cap. */}
                {coldStoreStatsQuery.data.maxBytes > 0 && (
                  <div className="mt-4">
                    <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
                      <span>Disk budget</span>
                      <span className="tabular-nums">
                        {formatSize(coldStoreStatsQuery.data.bytes)} / {formatSize(coldStoreStatsQuery.data.maxBytes)}
                      </span>
                    </div>
                    <Progress
                      value={Math.min(100, (coldStoreStatsQuery.data.bytes / coldStoreStatsQuery.data.maxBytes) * 100)}
                    />
                  </div>
                )}

                {coldStoreStatsQuery.data.tiers.length > 0 && (
                  <div className="mt-4 pt-3 border-t space-y-1">
                    {coldStoreStatsQuery.data.tiers.map((tier) => (
                      <div key={tier.tier} className="flex items-center justify-between gap-3 text-sm py-1">
                        <span className="font-medium" title={COLD_TIER_HINTS[tier.tier] || undefined}>
                          {COLD_TIER_LABELS[tier.tier] || tier.tier}
                        </span>
                        <span className="text-muted-foreground tabular-nums">
                          {tier.titles.toLocaleString()} titles · {tier.count.toLocaleString()} components · {formatSize(tier.bytes)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="mt-4 pt-3 border-t grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground text-xs">Components served</span>
                    <p className="font-semibold tabular-nums">{coldStoreStatsQuery.data.componentsServed.toLocaleString()}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground text-xs">Oldest entry</span>
                    <p className="font-semibold tabular-nums">{formatAge(coldStoreStatsQuery.data.oldestCreatedAt)}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground text-xs" title="Rows past their TTL, cleared on the next sweep">
                      Expired rows
                    </span>
                    <p className="font-semibold tabular-nums">{coldStoreStatsQuery.data.expiredRows.toLocaleString()}</p>
                  </div>
                </div>

                <div className="flex justify-center mt-3 pt-3 border-t">
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {/* Drop one title — a bad or revived entry should not require wiping the store. */}
                    <Dialog open={dropTitleOpen} onOpenChange={setDropTitleOpen}>
                      <DialogTrigger asChild>
                        <Button variant="outline" size="sm">
                          <Trash2 className="h-4 w-4 mr-1.5" />
                          Drop a title…
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Drop a single title</DialogTitle>
                          <DialogDescription>
                            Removes every cold-store component for one title so it is re-fetched
                            and re-classified on the next request. Use this for a bad or revived
                            entry instead of clearing the whole store.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-3">
                          <Input
                            autoFocus
                            placeholder="Meta ID, e.g. tt0903747 or kitsu:1"
                            value={coldStoreMetaId}
                            onChange={(e) => setColdStoreMetaId(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && coldStoreMetaId.trim()) handlePurgeColdStore(coldStoreMetaId.trim());
                            }}
                            disabled={purgeColdStoreMutation.isPending}
                          />
                          <div className="flex items-center justify-between gap-3 rounded-md border p-2.5">
                            <div className="space-y-0.5">
                              <Label htmlFor="drop-title-redis" className="text-sm">Clear on Redis too</Label>
                              <p className="text-xs text-muted-foreground">
                                Also drop the title's Redis entries. Without this the hot cache
                                keeps serving it until its TTL expires.
                              </p>
                            </div>
                            <Switch
                              id="drop-title-redis"
                              checked={dropTitleIncludeRedis}
                              onCheckedChange={setDropTitleIncludeRedis}
                              disabled={purgeColdStoreMutation.isPending}
                            />
                          </div>
                        </div>
                        <DialogFooter>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDropTitleOpen(false)}
                            disabled={purgeColdStoreMutation.isPending}
                          >
                            Cancel
                          </Button>
                          <Button
                            onClick={() => handlePurgeColdStore(coldStoreMetaId.trim())}
                            variant="outline"
                            size="sm"
                            disabled={!coldStoreMetaId.trim() || purgeColdStoreMutation.isPending}
                            className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                          >
                            {purgeColdStoreMutation.isPending && coldPurgingScope === "title" ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <>
                                <Trash2 className="h-4 w-4 mr-1.5" />
                                Drop
                              </>
                            )}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                    <Button
                      onClick={handleSweepColdStore}
                      variant="outline"
                      size="sm"
                      disabled={sweepColdStoreMutation.isPending}
                      title="Drop expired and inactive rows now instead of waiting for the hourly sweep"
                    >
                      {sweepColdStoreMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <>
                          <Clock className="h-4 w-4 mr-1.5" />
                          Sweep Now
                        </>
                      )}
                    </Button>
                    <Button
                      onClick={() => handlePurgeColdStore()}
                      variant="outline"
                      size="sm"
                      disabled={purgeColdStoreMutation.isPending}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                    >
                      {purgeColdStoreMutation.isPending && coldPurgingScope === "all" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <>
                          <Trash2 className="h-4 w-4 mr-1.5" />
                          Clear Cold Store
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
      </div>

      {/* Error Management */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3 gap-3">
          <div className="min-w-0">
            <CardTitle>Error Management</CardTitle>
            <CardDescription>Recent errors and warnings from the system</CardDescription>
          </div>
          {errorLogs.length > 0 && (
            <div className="flex items-center gap-3 shrink-0">
              <div className="hidden sm:flex items-center gap-3 text-sm tabular-nums">
                {errorCounts.error > 0 && (
                  <span className="flex items-center gap-1.5" title="Errors">
                    <span className="w-2 h-2 rounded-full bg-red-500" />{errorCounts.error}
                  </span>
                )}
                {errorCounts.warning > 0 && (
                  <span className="flex items-center gap-1.5" title="Warnings">
                    <span className="w-2 h-2 rounded-full bg-yellow-500" />{errorCounts.warning}
                  </span>
                )}
                {errorCounts.info > 0 && (
                  <span className="flex items-center gap-1.5" title="Info">
                    <span className="w-2 h-2 rounded-full bg-blue-500" />{errorCounts.info}
                  </span>
                )}
              </div>
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
            </div>
          )}
        </CardHeader>
        <CardContent className="pt-0">
          {errorLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="w-12 h-12 rounded-full bg-green-500/10 flex items-center justify-center mb-3">
                <Shield className="w-6 h-6 text-green-500" />
              </div>
              <p className="text-sm font-medium text-muted-foreground">No errors recorded</p>
              <p className="text-xs text-muted-foreground mt-1">System is running smoothly</p>
            </div>
          ) : (
            <div className="max-h-[320px] overflow-y-auto rounded-lg border divide-y">
              {errorLogs.map((error: any) => {
                const expanded = expandedErrors.has(error.id);
                const dot =
                  error.level === "error"
                    ? "bg-red-500"
                    : error.level === "warning"
                      ? "bg-yellow-500"
                      : "bg-blue-500";
                const hasDetails = error.details && Object.keys(error.details).length > 0;
                return (
                  <div key={error.id}>
                    <button
                      type="button"
                      onClick={() => toggleErrorDetails(error.id)}
                      className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
                    >
                      <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
                      <span className="flex-1 min-w-0 truncate text-sm font-medium">{error.message}</span>
                      {error.count > 1 && (
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">×{error.count}</span>
                      )}
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums text-right w-[4.5rem]">
                        {error.timeAgo || error.timestamp}
                      </span>
                      <ChevronRight
                        className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
                      />
                    </button>
                    {expanded && (
                      <div className="px-3 pb-3 bg-muted/30">
                        {hasDetails ? (
                          <div className="grid gap-1.5 pt-2">
                            {Object.entries(error.details).map(([key, value]: [string, any]) => (
                              <div key={key} className="flex justify-between gap-4 text-sm">
                                <span className="text-muted-foreground capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
                                <span className="font-mono text-xs break-all text-right">{String(value)}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground pt-2">No additional details available</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
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

            {memoryData.v8?.heapLimitMb > 0 && (
              <div className="mb-4">
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-muted-foreground">
                    Heap Used / Heap Limit{memoryData.v8.heapLimitConfigured ? "" : " (V8 default)"}
                  </span>
                  <span className="font-medium">
                    {formatBytes(memoryData.process?.heapUsed)} / {memoryData.v8.heapLimitMb} MB
                  </span>
                </div>
                <Progress
                  value={memoryData.v8.heapUsedPct}
                  className={`h-2 ${
                    memoryData.v8.heapUsedPct > 90
                      ? "[&>div]:bg-red-600"
                      : memoryData.v8.heapUsedPct > 75
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
                    {(task.secondaryActions || []).map((secondary: any) => {
                      const SecondaryIcon = TASK_ACTION_ICONS[secondary.icon] || Image;
                      return (
                        <Button
                          key={secondary.action}
                          size="sm"
                          variant="outline"
                          title={secondary.title}
                          onClick={() => handleMaintenanceTask(task.id, secondary.action)}
                          disabled={task.status === "error" || executingTasks.has(task.id)}
                        >
                          <SecondaryIcon className="h-4 w-4 mr-1" />
                          {secondary.label}
                        </Button>
                      );
                    })}
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
                    {(task.secondaryActions || []).map((secondary: any) => {
                      const SecondaryIcon = TASK_ACTION_ICONS[secondary.icon] || Image;
                      return (
                        <Button
                          key={secondary.action}
                          size="sm"
                          variant="outline"
                          title={secondary.title}
                          onClick={() => handleMaintenanceTask(task.id, secondary.action)}
                          disabled={task.status === "error" || executingTasks.has(task.id)}
                          className="h-7 text-xs mr-2"
                        >
                          <SecondaryIcon className="h-3 w-3" />
                        </Button>
                      );
                    })}
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
                              {task.warmingDetail.totalPinned > 0 && (
                                <span className="text-muted-foreground">
                                  {' · '}<AnimatedNumber value={task.warmingDetail.pinnedWarmed} /> / {task.warmingDetail.totalPinned} collection genres
                                </span>
                              )}
                            </span>
                          </div>
                          <div className="relative h-2 w-full overflow-hidden rounded-full bg-black/20">
                            <div
                              className="h-full rounded-full transition-all duration-700 ease-out bg-gradient-to-r from-blue-500 to-cyan-400"
                              style={{ width: `${(warmedTasks(task.warmingDetail) / totalTasks(task.warmingDetail)) * 100}%` }}
                            />
                          </div>
                        </div>
                      )}

                      {/* Per-UUID live cards */}
                      <div className="grid gap-2">
                        {task.warmingDetail.uuids.map((u: any) => {
                          const total = totalTasks(u);
                          const warmed = warmedTasks(u);
                          const isComplete = total > 0 && warmed >= total;
                          const isActive = !isComplete && total > 0 && warmed < total;
                          const isPending = !isComplete && warmed === 0 && total === 0;
                          const progress = total > 0 ? (warmed / total) * 100 : 0;
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
                                    {u.totalPinned > 0 && <> · <AnimatedNumber value={u.pinnedWarmed || 0} />/{u.totalPinned} genres</>}
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
                                {u.catalogsWarmed}/{u.totalCatalogs} catalogs{u.totalPinned > 0 && <> · {u.pinnedWarmed || 0}/{u.totalPinned} collection genres</>}{u.duration && <> · {u.duration}</>}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null
                )}

                {task.warmingDetail?.images && (() => {
                  const img = task.warmingDetail.images;
                  if (!img.hasData) {
                    return (
                      <div className="mt-3 pt-3 border-t">
                        <div className="rounded-lg p-3 bg-violet-500/5 border border-violet-500/10">
                          <div className="flex items-center gap-2">
                            <div className="w-2.5 h-2.5 rounded-full bg-violet-500/30" />
                            <span className="text-xs text-muted-foreground">
                              No image warming recorded yet — populates on the next run
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  }
                  const showBar = img.outstanding > 0 && img.peakOutstanding > 0;
                  const pct = Math.round((img.drained ?? 1) * 100);
                  return (
                    <div className="mt-3 pt-3 border-t">
                      <div className="rounded-lg p-3 bg-violet-500/10 border border-violet-500/20">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            {img.isActive ? (
                              <div className="relative flex h-2.5 w-2.5">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75" />
                                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-violet-500" />
                              </div>
                            ) : (
                              <div className="w-2.5 h-2.5 rounded-full bg-violet-500/40" />
                            )}
                            <span className="text-xs font-medium">
                              {img.isActive ? 'Warming images' : (img.fromLastRun ? 'Images — last run' : 'Images warmed')}
                            </span>
                          </div>
                          <span className="text-xs tabular-nums">
                            {showBar
                              ? <><AnimatedNumber value={img.outstanding} /> to go</>
                              : <><AnimatedNumber value={img.offered} /> images seen</>}
                          </span>
                        </div>

                        {showBar && (
                          <div className="relative h-2 w-full overflow-hidden rounded-full bg-black/20">
                            <div
                              className="h-full rounded-full transition-all duration-700 ease-out bg-gradient-to-r from-violet-500 to-fuchsia-400"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        )}

                        <div className={`${showBar ? 'mt-2 ' : ''}flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground tabular-nums`}>
                          <span>{img.warmed} fetched</span>
                          <span>{img.skipped} already cached</span>
                          {img.rendered > 0 && <span>{img.rendered} rendered</span>}
                          {img.alreadyFresh > 0 && <span>{img.alreadyFresh} still fresh</span>}
                          {img.outstanding > 0 && (
                            <span className={img.fromLastRun ? 'text-amber-400/80' : 'text-violet-300'}>
                              {img.outstanding} {img.fromLastRun ? 'left unwarmed' : 'pending'}
                            </span>
                          )}
                          {img.failed > 0 && (
                            <span className="text-amber-400/80" title={
                              img.failures && Object.keys(img.failures).length > 0
                                ? Object.entries(img.failures).map(([r, n]) => `${n} ${r}`).join(', ')
                                : undefined
                            }>
                              {img.failed} failed
                              {img.failures && Object.keys(img.failures).length > 0 && (
                                <> ({Object.entries(img.failures)
                                  .sort((a: any, b: any) => b[1] - a[1])
                                  .slice(0, 2)
                                  .map(([r, n]) => `${n} ${r}`)
                                  .join(', ')})</>
                              )}
                            </span>
                          )}
                          {img.dropped > 0 && <span className="text-amber-400/80">{img.dropped} dropped</span>}
                          {img.atCapacity > 0 && <span className="text-red-400/80">{img.atCapacity} over capacity</span>}
                        </div>

                        {img.isActive && (
                          <div className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                            {img.concurrency} in flight · {img.lagMs}ms loop lag
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
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
