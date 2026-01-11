import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data is considered fresh for 5 seconds
      staleTime: 5 * 1000,
      // Keep unused data in cache for 5 minutes
      gcTime: 5 * 60 * 1000,
      // Retry failed requests, but not for auth errors
      retry: (failureCount, error) => {
        // Don't retry on 401 Unauthorized - user needs to re-authenticate
        if (error instanceof Error && error.message === 'UNAUTHORIZED') {
          return false;
        }
        // Retry other errors up to 2 times
        return failureCount < 2;
      },
      // Don't refetch on window focus by default (we control this per-query)
      refetchOnWindowFocus: false,
      // Don't refetch on reconnect by default
      refetchOnReconnect: true,
    },
  },
});
