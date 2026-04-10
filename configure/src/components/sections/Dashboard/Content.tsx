import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
    Card,
    CardHeader,
    CardTitle,
    CardContent,
    CardDescription
} from "@/components/ui/card";
import { BarChart3, Globe } from "lucide-react";

// Data is now fetched via TanStack Query at the Dashboard level
export function DashboardContent({ data, loading }) {
  const [searchLimit, setSearchLimit] = useState(10);

  // Extract data from props (fetched by TanStack Query)
  const popularContent = data?.popularContent || [];
  const searchPatterns = data?.searchPatterns || [];
  const contentQuality = data?.contentQuality || {
    missingMetadata: 0,
    failedMappings: 0,
    correctionRequests: 0,
    successRate: 0,
  };

  // fetches all data
  const filteredSearchPatterns = searchPatterns.slice(0, searchLimit);

  return (
    <div className="space-y-6">
      {/* Popular Content */}
      <Card>
        <CardHeader>
          <CardTitle>Popular Content</CardTitle>
          <CardDescription>
            Most requested titles and their ratings
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {popularContent.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Globe className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No popular content yet</p>
                <p className="text-sm">
                  Content will appear here as users request metadata
                </p>
              </div>
            ) : (
              popularContent.map((content, index) => (
                <div
                  key={index}
                  className="p-3 border rounded-lg"
                >
                  {/* Desktop layout */}
                  <div className="hidden sm:flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <Badge
                        variant={
                          content.type === "movie" || content.type === "series"
                            ? "default"
                            : "secondary"
                        }
                      >
                        {content.type}
                      </Badge>
                      <span className="font-medium">{content.title}</span>
                    </div>
                    <div className="flex items-center space-x-4">
                      <div className="text-right">
                        <p className="text-sm text-muted-foreground">Requests</p>
                        <p className="font-medium">{content.requests}</p>
                      </div>
                      {content.rating && (
                        <div className="text-right">
                          <p className="text-sm text-muted-foreground">Rating</p>
                          <p className="font-medium">
                            ⭐ {String(content.rating)}
                          </p>
                        </div>
                      )}
                      {content.year && (
                        <div className="text-right">
                          <p className="text-sm text-muted-foreground">Year</p>
                          <p className="font-medium">{String(content.year)}</p>
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Mobile layout */}
                  <div className="sm:hidden">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center space-x-2 min-w-0">
                        <Badge
                          variant={
                            content.type === "movie" || content.type === "series"
                              ? "default"
                              : "secondary"
                          }
                          className="flex-shrink-0"
                        >
                          {content.type}
                        </Badge>
                        <span className="font-medium truncate">{content.title}</span>
                      </div>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Requests</span>
                      <span className="font-medium">{content.requests}</span>
                    </div>
                    {content.rating && (
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Rating</span>
                        <span className="font-medium">⭐ {String(content.rating)}</span>
                      </div>
                    )}
                    {content.year && (
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Year</span>
                        <span className="font-medium">{String(content.year)}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {/* Search Patterns */}
      <Card>
        <CardHeader>
          <CardTitle>Search Patterns</CardTitle>
          <CardDescription>
            Most common search queries (shows today + yesterday)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Show</span>
            <select
              value={searchLimit}
              onChange={(e) => setSearchLimit(parseInt(e.target.value) || 10)}
              className="px-2 py-1 border rounded-md bg-background text-sm"
            >
              <option value={10}>Top 10</option>
              <option value={20}>Top 20</option>
              <option value={50}>Top 50</option>
            </select>
          </div>
          {filteredSearchPatterns.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <BarChart3 className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No search patterns yet</p>
              <p className="text-sm">
                Search queries will appear here as users search for content
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-3">
              {(() => {
                const counts = filteredSearchPatterns.map((p: any) => p.count);
                const min = Math.min(...counts);
                const max = Math.max(...counts);
                const scale = (count: number) => {
                  if (max === min) return 16; // px
                  const t = (count - min) / (max - min);
                  return Math.round(14 + t * 22); // 14px -> 36px
                };
                return filteredSearchPatterns.map((p: any, idx: number) => (
                  <span
                    key={idx}
                    title={`"${p.query}" • Count: ${p.count}`}
                    className="select-none cursor-default inline-block"
                    style={{
                      fontSize: `${scale(p.count)}px`,
                      lineHeight: 1.1,
                      color: "hsl(220 60% 55%)",
                    }}
                  >
                    {p.query}
                  </span>
                ));
              })()}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Content Quality Metrics - Placeholder, hidden for now
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Content Quality</CardTitle>
            <CardDescription>
              Metadata completeness and accuracy
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Missing Metadata</span>
                <span className="text-2xl font-bold text-orange-600">
                  {contentQuality.missingMetadata}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Failed Mappings</span>
                <span className="text-2xl font-bold text-red-600">
                  {contentQuality.failedMappings}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Success Rate</span>
                <span className="text-2xl font-bold text-green-600">
                  {contentQuality.successRate}%
                </span>
              </div>
              <Progress value={contentQuality.successRate} className="mt-2" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Correction Requests</CardTitle>
            <CardDescription>
              User feedback and correction submissions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-center py-8">
              <div className="text-3xl font-bold text-blue-600 mb-2">
                {contentQuality.correctionRequests}
              </div>
              <p className="text-sm text-muted-foreground">
                Pending corrections
              </p>
              <Button className="mt-4" variant="outline">
                View All
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
      */}

      {/* Content Trends Placeholder - Hidden for now
      <Card>
        <CardHeader>
          <CardTitle>Content Trends</CardTitle>
          <CardDescription>
            Popular genres and seasonal patterns
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-12 text-muted-foreground">
            <Globe className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>Content Trend Charts</p>
            <p className="text-sm">
              Charts will be implemented in the next step
            </p>
          </div>
        </CardContent>
      </Card>
      */}
    </div>
  );
}