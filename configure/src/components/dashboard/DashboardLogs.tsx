import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
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
  ScrollText,
  Search,
  ArrowDownToLine,
  X,
  Loader2,
} from "lucide-react";
import type { LogsData, LogEntry } from "@/hooks/useDashboardQueries";

interface DashboardLogsProps {
  data: LogsData | undefined;
  loading?: boolean;
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

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
    + "." + String(d.getMilliseconds()).padStart(3, "0");
}

export function DashboardLogs({ data, loading }: DashboardLogsProps) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAutoScrolling = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const filteredEntries = useMemo(() => {
    if (!data?.entries) return [];
    return data.entries.filter((entry) => {
      if (levelFilter !== "all" && entry.levelLabel !== levelFilter) return false;
      if (tagFilter !== "all" && entry.tag !== tagFilter) return false;
      if (debouncedSearch && !entry.message.toLowerCase().includes(debouncedSearch.toLowerCase())) return false;
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

  useLayoutEffect(() => {
    if (autoScroll && filteredEntries.length > 0) {
      isAutoScrolling.current = true;
      virtualizer.scrollToIndex(filteredEntries.length - 1, { align: "end" });
      requestAnimationFrame(() => { isAutoScrolling.current = false; });
    }
  }, [lastEntryId, autoScroll]);

  const handleScroll = () => {
    if (!scrollRef.current || isAutoScrolling.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 40;
    if (atBottom && !autoScroll) setAutoScroll(true);
    else if (!atBottom && autoScroll) setAutoScroll(false);
  };

  const toggleExpand = useCallback((id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearFilters = () => {
    setSearch("");
    setDebouncedSearch("");
    setLevelFilter("all");
    setTagFilter("all");
  };

  const hasFilters = search || levelFilter !== "all" || tagFilter !== "all";
  const tags = data?.tags || [];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ScrollText className="h-5 w-5" />
              <CardTitle>Application Logs</CardTitle>
              <Badge variant="outline" className="text-xs font-normal">
                {filteredEntries.length} entries
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              {hasFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  <X className="h-3 w-3 mr-1" />
                  Clear
                </Button>
              )}
              <Button
                variant={autoScroll ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setAutoScroll(!autoScroll);
                  if (!autoScroll && filteredEntries.length > 0) {
                    virtualizer.scrollToIndex(filteredEntries.length - 1, { align: "end" });
                  }
                }}
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
                placeholder="Search logs..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 h-9"
              />
            </div>
            <Select value={levelFilter} onValueChange={setLevelFilter}>
              <SelectTrigger className="w-[120px] h-9">
                <SelectValue placeholder="Level" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Levels</SelectItem>
                <SelectItem value="error">Error</SelectItem>
                <SelectItem value="warn">Warn</SelectItem>
                <SelectItem value="info">Info</SelectItem>
                <SelectItem value="success">Success</SelectItem>
                <SelectItem value="debug">Debug</SelectItem>
                <SelectItem value="trace">Trace</SelectItem>
              </SelectContent>
            </Select>
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

          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="h-[600px] overflow-y-auto rounded-md border bg-[hsl(240_6%_7%)] font-mono text-[13px] leading-relaxed"
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
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

const LogRow = React.memo(function LogRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: LogEntry;
  expanded: boolean;
  onToggle: (id: number) => void;
}) {
  const levelClass = LEVEL_COLORS[entry.levelLabel] || LEVEL_COLORS.log;

  return (
    <div
      className="flex items-start gap-2 px-2 py-0.5 rounded hover:bg-white/[0.03] cursor-default group"
      onClick={entry.args ? () => onToggle(entry.id) : undefined}
    >
      <span className="text-muted-foreground/50 shrink-0 tabular-nums select-none">
        {formatTime(entry.timestamp)}
      </span>
      <Badge variant="outline" className={`shrink-0 text-[10px] px-1.5 py-0 font-medium uppercase ${levelClass}`}>
        {entry.levelLabel}
      </Badge>
      {entry.tag && (
        <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0 font-normal text-muted-foreground border-muted-foreground/20">
          {entry.tag}
        </Badge>
      )}
      <span className={`break-all ${entry.level === 0 ? "text-red-400" : entry.level === 1 ? "text-yellow-400" : "text-foreground/80"}`}>
        {entry.message}
        {expanded && entry.args && (
          <pre className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">{entry.args}</pre>
        )}
      </span>
    </div>
  );
});
