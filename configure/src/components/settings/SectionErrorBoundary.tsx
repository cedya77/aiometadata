// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertCircle, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { claimChunkReload, isChunkLoadError, reloadGuardStorage } from '@/lib/chunkReload';

interface Props {
  label: string;
  fallback: ReactNode;
  children: ReactNode;
}

interface State {
  error: Error | null;
  reloading: boolean;
}

export class SectionErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reloading: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[settings] ${this.props.label} failed to render`, error, info.componentStack);

    if (!isChunkLoadError(error)) return;
    if (!claimChunkReload(reloadGuardStorage())) return;

    this.setState({ reloading: true });
    window.location.reload();
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error, reloading } = this.state;
    if (!error) return this.props.children;
    if (reloading) return this.props.fallback;

    const staleChunk = isChunkLoadError(error);

    return (
      <Card className="border-red-500/25 bg-red-500/[0.06] p-6" role="alert">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-3">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-foreground">
                {this.props.label} could not be loaded
              </h2>
              <p className="text-sm text-muted-foreground">
                {staleChunk
                  ? 'This page was opened before the addon was updated, so part of it is no longer available. Reloading picks up the new version.'
                  : 'Something went wrong while rendering this section. Reloading usually clears it.'}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={this.handleReload}>
              <RotateCw aria-hidden="true" />
              Reload page
            </Button>
          </div>
        </div>
      </Card>
    );
  }
}
