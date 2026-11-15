// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
export type ComponentKind = 'required' | 'degradable' | 'deferred';

interface ComponentState {
  kind: ComponentKind;
  state: 'pending' | 'ready' | 'degraded';
  error?: string;
}

function componentSatisfied(component: ComponentState): boolean {
  switch (component.kind) {
    case 'required': return component.state === 'ready';
    case 'degradable': return component.state !== 'pending';
    case 'deferred': return true;
  }
}

export function createReadinessRegistry() {
  const components = new Map<string, ComponentState>();

  const isReady = (): boolean => {
    for (const component of components.values()) {
      if (!componentSatisfied(component)) {
        return false;
      }
    }
    return true;
  };

  const get = (name: string): ComponentState => {
    const component = components.get(name);
    if (!component) {
      throw new Error(`Unknown lifecycle component: ${name}`);
    }
    return component;
  };

  return {
    register(name: string, kind: ComponentKind): void {
      components.set(name, { kind, state: 'pending' });
    },

    markReady(name: string): void {
      const component = get(name);
      component.state = 'ready';
      component.error = undefined;
    },

    markDegraded(name: string, error: Error): void {
      const component = get(name);
      component.state = 'degraded';
      component.error = error?.message || String(error);
    },

    isReady(): boolean {
      return isReady();
    },

    snapshot(): ReadinessSnapshot {
      const summary: Record<string, ComponentSummary> = {};

      for (const [name, component] of components) {
        summary[name] = component.error === undefined
          ? { kind: component.kind, state: component.state }
          : { kind: component.kind, state: component.state, error: component.error };
      }

      return { ready: isReady(), components: summary };
    }
  };
}

export interface ComponentSummary {
  kind: ComponentKind;
  state: 'pending' | 'ready' | 'degraded';
  error?: string;
}

export interface ReadinessSnapshot {
  ready: boolean;
  components: Record<string, ComponentSummary>;
}

export type ReadinessRegistry = ReturnType<typeof createReadinessRegistry>;

export interface ReadinessGateOptions {
  allowPaths?: string[];
  retryAfterSeconds?: number;
}

export function createReadinessGate(registry: ReadinessRegistry, options: ReadinessGateOptions = {}) {
  const allowPaths = options.allowPaths || [];
  const retryAfter = String(options.retryAfterSeconds ?? 5);

  return function readinessGate(req: any, res: any, next: () => void): void {
    if (registry.isReady()) {
      next();
      return;
    }

    const path = req?.path || '';
    if (allowPaths.some((prefix) => path === prefix || path.startsWith(prefix))) {
      next();
      return;
    }

    res.status(503).set('Retry-After', retryAfter).json({
      status: 'starting',
      message: 'The addon is still initializing. Retry shortly.',
      components: registry.snapshot().components
    });
  };
}
