import React from 'react';
import { Card, CardContent, CardHeader, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
// import { Alert } from '@/components/ui/alert'; // Not available, using custom div instead
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import ReactMarkdown from 'react-markdown';
import { FaGithub, FaChevronRight, FaBell } from 'react-icons/fa';

interface ChangelogModalProps {
  version: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}

export function ChangelogModal({ version, open, onOpenChange, hideTrigger = false }: ChangelogModalProps) {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [allReleases, setAllReleases] = React.useState<any[]>([]);
  const [currentReleases, setCurrentReleases] = React.useState<any[]>([]);
  const [newerReleases, setNewerReleases] = React.useState<any[]>([]);
  const [visibleCount, setVisibleCount] = React.useState(0);
  const [showUpdates, setShowUpdates] = React.useState(false);
  const [hasMorePages, setHasMorePages] = React.useState(true);
  const [currentPage, setCurrentPage] = React.useState(1);
  const [fetchingMore, setFetchingMore] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Determine channel from version
  const currentChannel = React.useMemo((): 'stable' | 'nightly' | 'testing' => {
    if (version.includes('testing')) return 'testing';
    return version.startsWith('v') ? 'stable' : 'nightly';
  }, [version]);

  const testingBuildDate = React.useMemo(() => {
    if (currentChannel !== 'testing') return null;
    const match = version.match(/testing[.\-](\d{4})(\d{2})(\d{2})/);
    if (!match) return null;
    return `${match[1]}-${match[2]}-${match[3]}T00:00:00Z`;
  }, [version, currentChannel]);

  // Version comparison function
  const compareVersions = React.useCallback(
    (releaseVersion: string, currentVersion: string) => {
      if (currentChannel === 'stable') {
        // For stable versions, compare semver (e.g., v2.5.1 vs v2.5.2)
        const releaseV = releaseVersion.replace('v', '').split('.').map(Number);
        const currentV = currentVersion.replace('v', '').split('.').map(Number);

        for (let i = 0; i < Math.max(releaseV.length, currentV.length); i++) {
          const r = releaseV[i] || 0;
          const c = currentV[i] || 0;
          if (r > c) return 1; // release is newer
          if (r < c) return -1; // release is older
        }
        return 0; // same version
      } else {
        // For nightly versions, compare date-time (e.g., 2024.01.01.1200-nightly)
        const releaseDate = releaseVersion.replace('-nightly', '');
        const currentDate = currentVersion.replace('-nightly', '');

        if (releaseDate > currentDate) return 1; // release is newer
        if (releaseDate < currentDate) return -1; // release is older
        return 0; // same version
      }
    },
    [currentChannel]
  );

  // Fetch releases with pagination
  const fetchReleases = React.useCallback(async (page: number = 1) => {
    try {
      const response = await fetch(
        `https://api.github.com/repos/cedya77/aiometadata/releases?per_page=100&page=${page}`
      );

      if (!response.ok) throw new Error('Failed to fetch releases');

      const newReleases = await response.json();

      // Check if there are more pages
      const linkHeader = response.headers.get('link');
      const hasNextPage = linkHeader && linkHeader.includes('rel="next"');
      setHasMorePages(!!hasNextPage);

      return newReleases;
    } catch (error) {
      throw error;
    }
  }, []);

  // Filter releases by channel
  const filterReleasesByChannel = React.useCallback(
    (releases: any[], channel: 'stable' | 'nightly') => {
      if (channel === 'stable') {
        return releases.filter(
          (r: any) =>
            r.tag_name.startsWith('v') && !r.tag_name.includes('nightly')
        );
      } else {
        return releases.filter((r: any) => r.tag_name.endsWith('-nightly'));
      }
    },
    []
  );

  const fetchTestingCommits = React.useCallback(async () => {
    const response = await fetch(
      `https://api.github.com/repos/cedya77/aiometadata/commits?sha=dev&per_page=50`
    );
    if (!response.ok) throw new Error('Failed to fetch commits');
    const commits = await response.json();
    return commits.map((c: any) => ({
      id: c.sha,
      tag_name: c.sha.slice(0, 7),
      name: c.commit.message.split('\n')[0],
      body: c.commit.message.split('\n').slice(1).join('\n').trim(),
      published_at: c.commit.committer?.date || c.commit.author?.date,
      html_url: c.html_url,
      author: c.commit.author?.name || c.author?.login,
    }));
  }, []);

  // Initial fetch and setup
  React.useEffect(() => {
    if (!version || version.toLowerCase() === 'unknown') {
      setError('No version available.');
      setLoading(false);
      return;
    }

    setError(null);
    setLoading(true);
    setAllReleases([]);
    setCurrentReleases([]);
    setNewerReleases([]);
    setVisibleCount(0);
    setCurrentPage(1);
    setHasMorePages(true);
    setShowUpdates(false);

    if (currentChannel === 'testing') {
      fetchTestingCommits()
        .then((commits) => {
          setAllReleases(commits);
          setHasMorePages(false);

          if (!testingBuildDate) {
            setCurrentReleases(commits);
            setVisibleCount(Math.min(10, commits.length));
            return;
          }

          const newer: any[] = [];
          const currentAndOlder: any[] = [];
          const buildTime = new Date(testingBuildDate).getTime();

          commits.forEach((commit: any) => {
            if (new Date(commit.published_at).getTime() > buildTime) {
              newer.push(commit);
            } else {
              currentAndOlder.push(commit);
            }
          });

          setNewerReleases(newer);
          setCurrentReleases(currentAndOlder);
          setVisibleCount(Math.min(10, currentAndOlder.length));
        })
        .catch(() => setError('Failed to load dev commits.'))
        .finally(() => setLoading(false));
      return;
    }

    // Fetch initial releases
    fetchReleases(1)
      .then((releases) => {
        // Filter by current channel
        const filtered = filterReleasesByChannel(releases, currentChannel);

        // Sort by published date descending
        filtered.sort(
          (a, b) =>
            new Date(b.published_at).getTime() -
            new Date(a.published_at).getTime()
        );

        setAllReleases(filtered);

        // Split releases based on current version
        const newer: any[] = [];
        const currentAndOlder: any[] = [];

        filtered.forEach((release) => {
          const comparison = compareVersions(release.tag_name, version);
          if (comparison > 0) {
            newer.push(release);
          } else {
            currentAndOlder.push(release);
          }
        });

        setNewerReleases(newer);
        setCurrentReleases(currentAndOlder);
        setVisibleCount(Math.min(5, currentAndOlder.length));
      })
      .catch(() => setError('Failed to load changelogs.'))
      .finally(() => setLoading(false));
  }, [
    version,
    currentChannel,
    testingBuildDate,
    fetchTestingCommits,
    fetchReleases,
    filterReleasesByChannel,
    compareVersions,
  ]);

  // Function to fetch more releases when needed
  const fetchMoreReleases = React.useCallback(async () => {
    if (!hasMorePages || fetchingMore) return;

    setFetchingMore(true);
    try {
      const nextPage = currentPage + 1;
      const newReleases = await fetchReleases(nextPage);

      // Filter the new releases by current channel
      const filtered = filterReleasesByChannel(newReleases, currentChannel);

      if (filtered.length > 0) {
        // Sort by published date descending
        filtered.sort(
          (a, b) =>
            new Date(b.published_at).getTime() -
            new Date(a.published_at).getTime()
        );

        // Add to all releases
        setAllReleases((prev) => [...prev, ...filtered]);

        // Split new releases based on current version
        const newer: any[] = [];
        const currentAndOlder: any[] = [];

        filtered.forEach((release) => {
          const comparison = compareVersions(release.tag_name, version);
          if (comparison > 0) {
            newer.push(release);
          } else {
            currentAndOlder.push(release);
          }
        });

        setNewerReleases((prev) => [...prev, ...newer]);
        setCurrentReleases((prev) => [...prev, ...currentAndOlder]);
        setCurrentPage(nextPage);
      }
    } catch (error) {
      console.error('Failed to fetch more releases:', error);
    } finally {
      setFetchingMore(false);
    }
  }, [
    hasMorePages,
    fetchingMore,
    currentPage,
    fetchReleases,
    currentChannel,
    filterReleasesByChannel,
    compareVersions,
    version,
  ]);

  // Get the releases to display
  const displayReleases = React.useMemo(() => {
    if (showUpdates) {
      return [...newerReleases, ...currentReleases];
    }
    return currentReleases;
  }, [showUpdates, newerReleases, currentReleases]);


  const handleLoadMore = () => {
    if (displayReleases.length > visibleCount) {
      // Load more from current releases
      setVisibleCount((prev) => Math.min(prev + 5, displayReleases.length));
      // Check if we need to fetch more after increasing visible count
      if (displayReleases.length <= visibleCount + 5 && hasMorePages) {
        fetchMoreReleases();
      }
    } else if (hasMorePages && !fetchingMore) {
      // Fetch more releases from API
      fetchMoreReleases();
    }
  };

  const handleShowUpdates = () => {
    setShowUpdates(true);
    setVisibleCount(Math.min(5, newerReleases.length + currentReleases.length));
  };

  const hasMoreContent =
    displayReleases.length > visibleCount || (hasMorePages && !fetchingMore);

  const newerIds = React.useMemo(() => new Set(newerReleases.map((r: any) => r.id)), [newerReleases]);

  const isNewerVersion = React.useCallback(
    (releaseVersion: string, releaseId?: string) => {
      if (currentChannel === 'testing' && releaseId) return newerIds.has(releaseId);
      return compareVersions(releaseVersion, version) > 0;
    },
    [currentChannel, newerIds, compareVersions, version]
  );
  const dialogProps = typeof open === 'boolean' ? { open, onOpenChange } : {};

  return (
    <Dialog {...dialogProps}>
      {!hideTrigger ? (
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2 text-xs sm:text-sm">
            <FaBell className="h-4 w-4" />
            <span className="hidden sm:inline">What's New</span>
            <span className="sm:hidden">Updates</span>
            {newerReleases.length > 0 && (
              <span className="ml-1 bg-[#01b4e4] text-white text-xs px-1.5 py-0.5 rounded-full">
                {newerReleases.length}
              </span>
            )}
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent className="max-w-4xl max-h-[80vh] flex flex-col w-[95vw] h-[90vh] sm:w-auto sm:h-auto">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center justify-between">
            <span className="text-foreground">
              {currentChannel === 'testing' ? 'Recent Dev Commits' : "What's New?"}
            </span>
            {newerReleases.length > 0 && (
              <span className="text-primary font-bold text-sm">
                {newerReleases.length} {currentChannel === 'testing' ? 'commit' : 'update'}
                {newerReleases.length > 1 ? 's' : ''} since your build
              </span>
            )}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="p-4">
            <div
              ref={containerRef}
              className="space-y-4"
            >
          {loading ? (
            <div className="space-y-4">
              {[...Array(2)].map((_, i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : error ? (
            <div className="bg-red-900/20 border border-red-500/30 rounded-lg p-4">
              <h4 className="text-red-400 font-semibold mb-2">Error</h4>
              <p className="text-red-300 text-sm">{error}</p>
            </div>
          ) : displayReleases.length === 0 ? (
            <div className="bg-blue-900/20 border border-blue-500/30 rounded-lg p-4">
              <h4 className="text-blue-400 font-semibold mb-2">No changelogs found</h4>
              <p className="text-blue-300 text-sm">No {currentChannel} changelogs available.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Show updates button */}
              {newerReleases.length > 0 && !showUpdates && (
                <div className="flex justify-center mb-4">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleShowUpdates}
                  >
                    Show {newerReleases.length} {currentChannel === 'testing' ? 'new commit' : 'available update'}
                    {newerReleases.length > 1 ? 's' : ''}
                  </Button>
                </div>
              )}

              {displayReleases.slice(0, visibleCount).map((release, idx) => (
                <Card
                  key={release.id || release.tag_name}
                  className={cn(
                    'border bg-card border-border relative',
                    isNewerVersion(release.tag_name, release.id) && 'border-primary/30'
                  )}
                >
                  <CardHeader className="pb-2">
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 sm:gap-4">
                      <div className="flex items-center gap-2 shrink-0">
                        {currentChannel === 'testing' ? (
                          <>
                            <code className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">{release.tag_name}</code>
                            <span className="text-sm font-semibold text-foreground">{release.name}</span>
                          </>
                        ) : (
                          <span className="text-sm sm:text-base font-semibold break-all text-blue-600 dark:text-blue-400">
                            {release.tag_name}
                          </span>
                        )}
                      </div>
                      <div className="shrink-0 flex items-center gap-2">
                        {currentChannel === 'testing' && release.author && (
                          <span className="text-xs text-muted-foreground">{release.author}</span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {new Date(release.published_at).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="prose prose-invert prose-sm max-w-none [&_p]:text-sm [&_ul]:text-sm [&_li]:text-sm [&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base [&_*]:break-all [&_ul]:list-disc [&_ol]:list-decimal [&_li]:ml-4">
                    <ReactMarkdown
                      components={{
                        ul: ({ children, ...props }) => (
                          <ul className="list-disc list-inside space-y-1 text-sm mb-4" {...props}>
                            {children}
                          </ul>
                        ),
                        ol: ({ children, ...props }) => (
                          <ol className="list-decimal list-inside space-y-1 text-sm mb-4" {...props}>
                            {children}
                          </ol>
                        ),
                        li: ({ children, ...props }) => (
                          <li className="text-sm text-foreground" {...props}>
                            {children}
                          </li>
                        ),
                        p: ({ children, ...props }) => (
                          <p className="text-sm text-foreground mb-2" {...props}>
                            {children}
                          </p>
                        ),
                        h3: ({ children, ...props }) => (
                          <h3 className="text-sm font-semibold text-foreground mt-4 mb-2" {...props}>
                            {children}
                          </h3>
                        ),
                      }}
                    >
                      {release.body
                        ? release.body
                            .replace(release.tag_name, '')
                            .replace(/^## \[[\d.]+\]\([^)]+\) \([\d-]+\)$/gm, '')
                            .replace(/^#+ \[[\d.]+\]\([^)]+\) \([\d-]+\)$/gm, '')
                            .split('\n')
                            .filter(line => line.trim() !== '')
                            .join('\n')
                        : currentChannel === 'testing' ? '' : 'No changelog provided.'}
                    </ReactMarkdown>
                  </CardContent>
                  <CardFooter>
                    <a
                      href={release.html_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-foreground hover:underline flex items-center justify-between w-full text-xs"
                    >
                      <span className="flex items-center gap-2">
                        <FaGithub className="w-4 h-4" />
                        View on GitHub
                      </span>
                      <FaChevronRight className="w-4 h-4" />
                    </a>
                  </CardFooter>
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Load More Button */}
        {hasMoreContent && (
          <div className="flex justify-center py-4">
            <Button
              onClick={handleLoadMore}
              disabled={fetchingMore}
              variant="outline"
              className="gap-2"
            >
              {fetchingMore ? (
                <>
                  <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
                  Loading...
                </>
              ) : displayReleases.length > visibleCount ? (
                `Load ${Math.min(5, displayReleases.length - visibleCount)} more`
              ) : (
                'Load more releases'
              )}
            </Button>
          </div>
        )}
            </div>
          </div>
      </DialogContent>
    </Dialog>
  );
}
