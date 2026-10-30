import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BookOpen, Check, Download, FileUp, Film, Loader2, Tv } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DASHBOARD_QUERY_KEYS, useJellyfinHistoryImport, useJellyfinHistoryImportJob, type HistoryImportJob, type HistoryImportPreview, type HistoryImportSection } from "@/hooks/useDashboardQueries";
import { STREMIO_FILE_NAME } from "@/lib/stremioAccount";
import StremioImport from "./StremioImport";
import HistoryImportGuide from "./HistoryImportGuide";

const SECTION_LABELS: Array<[HistoryImportSection, string]> = [
  ["playstate", "Watched and in progress"],
  ["watches", "Dated viewings"],
  ["ratings", "Ratings"],
  ["watchlist", "Watchlist"],
  ["dropped", "Dropped shows"],
  ["matches", "Tracker matches"],
];

const SKIP = "__skip__";

const skipKey = (source: string) => `history-import-skip:${source}`;

function rememberedSkip(source: string): HistoryImportSection[] {
  try {
    const held = JSON.parse(localStorage.getItem(skipKey(source)) ?? "[]");
    return Array.isArray(held) ? SECTION_LABELS.map(([key]) => key).filter((key) => held.includes(key)) : [];
  } catch {
    return [];
  }
}

function rememberSkip(source: string, skipped: HistoryImportSection[]): void {
  try {
    localStorage.setItem(skipKey(source), JSON.stringify(skipped));
  } catch {
    return;
  }
}

const progressOf = (job: HistoryImportJob) => `${job.done.toLocaleString()} of ${job.total.toLocaleString()}`;

const fromStremio = (fileName: string | null | undefined) => fileName === STREMIO_FILE_NAME;

const sourceName = (fileName: string | null | undefined) => (fromStremio(fileName) ? "Stremio" : fileName);

function stoppedText(job: HistoryImportJob): string {
  const how = job.status === "interrupted" ? "was interrupted" : "stopped";
  const error = job.error ? `: ${job.error}` : "";
  if (fromStremio(job.fileName)) return `The import from Stremio ${how} after ${progressOf(job)} changes${error}. Import from Stremio again to finish it.`;
  const file = job.fileName ? `The import of ${job.fileName}` : "The last import";
  return `${file} ${how} after ${progressOf(job)} changes${error}. Import the same file again to finish it.`;
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
  const [matching, setMatching] = useState<{ done: number; total: number; label: string } | null>(null);
  const [picks, setPicks] = useState<Record<string, number>>({});
  const [skipped, setSkipped] = useState<HistoryImportSection[]>([]);
  const [stremioOpen, setStremioOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const watching = useRef<string | null>(null);
  const reading = useRef<AbortController | null>(null);

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
    reading.current?.abort();
    setFile(null);
    setPreview(null);
    setStarted(false);
  };

  const load = async (picked: File, map: Record<string, string | null> | null, chosen: Record<string, number>) => {
    // Only the latest read may set the preview: an earlier file still matching would otherwise replace it.
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    setLoading(true);
    try {
      const result = await send(userUUID, picked, map, chosen, false, setMatching, [], controller.signal);
      if (controller.signal.aborted) return;
      if (!map) setSkipped(rememberedSkip(result.source));
      setPreview(result);
      setMapping(result.mapping);
    } catch (error) {
      if (controller.signal.aborted) return;
      toast.error(error instanceof Error ? error.message : "Could not read the file");
      if (!map) setFile(null);
    } finally {
      if (reading.current === controller) {
        reading.current = null;
        setLoading(false);
        setMatching(null);
      }
    }
  };

  const pick = (picked: File | undefined) => {
    if (input.current) input.current.value = "";
    if (!picked) return;
    setFile(picked);
    setPreview(null);
    setStarted(false);
    setPicks({});
    void load(picked, null, {});
  };

  const choose = (source: string, target: string) => {
    if (!file) return;
    const next = { ...mapping, [source]: target === SKIP ? null : target };
    setMapping(next);
    void load(file, next, picks);
  };

  const choosePick = (key: string, tmdb: number | null) => {
    if (!file) return;
    const next = { ...picks };
    if (tmdb) next[key] = tmdb;
    else delete next[key];
    setPicks(next);
    void load(file, mapping, next);
  };

  const start = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const result = await send(userUUID, file, mapping, picks, true, setMatching, skipped);
      if (result.job) queryClient.setQueryData([...DASHBOARD_QUERY_KEYS.jellyfin, "import", userUUID], result.job);
      setStarted(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Import failed");
    } finally {
      setLoading(false);
      setMatching(null);
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

  const toggle = (section: HistoryImportSection) => {
    if (!preview) return;
    const next = skipped.includes(section) ? skipped.filter((key) => key !== section) : [...skipped, section];
    setSkipped(next);
    rememberSkip(preview.source, next);
  };

  const total = preview ? SECTION_LABELS.filter(([key]) => !skipped.includes(key)).reduce((sum, [key]) => sum + preview.counts[key].added + preview.counts[key].updated, 0) : 0;
  const picker = <input ref={input} type="file" accept="application/json,application/zip,text/csv,.json,.zip,.csv" className="hidden" onChange={(event) => pick(event.target.files?.[0])} />;

  const trigger = notice ? (
    job && job.status !== "done" && !(running && file) ? (
      <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-white/[0.06] px-4 py-2.5 text-xs sm:px-6 ${running ? "text-muted-foreground" : "bg-amber-500/[0.06] text-amber-200"}`}>
        {running ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <AlertTriangle className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-[1_1_16rem] [overflow-wrap:anywhere]">{running ? `Importing watch history${job.fileName ? ` from ${sourceName(job.fileName)}` : ""}: ${progressOf(job)}` : stoppedText(job)}</span>
        {!running && (
          <span className="ml-auto flex items-center gap-1">
            {fromStremio(job.fileName) ? (
              <Button size="sm" variant="ghost" className="glass h-7 gap-1 rounded-full px-3 text-xs" onClick={() => setStremioOpen(true)}>
                <Tv className="h-3.5 w-3.5" /> Import from Stremio
              </Button>
            ) : (
              <Button size="sm" variant="ghost" className="glass h-7 gap-1 rounded-full px-3 text-xs" onClick={() => input.current?.click()}>
                <Download className="h-3.5 w-3.5" /> Import file
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-7 rounded-full px-3 text-xs text-muted-foreground" onClick={() => void clear()}>Dismiss</Button>
          </span>
        )}
      </div>
    ) : null
  ) : (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="glass h-8 gap-1 rounded-full px-3" disabled={running} title="Import watch history">
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Import
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56" onCloseAutoFocus={(event) => event.preventDefault()}>
        <DropdownMenuItem onSelect={() => input.current?.click()}><FileUp className="size-4" /> From an export file</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setStremioOpen(true)}><Tv className="size-4" /> From a Stremio account</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setGuideOpen(true)}><BookOpen className="size-4" /> Format for other apps</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      {picker}
      {trigger}
      <HistoryImportGuide open={guideOpen} onOpenChange={setGuideOpen} />
      <StremioImport open={stremioOpen} onOpenChange={setStremioOpen} onLibrary={(library) => { setStremioOpen(false); pick(library); }} />
      <Dialog open={Boolean(file)} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import watch history</DialogTitle>
            <DialogDescription className="[overflow-wrap:anywhere]">
              {sourceName(file?.name)}.{preview ? ` ${preview.about}` : ""}
            </DialogDescription>
          </DialogHeader>

          {!preview ? (
            matching ? (
              <div className="space-y-2 py-6">
                <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {matching.label}: {matching.done.toLocaleString()} of {matching.total.toLocaleString()}</p>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-blue-500 transition-[width] duration-500" style={{ width: `${matching.total ? (matching.done / matching.total) * 100 : 0}%` }} />
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading the file</div>
            )
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
                    {SECTION_LABELS.map(([key, label]) => {
                      const counts = preview.counts[key];
                      const empty = counts.added + counts.updated + counts.unchanged === 0;
                      const off = skipped.includes(key);
                      return (
                        <tr key={key} className={`transition-opacity ${off || empty ? "opacity-45" : ""}`}>
                          <td className="px-3 py-2">
                            <label className={`flex items-center gap-2.5 ${empty || started ? "" : "cursor-pointer"}`}>
                              <input
                                type="checkbox"
                                checked={!off && !empty}
                                disabled={empty || started}
                                onChange={() => toggle(key)}
                                className="size-4 shrink-0 cursor-pointer rounded accent-blue-500 disabled:cursor-default"
                              />
                              <span className={off ? "line-through decoration-white/30" : ""}>{label}</span>
                            </label>
                          </td>
                          <td className="px-3 py-2 text-right">{counts.added.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right">{counts.updated.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right text-muted-foreground">{counts.unchanged.toLocaleString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {Boolean(preview.ambiguous?.length) && (
                <div className="space-y-3 rounded-xl bg-white/[0.03] p-3 ring-1 ring-inset ring-white/10">
                  <p className="text-xs text-muted-foreground">
                    {preview.ambiguous!.length === 1 ? "This title shares its name and year with another title." : `${preview.ambiguous!.length} titles share their name and year with another title.`} Pick the one you watched, or it is left out.
                  </p>
                  {preview.ambiguous!.map((item) => (
                    <div key={item.key} className="space-y-1.5">
                      <p className="text-sm font-medium [overflow-wrap:anywhere]">{item.name}</p>
                      <div className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1">
                        {item.options.map((option) => {
                          const on = (picks[item.key] ?? item.picked) === option.tmdb;
                          return (
                            <button
                              type="button"
                              key={option.tmdb}
                              aria-pressed={on}
                              disabled={loading || started}
                              onClick={() => choosePick(item.key, on ? null : option.tmdb)}
                              className={`relative flex w-64 shrink-0 snap-start gap-2.5 rounded-lg p-2 text-left ring-1 ring-inset transition disabled:opacity-60 ${on ? "bg-blue-500/15 ring-blue-500" : "bg-white/[0.04] ring-white/10 hover:ring-white/25"}`}
                            >
                              {option.poster ? (
                                <img src={option.poster} alt="" loading="lazy" className="h-[84px] w-14 shrink-0 rounded object-cover" />
                              ) : (
                                <span className="flex h-[84px] w-14 shrink-0 items-center justify-center rounded bg-white/[0.06] text-muted-foreground"><Film className="size-4" /></span>
                              )}
                              <span className="min-w-0 flex-1 space-y-0.5">
                                <span className="block truncate pr-5 text-xs font-medium">{option.title}</span>
                                <span className="block truncate text-[11px] text-muted-foreground">{[option.year ?? "Year unknown", option.originalTitle].filter(Boolean).join(" · ")}</span>
                                <span className="line-clamp-3 text-[11px] leading-snug text-muted-foreground">{option.overview || "No description on TMDB."}</span>
                              </span>
                              {on && <Check className="absolute right-2 top-2 size-3.5 text-blue-400" />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {preview.unmatchedCount > 0 && (
                <details className="rounded-xl bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200 ring-1 ring-inset ring-amber-500/20">
                  <summary className="cursor-pointer select-none">
                    {preview.unmatchedCount.toLocaleString()} {preview.unmatchedCount === 1 ? "title" : "titles"} could not be matched and will be left out
                  </summary>
                  <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto pr-1 text-muted-foreground">
                    {preview.unmatched.map((item, index) => (
                      <li key={`${item.name}-${index}`} className="flex flex-wrap justify-between gap-x-3 [overflow-wrap:anywhere]">
                        <span className="text-foreground/80">{item.name}</span>
                        <span>{item.reason}</span>
                      </li>
                    ))}
                    {preview.unmatchedCount > preview.unmatched.length && (
                      <li>and {(preview.unmatchedCount - preview.unmatched.length).toLocaleString()} more</li>
                    )}
                  </ul>
                </details>
              )}

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
