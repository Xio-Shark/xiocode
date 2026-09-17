import type {
  Component,
  ComponentLifecycleState,
} from './lifecycle.ts';
import {
  CircularDependencyError,
  MissingDependencyError,
} from './lifecycle.ts';

export class ComponentHub {
  private components: Map<string, Component> = new Map();
  private states: Map<string, ComponentLifecycleState> = new Map();
  private executionOrder: string[] = [];

  public register(component: Component): void {
    if (this.components.has(component.name)) {
      throw new Error(`Component '${component.name}' is already registered`);
    }
    this.components.set(component.name, component);
    this.states.set(component.name, 'registered');
  }

  public get<T extends Component = Component>(name: string): T {
    const comp = this.components.get(name);
    if (!comp) {
      throw new Error(`Component '${name}' not found in hub`);
    }
    return comp as T;
  }

  public has(name: string): boolean {
    return this.components.has(name);
  }

  public getState(name: string): ComponentLifecycleState | undefined {
    return this.states.get(name);
  }

  public async initAll(configMap: Record<string, Record<string, unknown>> = {}): Promise<void> {
    this.executionOrder = this.resolveTopologicalOrder();

    for (const name of this.executionOrder) {
      const comp = this.components.get(name)!;
      if (comp.init) {
        await comp.init(this, configMap[name] || {});
      }
      this.states.set(name, 'initialized');
    }
  }

  public async startAll(): Promise<void> {
    for (const name of this.executionOrder) {
      const comp = this.components.get(name)!;
      if (comp.start) {
        await comp.start();
      }
      this.states.set(name, 'started');
    }
  }

  public async disposeAll(): Promise<void> {
    // 逆序执行安全清理
    const reverseOrder = [...this.executionOrder].reverse();
    for (const name of reverseOrder) {
      const comp = this.components.get(name);
      if (comp && comp.dispose) {
        try {
          await comp.dispose();
        } catch (err) {
          console.error(`Error disposing component '${name}':`, err);
        }
      }
      this.states.set(name, 'disposed');
    }
  }

  public resolveTopologicalOrder(): string[] {
    // 检查是否有缺失依赖
    for (const [name, comp] of this.components.entries()) {
      if (comp.dependencies) {
        for (const dep of comp.dependencies) {
          if (!this.components.has(dep)) {
            throw new MissingDependencyError(name, dep);
          }
        }
      }
    }

    const order: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const dfs = (node: string, currentPath: string[] = []) => {
      if (visiting.has(node)) {
        throw new CircularDependencyError([...currentPath, node]);
      }
      if (visited.has(node)) return;

      visiting.add(node);
      const comp = this.components.get(node)!;
      const deps = comp.dependencies || [];

      for (const dep of deps) {
        dfs(dep, [...currentPath, node]);
      }

      visiting.delete(node);
      visited.add(node);
      order.push(node);
    };

    for (const name of this.components.keys()) {
      if (!visited.has(name)) {
        dfs(name, []);
      }
    }

    return order;
  }
}
