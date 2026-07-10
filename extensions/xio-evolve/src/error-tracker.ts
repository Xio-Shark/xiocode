/**
 * ErrorTracker - 跟踪会话中的错误历史，用于防止模型重复同样的错误
 */

export type ErrorRecord = Readonly<{
  turn: number;
  tool: string;
  error: string;
  args?: Record<string, unknown>;
  timestamp: Date;
}>;

export type ErrorTrackerOptions = Readonly<{
  maxHistory?: number;
  loopThreshold?: number;
}>;

const DEFAULTS = {
  maxHistory: 5,
  loopThreshold: 3,
} as const;

export class ErrorTracker {
  private readonly options: Required<ErrorTrackerOptions>;
  private readonly history: ErrorRecord[] = [];
  private turnCounter = 0;

  constructor(options: ErrorTrackerOptions = {}) {
    this.options = {
      maxHistory: options.maxHistory ?? DEFAULTS.maxHistory,
      loopThreshold: options.loopThreshold ?? DEFAULTS.loopThreshold,
    };
  }

  recordError(tool: string, error: string, args?: Record<string, unknown>): void {
    this.turnCounter++;
    const record: ErrorRecord = {
      turn: this.turnCounter,
      tool,
      error: this.normalizeError(error),
      args,
      timestamp: new Date(),
    };

    this.history.push(record);

    // 保持历史记录在限制内
    if (this.history.length > this.options.maxHistory) {
      this.history.shift();
    }
  }

  getRecentErrors(): readonly ErrorRecord[] {
    return this.history;
  }

  /**
   * 把最近错误聚合成 `tool_error:<type>` 形态的失败原因，
   * 供 TrajectoryRecorder 在 finish() 时合并进 summary.failure_reasons。
   *
   * 与 recorder 内部的结构性标记（tool_error:bash / exit_code:1）互补：
   * 这里产出的是语义化错误类型（file_not_found / permission_denied / syntax_error ...）。
   * 每种类型只出现一次，避免噪声。
   */
  getFailureReasons(): readonly string[] {
    if (this.history.length === 0) {
      return [];
    }
    const seen = new Set<string>();
    const reasons: string[] = [];
    for (const record of this.history) {
      const reason = `tool_error:${this.getErrorType(record.error)}`;
      if (!seen.has(reason)) {
        seen.add(reason);
        reasons.push(reason);
      }
    }
    return reasons;
  }

  /**
   * 对外暴露错误分类，供其它需要语义化错误类型的组件复用。
   */
  classifyError(error: string): string {
    return this.getErrorType(error);
  }

  detectLoop(): { isLoop: boolean; pattern?: string; count: number } {
    if (this.history.length < this.options.loopThreshold) {
      return { isLoop: false, count: 0 };
    }

    // 检查最近的错误是否重复
    const recent = this.history.slice(-this.options.loopThreshold);
    const firstError = recent[0];
    if (!firstError) {
      return { isLoop: false, count: 0 };
    }

    const samePattern = recent.every(
      (record) =>
        record.tool === firstError.tool &&
        record.error === firstError.error &&
        this.argsMatch(record.args, firstError.args)
    );

    if (samePattern) {
      return {
        isLoop: true,
        pattern: `${firstError.tool}: ${firstError.error}`,
        count: this.options.loopThreshold,
      };
    }

    // 检查同一工具或同一文件的重复错误
    const toolCounts = new Map<string, number>();
    for (const record of recent) {
      const key = this.getFileFromArgs(record.args) || record.tool;
      toolCounts.set(key, (toolCounts.get(key) || 0) + 1);
    }

    for (const [key, count] of toolCounts) {
      if (count >= this.options.loopThreshold) {
        return {
          isLoop: true,
          pattern: key,
          count,
        };
      }
    }

    return { isLoop: false, count: 0 };
  }

  generateSummary(): string | null {
    if (this.history.length === 0) {
      return null;
    }

    const lines: string[] = ["## 最近错误（最近 5 轮）"];

    // 检测循环
    const loopDetection = this.detectLoop();
    if (loopDetection.isLoop) {
      lines.push("");
      lines.push("⚠️  **检测到错误循环！**");
      lines.push(`你在重复相同的错误：${loopDetection.pattern}`);
      lines.push(`已发生 ${loopDetection.count} 次。请尝试不同的方法。`);
      lines.push("");
    }

    // 列出最近的错误
    for (const record of this.history) {
      const file = this.getFileFromArgs(record.args);
      const fileInfo = file ? ` (${file})` : "";
      lines.push(`- 第 ${record.turn} 轮: ${record.tool} 失败${fileInfo}`);
      lines.push(`  错误: ${record.error}`);
    }

    // 添加建议
    if (this.history.length >= 2) {
      const patterns = this.findCommonPatterns();
      if (patterns.length > 0) {
        lines.push("");
        lines.push("💡 **建议**:");
        for (const pattern of patterns) {
          lines.push(`  - ${pattern}`);
        }
      }
    }

    return lines.join("\n");
  }

  clear(): void {
    this.history.length = 0;
    this.turnCounter = 0;
  }

  private normalizeError(error: string): string {
    // 移除路径中的变化部分，保留核心错误信息
    let normalized = error;

    // 移除绝对路径，只保留相对路径
    normalized = normalized.replace(/\/[^\s:]+\//g, ".../");

    // 移除行号（可能每次都不同）
    normalized = normalized.replace(/:\d+:\d+/g, "");

    // 移除时间戳
    normalized = normalized.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, "[timestamp]");

    // 截断长错误信息
    if (normalized.length > 200) {
      normalized = normalized.slice(0, 200) + "...";
    }

    return normalized;
  }

  private argsMatch(
    args1: Record<string, unknown> | undefined,
    args2: Record<string, unknown> | undefined
  ): boolean {
    if (!args1 && !args2) return true;
    if (!args1 || !args2) return false;

    // 比较关键参数（file_path, path, command）
    const keyFields = ["file_path", "path", "filePath", "command"];
    for (const field of keyFields) {
      if (args1[field] !== args2[field]) {
        return false;
      }
    }

    return true;
  }

  private getFileFromArgs(args: Record<string, unknown> | undefined): string | null {
    if (!args) return null;

    const fileFields = ["file_path", "path", "filePath"];
    for (const field of fileFields) {
      const value = args[field];
      if (typeof value === "string") {
        return value;
      }
    }

    return null;
  }

  private findCommonPatterns(): string[] {
    const suggestions: string[] = [];

    // 统计错误类型
    const errorTypes = new Map<string, number>();
    for (const record of this.history) {
      const type = this.getErrorType(record.error);
      errorTypes.set(type, (errorTypes.get(type) || 0) + 1);
    }

    // 文件未找到错误
    if (errorTypes.get("file_not_found") && errorTypes.get("file_not_found")! >= 2) {
      suggestions.push("多次文件未找到错误 - 尝试使用 glob 搜索文件");
    }

    // 权限错误
    if (errorTypes.get("permission_denied") && errorTypes.get("permission_denied")! >= 2) {
      suggestions.push("多次权限错误 - 检查文件权限或使用沙箱");
    }

    // 语法错误
    if (errorTypes.get("syntax_error") && errorTypes.get("syntax_error")! >= 2) {
      suggestions.push("多次语法错误 - 仔细检查引号、括号和语法");
    }

    // 同一工具重复失败
    const toolCounts = new Map<string, number>();
    for (const record of this.history) {
      toolCounts.set(record.tool, (toolCounts.get(record.tool) || 0) + 1);
    }
    for (const [tool, count] of toolCounts) {
      if (count >= 3) {
        suggestions.push(`${tool} 工具多次失败 - 考虑使用其他工具或方法`);
      }
    }

    return suggestions.slice(0, 3); // 最多 3 条建议
  }

  private getErrorType(error: string): string {
    const lowerError = error.toLowerCase();
    if (lowerError.includes("not found") || lowerError.includes("enoent")) {
      return "file_not_found";
    }
    if (lowerError.includes("permission") || lowerError.includes("eacces")) {
      return "permission_denied";
    }
    if (lowerError.includes("syntax")) {
      return "syntax_error";
    }
    if (lowerError.includes("command not found")) {
      return "command_not_found";
    }
    return "other";
  }
}
