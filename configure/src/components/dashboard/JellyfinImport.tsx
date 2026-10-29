import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DASHBOARD_QUERY_KEYS, useJellyfinHistoryImport, useJellyfinHistoryImportJob, type HistoryImportJob, type HistoryImportPreview, type HistoryImportSection } from "@/hooks/useDashboardQueries";

const SECTION_LABELS: Array<[HistoryImportSection, string]> = [
  ["playstate", "Watched and in progress"],
  ["watches", "Dated viewings"],
  ["ratings", "Ratings"],
  ["watchlist", "Watchlist"],
  ["dropped", "Dropped shows"],
  ["matches", "Tracker matches"],
];

const SKIP = "__skip__";

const progressOf = (job: HistoryImportJob) => `${job.done.toLocaleString()} of ${job.total.toLocaleString()}`;

function stoppedText(job: HistoryImportJob): string {
  const file = job.fileName ? `The import of ${job.fileName}` : "The last import";
  const how = job.status === "interrupted" ? "was interrupted" : "stopped";
  return `${file} ${how} after ${progressOf(job)} changes${job.error ? `: ${job.error}` : ""}. Import the same file again to finish it.`;
}

export default function JellyfinImport({ userUUID, notice = false }: { userUUID: string; notice?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const { send, dismiss } = useJellyfinHistoryImport();
  const { data: job } = useJellyfinHistoryImportJob(userUUID);
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<HistoryImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(false);
  const [started, setStarted] = useState(false);
  const watching = useRef<string | null>(null);

  const running = job?.status === "running";
  const shown = started ? job ?? null : null;

  useEffect(() => {
    if (!job) return;
    const key = job.startedAt ?? "";
    if (job.status === "running") {
      watching.current = key;
      return;
    }
    if (watching.current !== key) return;
    watching.current = null;
    if (!notice) {
      if (job.status === "done") toast.success("History imported");
      else toast.error(stoppedText(job));
    }
    void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "dashboard" && q.queryKey[1] === "jellyfin" && q.queryKey[2] !== "import" });
  }, [job, notice, queryClient]);

  const close = () => {
    if (shown?.status === "running") return;
    setFile(null);
    setPreview(null);
    setStarted(false);
  };

  const load = async (picked: File, map: Record<string, string | null> | null) => {
    setLoading(true);
    try {
      const result = await send(userUUID, picked, map, false);
      setPreview(result);
      setMapping(result.mapping);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read the file");
      if (!map) setFile(null);
    } finally {
      setLoading(false);
    }
  };

  const pick = (picked: File | undefined) => {
    if (input.current) input.current.value = "";
    if (!picked) return;
    setFile(picked);
    setPreview(null);
    setStarted(false);
    void load(picked, null);
  };

  const choose = (source: string, target: string) => {
    if (!file) return;
    const next = { ...mapping, [source]: target === SKIP ? null : target };
    setMapping(next);
    void load(file, next);
  };

  const start = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const result = await send(userUUID, file, mapping, true);
      if (result.job) queryClient.setQueryData([...DASHBOARD_QUERY_KEYS.jellyfin, "import", userUUID], result.job);
      setStarted(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Import failed");
    } finally {
      setLoading(false);
    }
  };

  const clear = async () => {
    try {
      await dismiss(userUUID);
      queryClient.setQueryData([...DASHBOARD_QUERY_KEYS.jellyfin, "import", userUUID], null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not clear the import");
    }
  };

  const total = preview ? SECTION_LABELS.reduce((sum, [key]) => sum + preview.counts[key].added + preview.counts[key].updated, 0) : 0;
  const picker = <input ref={input} type="file" accept="application/json,.json" className="hidden" onChange={(event) => pick(event.target.files?.[0])} />;

  const trigger = notice ? (
    job && job.status !== "done" && !(running && file) ? (
      <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-white/[0.06] px-4 py-2.5 text-xs sm:px-6 ${running ? "text-muted-foreground" : "bg-amber-500/[0.06] text-amber-200"}`}>
        {running ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <AlertTriangle className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-[1_1_16rem] [overflow-wrap:anywhere]">{running ? `Importing watch history${job.fileName ? ` from ${job.fileName}` : ""}: ${progressOf(job)}` : stoppedText(job)}</span>
        {!running && (
          <span className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" className="glass h-7 gap-1 rounded-full px-3 text-xs" onClick={() => input.current?.click()}>
              <Download className="h-3.5 w-3.5" /> Import file
            </Button>
            <Button size="sm" variant="ghost" className="h-7 rounded-full px-3 text-xs text-muted-foreground" onClick={() => void clear()}>Dismiss</Button>
          </span>
        )}
      </div>
    ) : null
  ) : (
    <Button size="sm" variant="ghost" className="glass h-8 gap-1 rounded-full px-3" onClick={() => input.current?.click()} disabled={running}>
      {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Import
    </Button>
  );

  return (
    <>
      {picker}
      {trigger}
      <Dialog open={Boolean(file)} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import watch history</DialogTitle>
            <DialogDescription>
              {file?.name}. Nothing already here is lost: the newer state of each title wins, and a viewing already in the history is not added twice. Nothing is sent to the trackers; what they lack shows up in the Trackers section.
            </DialogDescription>
          </DialogHeader>

          {!preview ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading the file</div>
          ) : (
            <div className="space-y-5">
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Users</p>
                {preview.sources.map((source) => (
                  <label key={source.key} className="flex items-center gap-3 text-sm">
                    <span className="min-w-0 flex-1 truncate">{source.name}</span>
                    <span className="text-muted-foreground">into</span>
                    <select
                      value={mapping[source.key] ?? SKIP}
                      disabled={loading || started}
                      onChange={(event) => choose(source.key, event.target.value)}
                      className="h-8 rounded-full bg-white/[0.06] px-3 text-sm ring-1 ring-inset ring-white/10"
                    >
                      {preview.targets.map((target) => <option key={target.key} value={target.key}>{target.name}</option>)}
                      <option value={SKIP}>Don't import</option>
                    </select>
                  </label>
                ))}
              </div>

              <div className="overflow-hidden rounded-xl ring-1 ring-inset ring-white/10">
                <table className={`w-full text-sm transition-opacity ${loading ? "opacity-60" : ""}`}>
                  <thead className="bg-white/[0.04] text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium" />
                      <th className="px-3 py-2 text-right font-medium">New</th>
                      <th className="px-3 py-2 text-right font-medium">Updated</th>
                      <th className="px-3 py-2 text-right font-medium">Already here</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06] tabular-nums">
                    {SECTION_LABELS.map(([key, label]) => (
                      <tr key={key}>
                        <td className="px-3 py-2">{label}</td>
                        <td className="px-3 py-2 text-right">{preview.counts[key].added.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right">{preview.counts[key].updated.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{preview.counts[key].unchanged.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {!started && running && (
                <p className="text-xs text-amber-200">Another import into this configuration is running. Wait for it to finish first.</p>
              )}

              {shown && (
                <div className="space-y-1.5">
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-blue-500 transition-[width] duration-500" style={{ width: `${shown.total ? (shown.done / shown.total) * 100 : 100}%` }} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {shown.status === "running" ? `Importing ${progressOf(shown)}` : shown.status === "done" ? "Done." : stoppedText(shown)}
                  </p>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button type="button" onClick={close} disabled={shown?.status === "running"} className="h-9 rounded-full px-4 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50">
                  {shown && shown.status !== "running" ? "Close" : "Cancel"}
                </button>
                {!started && (
                  <button type="button" onClick={() => void start()} disabled={loading || running || total === 0} className="flex h-9 items-center gap-2 rounded-full bg-blue-500/90 px-4 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50">
                    {loading && <Loader2 className="size-3.5 animate-spin" />} {total === 0 ? "Nothing to import" : "Import"}
                  </button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
