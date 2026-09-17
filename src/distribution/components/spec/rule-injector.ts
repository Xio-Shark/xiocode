import fs from 'node:fs';
import path from 'node:path';
import type { Component } from '../../../host/lifecycle.ts';

export class RuleSpecInjector implements Component {
  public readonly name = 'rule_injector';
  private specDir: string = '';

  public init(_hub: any, config?: Record<string, unknown>): void {
    const root = (config?.workspaceRoot as string) || process.cwd();
    this.specDir = path.join(root, '.xioflow', 'spec');
  }

  public loadRules(): { filename: string; content: string }[] {
    if (!fs.existsSync(this.specDir)) {
      return [];
    }

    const files = fs.readdirSync(this.specDir);
    const rules: { filename: string; content: string }[] = [];

    for (const f of files) {
      if (f.endsWith('.md')) {
        const fullPath = path.join(this.specDir, f);
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          rules.push({ filename: f, content });
        } catch {}
      }
    }

    return rules;
  }

  public getPromptInjection(): string {
    const rules = this.loadRules();
    if (rules.length === 0) return '';

    const sections = rules.map(
      (r) => `<!-- Rule Spec: ${r.filename} -->\n${r.content}`
    );
    return `\n## 项目架构与开发规约 (从 .xioflow/spec/ 注入)\n${sections.join('\n\n')}\n`;
  }
}
