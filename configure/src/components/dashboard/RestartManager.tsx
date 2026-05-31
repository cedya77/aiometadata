import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useRestartServer } from "@/hooks/useDashboardQueries";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 90000;
const FORCE_RELOAD_MS = 20000;

export function RestartManager({
  pendingLabels,
  canRestart,
}: {
  pendingLabels: string[];
  canRestart?: boolean;
}) {
  const restartMutation = useRestartServer();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  const count = pendingLabels.length;

  useEffect(() => {
    if (!restarting) return;
    let cancelled = false;
    let sawDown = false;
    const start = Date.now();

    async function ping(): Promise<boolean> {
      try {
        const r = await fetch("/api/dashboard/health", { cache: "no-store" });
        return r.ok;
      } catch {
        return false;
      }
    }

    const interval = setInterval(async () => {
      if (cancelled) return;
      if (Date.now() - start > POLL_TIMEOUT_MS) {
        setTimedOut(true);
        clearInterval(interval);
        return;
      }
      const ok = await ping();
      if (!ok) {
        sawDown = true;
        return;
      }
      if (sawDown || Date.now() - start > FORCE_RELOAD_MS) {
        clearInterval(interval);
        window.location.reload();
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [restarting]);

  async function handleRestart() {
    setConfirmOpen(false);
    try {
      await restartMutation.mutateAsync();
      setRestarting(true);
    } catch (err: any) {
      toast.error(err.message || "Failed to trigger restart");
    }
  }

  if (count === 0 && !restarting) return null;

  return (
    <>
      {count > 0 && !restarting && (
        <div className="sticky top-0 z-30 flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border border-orange-500/30 bg-orange-500/15 px-4 py-3 shadow-sm backdrop-blur-md">
          <div className="flex items-start gap-2.5 flex-1 min-w-0">
            <RefreshCw className="h-4 w-4 mt-0.5 shrink-0 text-orange-400" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-orange-200">
                {count} change{count > 1 ? "s" : ""} need{count > 1 ? "" : "s"} a restart to take effect
              </p>
              <p className="text-xs text-orange-200/70 truncate">{pendingLabels.join(", ")}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {canRestart ? (
              <Button
                size="sm"
                variant="outline"
                className="border-orange-500/40 bg-orange-500/10 hover:bg-orange-500/20 text-orange-100"
                onClick={() => setConfirmOpen(true)}
              >
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                Restart now
              </Button>
            ) : (
              <span className="text-xs text-orange-200/70">Restart the container to apply</span>
            )}
          </div>
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart the server?</AlertDialogTitle>
            <AlertDialogDescription>
              The addon will be briefly unavailable while it restarts. Active requests will be interrupted and the
              dashboard will reconnect automatically once it's back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRestart}>Restart now</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {restarting && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 text-center px-6">
            {timedOut ? (
              <>
                <RefreshCw className="h-8 w-8 text-orange-400" />
                <div className="space-y-1">
                  <p className="font-medium">Still restarting…</p>
                  <p className="text-sm text-muted-foreground max-w-sm">
                    This is taking longer than expected. The server may still be coming back up.
                  </p>
                </div>
                <Button variant="outline" onClick={() => window.location.reload()}>
                  Reload now
                </Button>
              </>
            ) : (
              <>
                <Loader2 className="h-8 w-8 animate-spin text-orange-400" />
                <div className="space-y-1">
                  <p className="font-medium">Restarting server…</p>
                  <p className="text-sm text-muted-foreground">Reconnecting automatically once it's back online.</p>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
