import type { ComponentHub } from './component-hub.ts';

export type ComponentLifecycleState =
  | 'registered'
  | 'initialized'
  | 'started'
  | 'disposed';

export interface Component {
  name: string;
  dependencies?: string[];
  init?(hub: ComponentHub, config?: Record<string, unknown>): Promise<void> | void;
  start?(): Promise<void> | void;
  dispose?(): Promise<void> | void;
}

export class CircularDependencyError extends Error {
  public readonly cycle: string[];

  constructor(cycle: string[]) {
    super(`Circular dependency detected: ${cycle.join(' -> ')}`);
    this.name = 'CircularDependencyError';
    this.cycle = cycle;
  }
}

export class MissingDependencyError extends Error {
  public readonly component: string;
  public readonly dependency: string;

  constructor(component: string, dependency: string) {
    super(`Component '${component}' requires missing dependency '${dependency}'`);
    this.name = 'MissingDependencyError';
    this.component = component;
    this.dependency = dependency;
  }
}
