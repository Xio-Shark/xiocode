import fs from 'node:fs';
import path from 'node:path';
import type { Component } from '../../../host/lifecycle.ts';
import { ComponentHub } from '../../../host/component-hub.ts';
import { ExactReplaceEditStrategy } from '../edit/exact-replace.ts';
import { BasicSafetyInterceptor } from '../safety/basic-interceptor.ts';

export interface ProcessSupervisorLike {
  executeProcess(opts: {
    runId: string;
    opId: string;
    name: string;
    command: { execPath: string; args: string[]; cwd?: string };
    requiredResources?: string[];
    timeoutMs?: number;
    inputFingerprint?: string;
  }): Promise<{ status: 'completed' | 'failed'; exitCode?: number; stdout?: string; stderr?: string }>;
}

export class KernelToolsComponent implements Component {
  public readonly name = 'kernel_tools';
  public readonly dependencies = ['exact_replace', 'basic_interceptor'];

  private hub!: ComponentHub;
  private supervisor?: ProcessSupervisorLike;

  public init(hub: ComponentHub, config?: Record<string, unknown>): void {
    this.hub = hub;
    if (config?.supervisor) {
      this.supervisor = config.supervisor as ProcessSupervisorLike;
    }
  }

  public setSupervisor(supervisor: ProcessSupervisorLike): void {
    this.supervisor = supervisor;
  }

  public async runBash(
    runId: string,
    commandStr: string,
    cwd: string = process.cwd(),
    timeoutMs: number = 30000
  ) {
    const interceptor = this.hub.get<BasicSafetyInterceptor>('basic_interceptor');
    interceptor.interceptOrThrow(commandStr);

    if (!this.supervisor) {
      throw new Error('Supervisor not attached to KernelToolsComponent');
    }

    const opId = `op-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    return this.supervisor.executeProcess({
      runId,
      opId,
      name: 'bash-exec',
      command: {
        execPath: '/bin/sh',
        args: ['-c', commandStr],
        cwd,
      },
      requiredResources: [`workspace:sh:${path.resolve(cwd)}`],
      timeoutMs,
      inputFingerprint: `sh:${commandStr}`,
    });
  }

  public editFile(filePath: string, targetContent: string, replacementContent: string) {
    const replacer = this.hub.get<ExactReplaceEditStrategy>('exact_replace');
    return replacer.replace({
      filePath,
      targetContent,
      replacementContent,
    });
  }

  public readFile(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8');
  }

  public writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
}
