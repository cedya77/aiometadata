import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
import {
  ScrollText,
  Search,
  ArrowDownToLine,
  ArrowDown,
  X,
  Loader2,
  Filter,
  Copy,
  Download,
  Trash2,
  Pause,
  Play,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import type { LogsData, LogEntry } from "@/hooks/useDashboardQueries";

interface DashboardLogsProps {
  data: LogsData | undefined;
  loading?: boolean;
  paused?: boolean;
  onPauseToggle?: () => void;
  onClear?: () => void;
}

const LEVEL_COLORS: Record<string, string> = {
  error: "bg-red-500/15 text-red-400 border-red-500/20",
  fatal: "bg-red-500/15 text-red-400 border-red-500/20",
  warn: "bg-yellow-500/15 text-yellow-400 border-yellow-500/20",
  info: "bg-blue-500/15 text-blue-400 border-blue-500/20",
  success: "bg-green-500/15 text-green-400 border-green-500/20",
  log: "bg-gray-500/15 text-gray-400 border-gray-500/20",
  debug: "bg-gray-500/10 text-gray-500 border-gray-500/15",
  trace: "bg-gray-500/10 text-gray-600 border-gray-500/10",
  verbose: "bg-gray-500/10 text-gray-600 border-gray-500/10",
};

const LEVEL_OPTIONS = ["error", "fatal", "warn", "info", "success", "log", "debug", "trace", "verbose"];

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
    + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function formatEntryForCopy(entry: LogEntry): string {
  const parts = [formatTime(entry.timestamp), `[${entry.levelLabel.toUpperCase()}]`];
  if (entry.tag) parts.push(`(${entry.tag})`);
  if (entry.userId) parts.push(`{${entry.userId}}`);
  parts.push(entry.message);
  let line = parts.join(" ");
  if (entry.args) {
    line += "\n" + entry.args.split("\n").map((l) => "    " + l).join("\n");
  }
  return line;
}

export function DashboardLogs({ data, loading, paused = false, onPauseToggle, onClear }: DashboardLogsProps) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAutoScrolling = useRef(false);
  const prevLenRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const filteredEntries = useMemo(() => {
    if (!data?.entries) return [];
    return data.entries.filter((entry) => {
      if (levelFilter.size > 0 && !levelFilter.has(entry.levelLabel)) return false;
      if (tagFilter !== "all" && entry.tag !== tagFilter) return false;
      if (debouncedSearch) {
        const q = debouncedSearch.toLowerCase();
        if (!entry.message.toLowerCase().includes(q)
          && !(entry.tag && entry.tag.toLowerCase().includes(q))
          && !(entry.args && entry.args.toLowerCase().includes(q))
          && !(entry.userId && entry.userId.toLowerCase().includes(q))) return false;
      }
      return true;
    });
  }, [data?.entries, levelFilter, tagFilter, debouncedSearch]);

  const virtualizer = useVirtualizer({
    count: filteredEntries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 30,
  });

  const lastEntryId = filteredEntries.length > 0 ? filteredEntries[filteredEntries.length - 1].id : 0;

  const scrollToBottom = useCallback(() => {
    if (filteredEntries.length === 0) return;
    isAutoScrolling.current = true;
    virtualizer.scrollToIndex(filteredEntries.length - 1, { align: "end" });
    requestAnimationFrame(() => { isAutoScrolling.current = false; });
  }, [filteredEntries.length, virtualizer]);

  useLayoutEffect(() => {
    const len = filteredEntries.length;
    if (autoScroll) {
      if (len > 0) scrollToBottom();
      if (newCount !== 0) setNewCount(0);
    } else {
      const delta = len - prevLenRef.current;
      if (delta > 0) setNewCount((c) => c + delta);
    }
    prevLenRef.current = len;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEntryId, autoScroll]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const breakOut = () => setAutoScroll((prev) => (prev ? false : prev));
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) breakOut(); };
    let touchStartY = 0;
    const onTouchStart = (e: TouchEvent) => { touchStartY = e.touches[0]?.clientY ?? 0; };
    const onTouchMove = (e: TouchEvent) => {
      if ((e.touches[0]?.clientY ?? 0) - touchStartY > 10) breakOut();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") breakOut();
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const handleScroll = () => {
    if (!scrollRef.current || isAutoScrolling.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 40;
    if (atBottom && !autoScroll) setAutoScroll(true);
    else if (!atBottom && autoScroll) setAutoScroll(false);
  };

  const jumpToLatest = () => {
    setAutoScroll(true);
    setNewCount(0);
    scrollToBottom();
  };

  const toggleExpand = useCallback((id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleLevel = useCallback((level: string) => {
    setLevelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }, []);

  const clearFilters = () => {
    setSearch("");
    setDebouncedSearch("");
    setLevelFilter(new Set());
    setTagFilter("all");
  };

  const copyRow = useCallback((entry: LogEntry) => {
    navigator.clipboard.writeText(formatEntryForCopy(entry))
      .then(() => toast.success("Log entry copied"))
      .catch(() => toast.error("Failed to copy"));
  }, []);

  const copyAll = () => {
    if (filteredEntries.length === 0) return;
    const text = filteredEntries.map(formatEntryForCopy).join("\n");
    navigator.clipboard.writeText(text)
      .then(() => toast.success(`Copied ${filteredEntries.length} entries`))
      .catch(() => toast.error("Failed to copy"));
  };

  const downloadLogs = () => {
    if (filteredEntries.length === 0) return;
    const text = filteredEntries.map(formatEntryForCopy).join("\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `logs-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const clearStream = () => {
    onClear?.();
    setNewCount(0);
    prevLenRef.current = 0;
  };

  const hasFilters = search || levelFilter.size > 0 || tagFilter !== "all";
  const tags = data?.tags || [];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <ScrollText className="h-5 w-5" />
              <CardTitle>Application Logs</CardTitle>
              <Badge variant="outline" className="text-xs font-normal">
                {filteredEntries.length} entries
              </Badge>
              {paused && (
                <Badge variant="outline" className="text-xs font-normal bg-yellow-500/15 text-yellow-400 border-yellow-500/20">
                  Paused
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap justify-end">
              {hasFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  <X className="h-3 w-3 mr-1" />
                  Clear
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={copyAll} disabled={filteredEntries.length === 0} title="Copy filtered logs">
                <Copy className="h-3.5 w-3.5 mr-1" />
                Copy
              </Button>
              <Button variant="outline" size="sm" onClick={downloadLogs} disabled={filteredEntries.length === 0} title="Download filtered logs">
                <Download className="h-3.5 w-3.5 mr-1" />
                Export
              </Button>
              {onClear && (
                <Button variant="outline" size="sm" onClick={clearStream} title="Clear the log view">
                  <Trash2 className="h-3.5 w-3.5 mr-1" />
                  Clear view
                </Button>
              )}
              {onPauseToggle && (
                <Button
                  variant={paused ? "default" : "outline"}
                  size="sm"
                  onClick={onPauseToggle}
                  title={paused ? "Resume live updates" : "Pause live updates"}
                >
                  {paused ? <Play className="h-3.5 w-3.5 mr-1" /> : <Pause className="h-3.5 w-3.5 mr-1" />}
                  {paused ? "Resume" : "Pause"}
                </Button>
              )}
              <Button
                variant={autoScroll ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  if (autoScroll) {
                    setAutoScroll(false);
                  } else {
                    jumpToLatest();
                  }
                }}
                title="Toggle auto-scroll"
              >
                <ArrowDownToLine className="h-3.5 w-3.5 mr-1" />
                Auto-scroll
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="flex flex-wrap gap-2 mb-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search message, tag, user, details..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 h-9"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="h-9 w-[130px] justify-start font-normal">
                  <Filter className="h-3.5 w-3.5 mr-2" />
                  {levelFilter.size === 0 ? "All Levels" : `${levelFilter.size} level${levelFilter.size > 1 ? "s" : ""}`}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel>Filter by level</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {LEVEL_OPTIONS.map((lvl) => (
                  <DropdownMenuCheckboxItem
                    key={lvl}
                    checked={levelFilter.has(lvl)}
                    onCheckedChange={() => toggleLevel(lvl)}
                    onSelect={(e) => e.preventDefault()}
                    className="capitalize"
                  >
                    {lvl}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Select value={tagFilter} onValueChange={setTagFilter}>
              <SelectTrigger className="w-[150px] h-9">
                <SelectValue placeholder="Tag" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Tags</SelectItem>
                {tags.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="relative">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            tabIndex={0}
            className="h-[600px] overflow-y-auto rounded-md border bg-[hsl(240_6%_7%)] font-mono text-[13px] leading-relaxed focus:outline-none"
          >
            {filteredEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                <ScrollText className="h-12 w-12 mb-4 opacity-30" />
                <p className="text-sm">
                  {data?.entries?.length ? "No logs match your filters" : "No logs yet"}
                </p>
                <p className="text-xs mt-1 opacity-70">
                  {data?.entries?.length ? "Try adjusting your search or filters" : "Logs will appear here as the addon runs"}
                </p>
              </div>
            ) : (
              <div className="p-2" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const entry = filteredEntries[virtualRow.index];
                  return (
                    <div
                      key={entry.id}
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <LogRow
                        entry={entry}
                        expanded={expandedIds.has(entry.id)}
                        onToggle={toggleExpand}
                        onCopy={copyRow}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {!autoScroll && newCount > 0 && (
            <button
              onClick={jumpToLatest}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-lg hover:opacity-90 transition-opacity"
            >
              <ArrowDown className="h-3.5 w-3.5" />
              {newCount} new {newCount === 1 ? "log" : "logs"}
            </button>
          )}
          </div>
        </CardContent>
      </Card>
    </div>
    </TooltipProvider>
  );
}

const LogRow = React.memo(function LogRow({
  entry,
  expanded,
  onToggle,
  onCopy,
}: {
  entry: LogEntry;
  expanded: boolean;
  onToggle: (id: number) => void;
  onCopy: (entry: LogEntry) => void;
}) {
  const levelClass = LEVEL_COLORS[entry.levelLabel] || LEVEL_COLORS.log;
  const hasDetail = !!entry.args;

  const handleToggle = () => { if (hasDetail) onToggle(entry.id); };

  return (
    <div
      className="group flex flex-col gap-0.5 sm:flex-row sm:items-start sm:gap-2 px-2 py-1.5 sm:py-0.5 border-b border-white/[0.04] sm:border-0 sm:rounded hover:bg-white/[0.03]"
      role={hasDetail ? "button" : undefined}
      tabIndex={hasDetail ? 0 : undefined}
      aria-expanded={hasDetail ? expanded : undefined}
      onClick={handleToggle}
      onKeyDown={hasDetail ? (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(entry.id); }
      } : undefined}
      style={{ cursor: hasDetail ? "pointer" : "default" }}
    >
      <div className="flex items-center gap-2 flex-wrap shrink-0 min-w-0">
      {hasDetail ? (
        expanded
          ? <ChevronDown className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground/60" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground/60" />
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-muted-foreground/50 shrink-0 tabular-nums select-none mt-px order-last ml-auto sm:order-none sm:ml-0">
            {formatTime(entry.timestamp)}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">{new Date(entry.timestamp).toLocaleString()}</TooltipContent>
      </Tooltip>
      <Badge variant="outline" className={`shrink-0 text-[10px] px-1.5 py-0 font-medium uppercase ${levelClass}`}>
        {entry.levelLabel}
      </Badge>
      {entry.tag && (
        <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0 font-normal text-muted-foreground border-muted-foreground/20">
          {entry.tag}
        </Badge>
      )}
      {entry.userId && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0 font-normal text-purple-400/80 border-purple-400/20">
              {entry.userId.slice(0, 8)}
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="right">{entry.userId}</TooltipContent>
        </Tooltip>
      )}
      </div>
      <span className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${entry.level === 0 ? "text-red-400" : entry.level === 1 ? "text-yellow-400" : "text-foreground/80"}`}>
        {entry.message}
        {expanded && entry.args && (
          <pre className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap break-words">{entry.args}</pre>
        )}
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); onCopy(entry); }}
        className="hidden sm:block shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/60 hover:text-foreground p-0.5"
        title="Copy entry"
        tabIndex={-1}
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  );
});
