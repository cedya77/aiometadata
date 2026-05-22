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

function ImdbLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 575 289.83" className={className} aria-label="IMDb">
      <path d="M575 24.91C573.44 12.15 563.97 1.98 551.91 0H23.32C10.11 2.17 0 14.16 0 28.61v232.25c0 16 12.37 28.97 27.64 28.97h519.95c14.06 0 25.67-11.01 27.41-25.26V24.91Z" fill="#f6c700"/>
      <path d="M69.35 58.24h45.63v175.65H69.35zM201.2 139.15c-3.92-26.77-6.1-41.65-6.53-44.62-1.91-14.33-3.73-26.8-5.47-37.44H130.04v175.65h39.97l.14-115.98 16.82 115.98h28.47l15.95-118.56.15 118.56h39.84V57.09h-59.61l-10.57 82.06ZM346.71 93.63c.5 2.24.76 7.32.76 15.26v68.1c0 11.69-.76 18.85-2.27 21.49-1.52 2.64-5.56 3.95-12.11 3.95V87.13c4.97 0 8.36.53 10.16 1.57 1.8 1.05 2.96 2.69 3.46 4.93Zm20.61 137.32c5.43-1.19 9.99-3.29 13.69-6.28 3.69-3 6.28-7.15 7.76-12.46 1.49-5.3 2.37-15.83 2.37-31.58v-61.68c0-16.62-.65-27.76-1.66-33.42-.97-5.67-3.5-10.82-7.6-15.44-4.06-4.62-9.98-7.94-17.76-9.96-7.79-2.02-20.49-3.04-42.58-3.04H287.5v175.65h55.28c12.74-.4 20.92-.99 24.54-1.79ZM464.76 204.7c-.84 2.23-4.52 3.36-7.3 3.36-2.72 0-4.53-1.08-5.45-3.25-.92-2.16-1.37-7.09-1.37-14.81v-46.42c0-7.99.4-12.99 1.21-14.98.8-1.97 2.56-2.97 5.28-2.97 2.78 0 6.51 1.13 7.47 3.4.95 2.27 1.43 7.12 1.43 14.55v44.71c-.29 9.25-.71 14.62-1.27 16.41ZM406.68 231.21h41.08c1.71-6.71 2.65-10.44 2.84-11.19 3.72 4.5 7.81 7.88 12.3 10.12 4.47 2.25 11.16 3.37 16.34 3.37 7.21 0 13.43-1.89 18.68-5.68 5.24-3.78 8.58-8.26 10-13.41 1.42-5.16 2.13-13 2.13-23.54v-49.28c0-10.6-.24-17.52-.71-20.77-.47-3.25-1.87-6.56-4.2-9.95-2.33-3.39-5.72-6.02-10.16-7.9-4.44-1.88-9.68-2.82-15.72-2.82-5.25 0-11.97 1.05-16.45 3.12-4.47 2.07-8.53 5.21-12.17 9.42V55.56h-43.96v175.65Z" fill="#000"/>
    </svg>
  );
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
          <Badge variant="outline" className="text-xs font-medium bg-yellow-500/15 text-yellow-300 border-yellow-500/30">
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
