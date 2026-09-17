import fs from 'node:fs';
import path from 'node:path';
import type { Component } from '../../host/lifecycle.ts';

export type WorkflowStatus =
  | 'draft'
  | 'ready'
  | 'in_progress'
  | 'verified'
  | 'archived';

export interface TaskArtifacts {
  prdPath: string;
  todolistPath: string;
  verificationPath: string;
  taskJsonPath: string;
}

export class ThreePieceWorkflowComponent implements Component {
  public readonly name = 'three_piece_workflow';
  private workspaceRoot: string = process.cwd();

  public init(_hub: any, config?: Record<string, unknown>): void {
    if (config?.workspaceRoot && typeof config.workspaceRoot === 'string') {
      this.workspaceRoot = config.workspaceRoot;
    }
  }

  public getTaskDir(taskId: string): string {
    return path.join(this.workspaceRoot, '.xioflow', 'tasks', taskId);
  }

  public getArtifacts(taskId: string): TaskArtifacts {
    const taskDir = this.getTaskDir(taskId);
    return {
      prdPath: path.join(taskDir, 'prd.md'),
      todolistPath: path.join(taskDir, 'todolist.md'),
      verificationPath: path.join(taskDir, 'verification.md'),
      taskJsonPath: path.join(taskDir, 'task.json'),
    };
  }

  public createTask(taskId: string, title: string, description: string): TaskArtifacts {
    const taskDir = this.getTaskDir(taskId);
    if (!fs.existsSync(taskDir)) {
      fs.mkdirSync(taskDir, { recursive: true });
    }

    const artifacts = this.getArtifacts(taskId);

    const initialTaskJson = {
      id: taskId,
      title,
      description,
      status: 'ready' as WorkflowStatus,
      createdAt: new Date().toISOString(),
      completedAt: null,
      artifacts: {
        prd: 'prd.md',
        todolist: 'todolist.md',
        verification: 'verification.md',
      },
    };
    fs.writeFileSync(artifacts.taskJsonPath, JSON.stringify(initialTaskJson, null, 2), 'utf8');

    const initialPrd = `# PRD: ${title}\n\n## 1. 需求背景\n${description}\n\n## 2. 目标与范围\n`;
    fs.writeFileSync(artifacts.prdPath, initialPrd, 'utf8');

    const initialTodo = `# Todolist: ${title}\n\n- [ ] 步骤 1：规划与设计\n- [ ] 步骤 2：核心实现\n- [ ] 步骤 3：验证闭环\n`;
    fs.writeFileSync(artifacts.todolistPath, initialTodo, 'utf8');

    const initialVerification = `# Verification: ${title}\n\n## 1. 验证目标\n| 检查项 | 期望标准 | 判定结果 |\n|---|---|---|\n| 核心功能运行 | 退出码为 0 | PENDING |\n\n## 2. 执行证据\n`;
    fs.writeFileSync(artifacts.verificationPath, initialVerification, 'utf8');

    return artifacts;
  }

  public hasTask(taskId: string): boolean {
    return fs.existsSync(this.getArtifacts(taskId).taskJsonPath);
  }

  public updateStatus(taskId: string, status: WorkflowStatus): void {
    const artifacts = this.getArtifacts(taskId);
    if (!fs.existsSync(artifacts.taskJsonPath)) {
      this.createTask(taskId, taskId, `Auto created task for ${taskId}`);
    }

    const raw = fs.readFileSync(artifacts.taskJsonPath, 'utf8');
    const data = JSON.parse(raw);
    data.status = status;
    if (status === 'verified' || status === 'archived') {
      data.completedAt = new Date().toISOString();
    }
    fs.writeFileSync(artifacts.taskJsonPath, JSON.stringify(data, null, 2), 'utf8');
  }

  public recordExecutionEvidence(
    taskId: string,
    evidence: { command: string; exitCode: number | null; durationMs: number; output: string }
  ): void {
    const artifacts = this.getArtifacts(taskId);
    if (!fs.existsSync(artifacts.verificationPath)) return;

    const entry = `
### 执行凭据 (${new Date().toISOString()})
- **命令**: \`${evidence.command}\`
- **退出码**: ${evidence.exitCode}
- **耗时**: ${evidence.durationMs}ms
\`\`\`text
${evidence.output}
\`\`\`
`;
    fs.appendFileSync(artifacts.verificationPath, entry, 'utf8');
  }
}
