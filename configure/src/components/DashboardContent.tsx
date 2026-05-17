import { useState, useMemo } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Globe, Search, TrendingUp, Film, Tv } from "lucide-react";

interface ContentItem {
  id: string;
  type: string;
  title: string;
  requests: number;
  rating?: number | null;
  year?: number | null;
  imdb_id?: string;
}

interface SearchPattern {
  query: string;
  count: number;
  success: number;
}

interface DashboardContentProps {
  data: {
    popularContent?: ContentItem[];
    searchPatterns?: SearchPattern[];
  } | null;
  loading: boolean;
  timeframe: string;
  onTimeframeChange: (timeframe: string) => void;
}

const TIMEFRAME_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "all", label: "All" },
];

const LIMIT_OPTIONS = [10, 20, 50];

const CLOUD_COLORS = [
  "hsl(220, 70%, 55%)",
  "hsl(250, 60%, 58%)",
  "hsl(200, 65%, 50%)",
  "hsl(280, 55%, 55%)",
  "hsl(170, 55%, 45%)",
  "hsl(340, 55%, 55%)",
];

function TimeframeSelector({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="inline-flex items-center rounded-lg border bg-muted/30 p-0.5">
      {TIMEFRAME_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all ${
            value === opt.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  const colors = rank === 1
    ? "from-amber-500/20 to-amber-600/10 text-amber-600 border-amber-500/30"
    : rank === 2
    ? "from-slate-300/20 to-slate-400/10 text-slate-500 border-slate-400/30"
    : rank === 3
    ? "from-orange-400/20 to-orange-500/10 text-orange-600 border-orange-500/30"
    : "from-muted/50 to-muted/30 text-muted-foreground border-border";

  return (
    <div className={`flex items-center justify-center w-8 h-8 rounded-full bg-gradient-to-br border text-xs font-bold shrink-0 ${colors}`}>
      {rank}
    </div>
  );
}

function ContentRow({ content, rank, maxRequests }: { content: ContentItem; rank: number; maxRequests: number }) {
  const barWidth = maxRequests > 0 ? (content.requests / maxRequests) * 100 : 0;
  const TypeIcon = content.type === "movie" ? Film : Tv;

  return (
    <div className="group relative flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors">
      <RankBadge rank={rank} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <TypeIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="font-medium truncate">{content.title}</span>
          {content.year && (
            <span className="text-xs text-muted-foreground shrink-0">({content.year})</span>
          )}
        </div>
        <div className="relative h-1.5 w-full rounded-full bg-muted/50 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-500"
            style={{ width: `${barWidth}%` }}
          />
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {content.rating && (
          <Badge variant="secondary" className="text-xs font-medium">
            {String(content.rating)}
          </Badge>
        )}
        <div className="text-right min-w-[3rem]">
          <span className="text-sm font-semibold">{content.requests}</span>
          <p className="text-[10px] text-muted-foreground leading-none">requests</p>
        </div>
      </div>
    </div>
  );
}

export function DashboardContent({ data, loading, timeframe, onTimeframeChange }: DashboardContentProps) {
  const [searchLimit, setSearchLimit] = useState(10);

  const popularContent: ContentItem[] = data?.popularContent || [];
  const searchPatterns: SearchPattern[] = data?.searchPatterns || [];
  const filteredSearchPatterns = useMemo(() => searchPatterns.slice(0, searchLimit), [searchPatterns, searchLimit]);
  const maxRequests = useMemo(() => Math.max(...popularContent.map(c => c.requests), 1), [popularContent]);

  const cloudWords = useMemo(() => {
    if (filteredSearchPatterns.length === 0) return [];
    const counts = filteredSearchPatterns.map(p => p.count);
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    return filteredSearchPatterns.map((p, i) => {
      const t = max === min ? 0.5 : (p.count - min) / (max - min);
      return {
        text: p.query,
        count: p.count,
        fontSize: Math.round(13 + t * 28),
        color: CLOUD_COLORS[i % CLOUD_COLORS.length],
        opacity: 0.6 + t * 0.4,
      };
    });
  }, [filteredSearchPatterns]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <TimeframeSelector value={timeframe} onChange={onTimeframeChange} />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-blue-500" />
            <div>
              <CardTitle className="text-lg">Popular Content</CardTitle>
              <CardDescription>Most requested titles</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {popularContent.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Globe className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No popular content yet</p>
              <p className="text-sm mt-1">Content will appear here as users request metadata</p>
            </div>
          ) : (
            <div className="space-y-2">
              {popularContent.map((content, index) => (
                <ContentRow key={index} content={content} rank={index + 1} maxRequests={maxRequests} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Search className="h-5 w-5 text-indigo-500" />
              <div>
                <CardTitle className="text-lg">Search Patterns</CardTitle>
                <CardDescription>Most common search queries</CardDescription>
              </div>
            </div>
            <div className="inline-flex items-center rounded-lg border bg-muted/30 p-0.5">
              {LIMIT_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  onClick={() => setSearchLimit(opt)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all ${
                    searchLimit === opt
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {filteredSearchPatterns.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No search patterns yet</p>
              <p className="text-sm mt-1">Search queries will appear here as users search for content</p>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 min-h-[200px] rounded-lg bg-muted/10 border p-6">
              {cloudWords.map((word, idx) => (
                <span
                  key={idx}
                  title={`"${word.text}" — ${word.count} searches`}
                  className="inline-block cursor-default select-none transition-all duration-200 hover:scale-110 hover:brightness-125"
                  style={{
                    fontSize: `${word.fontSize}px`,
                    lineHeight: 1.2,
                    color: word.color,
                    opacity: word.opacity,
                    fontWeight: word.fontSize > 28 ? 600 : 400,
                  }}
                >
                  {word.text}
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
