import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface LoadingScreenProps {
  message?: string;
  showSkeleton?: boolean;
}

export function LoadingScreen({ 
  message = "Loading configuration...", 
  showSkeleton = true 
}: LoadingScreenProps) {
  return (
    <div className="min-h-screen w-full bg-background text-foreground flex flex-col items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-5xl">
        {/* Header Skeleton */}
        <div className="mb-8">
          <Skeleton className="h-8 w-64 mx-auto mb-4" />
          <Skeleton className="h-4 w-96 mx-auto" />
        </div>

        {/* Main Card */}
        <Card className="w-full shadow-2xl">
          <CardContent className="p-6 md:p-8">
            {/* Loading Animation */}
            <div className="flex flex-col items-center justify-center py-12">
              {/* Animated Logo/Icon */}
              <div className="relative mb-8">
                <div className="w-16 h-16 rounded-full bg-gradient-to-r from-primary to-primary/60 animate-pulse" />
                <div className="absolute inset-0 w-16 h-16 rounded-full border-4 border-primary/20 animate-ping" />
                <div className="absolute inset-2 w-12 h-12 rounded-full border-2 border-primary/40 animate-pulse" />
              </div>

              {/* Loading Text */}
              <div className="text-center mb-8">
                <h2 className="text-2xl font-semibold mb-2 bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
                  {message}
                </h2>
                <div className="flex items-center justify-center space-x-1">
                  <div className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>

              {/* Progress Bar */}
              <div className="w-full max-w-md">
                <div className="w-full bg-muted rounded-full h-2">
                  <div className="bg-gradient-to-r from-primary to-primary/60 h-2 rounded-full animate-pulse" 
                       style={{ width: '60%' }} />
                </div>
              </div>
            </div>

            {/* Skeleton Content */}
            {showSkeleton && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Skeleton className="h-32" />
                  <Skeleton className="h-32" />
                </div>
                <div className="space-y-3">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-5/6" />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
