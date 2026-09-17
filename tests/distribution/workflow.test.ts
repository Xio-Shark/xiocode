import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ComponentHub,
  CircularDependencyError,
  ExactReplaceEditStrategy,
  MatchNotFoundError,
  AmbiguousMatchError,
  ThreePieceWorkflowComponent,
  BasicSafetyInterceptor,
  HighRiskOperationError,
  RuleSpecInjector,
} from '../../src/index.ts';

describe('Task 03: Component Hub & Default Three-Piece Workflow', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiocode-hub-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. 组件宿主生命周期：按拓扑顺序初始化与逆序安全清理', async () => {
    const hub = new ComponentHub();
    const order: string[] = [];
    const disposeOrder: string[] = [];

    const compA = {
      name: 'comp-a',
      dependencies: ['comp-b'],
      init: () => {
        order.push('comp-a');
      },
      dispose: () => {
        disposeOrder.push('comp-a');
      },
    };

    const compB = {
      name: 'comp-b',
      dependencies: [],
      init: () => {
        order.push('comp-b');
      },
      dispose: () => {
        disposeOrder.push('comp-b');
      },
    };

    hub.register(compA);
    hub.register(compB);

    await hub.initAll();
    await hub.startAll();

    // 依赖 B 必须先于 A 初始化
    expect(order).toEqual(['comp-b', 'comp-a']);

    await hub.disposeAll();
    // 逆序安全清理：A 先于 B 清理
    expect(disposeOrder).toEqual(['comp-a', 'comp-b']);
  });

  it('2. 循环依赖检测：检测到环状依赖显式抛出 CircularDependencyError', async () => {
    const hub = new ComponentHub();
    hub.register({
      name: 'node-1',
      dependencies: ['node-2'],
    });
    hub.register({
      name: 'node-2',
      dependencies: ['node-1'],
    });

    await expect(hub.initAll()).rejects.toThrowError(CircularDependencyError);
  });

  it('3. 换行符保真的 ExactReplace：严格保留原文件换行符格式', () => {
    const replacer = new ExactReplaceEditStrategy();

    // 场景 A：Windows CRLF 换行符文件
    const crlfFile = path.join(tempDir, 'crlf.txt');
    const crlfContent = 'line1\r\nfunction hello() {\r\n  return 1;\r\n}\r\nline4\r\n';
    fs.writeFileSync(crlfFile, crlfContent, 'utf8');

    // 替换 return 1 为 return 2
    const resCrlf = replacer.replace({
      filePath: crlfFile,
      targetContent: '  return 1;',
      replacementContent: '  return 2;',
    });

    expect(resCrlf.detectedLineEnding).toBe('\r\n');
    const afterCrlf = fs.readFileSync(crlfFile, 'utf8');
    // 关键断言：绝不篡改为 \n，全文件仍为 \r\n
    expect(afterCrlf).toBe('line1\r\nfunction hello() {\r\n  return 2;\r\n}\r\nline4\r\n');
    expect(afterCrlf.includes('\r\n')).toBe(true);

    // 场景 B：Linux/macOS LF 换行符文件
    const lfFile = path.join(tempDir, 'lf.txt');
    const lfContent = 'line1\nfoo = "old"\nline3\n';
    fs.writeFileSync(lfFile, lfContent, 'utf8');

    const resLf = replacer.replace({
      filePath: lfFile,
      targetContent: 'foo = "old"',
      replacementContent: 'foo = "new"',
    });

    expect(resLf.detectedLineEnding).toBe('\n');
    const afterLf = fs.readFileSync(lfFile, 'utf8');
    expect(afterLf).toBe('line1\nfoo = "new"\nline3\n');
    expect(afterLf.includes('\r\n')).toBe(false);

    // 场景 C：未匹配或多处匹配严格报错
    expect(() => {
      replacer.replace({
        filePath: lfFile,
        targetContent: 'non_existent_symbol',
        replacementContent: 'anything',
      });
    }).toThrowError(MatchNotFoundError);

    // 写入重复内容
    fs.writeFileSync(lfFile, 'dup\ndup\n', 'utf8');
    expect(() => {
      replacer.replace({
        filePath: lfFile,
        targetContent: 'dup',
        replacementContent: 'uniq',
      });
    }).toThrowError(AmbiguousMatchError);
  });

  it('4. 三件套工作流组件：管理工件与状态机流转', () => {
    const workflow = new ThreePieceWorkflowComponent();
    workflow.init(null, { workspaceRoot: tempDir });

    const artifacts = workflow.createTask(
      '01-sample-task',
      'Sample Feature',
      'Implement feature X'
    );

    expect(fs.existsSync(artifacts.prdPath)).toBe(true);
    expect(fs.existsSync(artifacts.todolistPath)).toBe(true);
    expect(fs.existsSync(artifacts.verificationPath)).toBe(true);
    expect(fs.existsSync(artifacts.taskJsonPath)).toBe(true);

    // 验证初始状态
    let meta = JSON.parse(fs.readFileSync(artifacts.taskJsonPath, 'utf8'));
    expect(meta.status).toBe('ready');

    // 状态流转
    workflow.updateStatus('01-sample-task', 'in_progress');
    meta = JSON.parse(fs.readFileSync(artifacts.taskJsonPath, 'utf8'));
    expect(meta.status).toBe('in_progress');

    // 记录执行凭据
    workflow.recordExecutionEvidence('01-sample-task', {
      command: 'pnpm test',
      exitCode: 0,
      durationMs: 450,
      output: 'All tests passed.',
    });

    const verifyContent = fs.readFileSync(artifacts.verificationPath, 'utf8');
    expect(verifyContent).toContain('`pnpm test`');
    expect(verifyContent).toContain('All tests passed.');

    // 完成验收
    workflow.updateStatus('01-sample-task', 'verified');
    meta = JSON.parse(fs.readFileSync(artifacts.taskJsonPath, 'utf8'));
    expect(meta.status).toBe('verified');
    expect(meta.completedAt).toBeDefined();
  });

  it('5. 基础安全拦截与规约注入积木', () => {
    // 拦截器
    const interceptor = new BasicSafetyInterceptor();
    expect(() => {
      interceptor.interceptOrThrow('rm -rf /');
    }).toThrowError(HighRiskOperationError);

    expect(() => {
      interceptor.interceptOrThrow('ls -la');
    }).not.toThrow();

    // 规约注入器
    const specDir = path.join(tempDir, '.xioflow', 'spec');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'rules.md'), '# Arch Rules\nRule 1: Keep it simple.', 'utf8');

    const injector = new RuleSpecInjector();
    injector.init(null, { workspaceRoot: tempDir });
    const prompt = injector.getPromptInjection();

    expect(prompt).toContain('Rule 1: Keep it simple.');
  });
});
