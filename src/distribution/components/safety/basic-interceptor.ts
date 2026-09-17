import type { Component } from '../../../host/lifecycle.ts';

export class HighRiskOperationError extends Error {
  public readonly command: string;
  public readonly reason: string;

  constructor(command: string, reason: string) {
    super(`High risk command intercepted: '${command}' (${reason})`);
    this.name = 'HighRiskOperationError';
    this.command = command;
    this.reason = reason;
  }
}

export class BasicSafetyInterceptor implements Component {
  public readonly name = 'basic_interceptor';

  private dangerousPatterns: { regex: RegExp; reason: string }[] = [
    { regex: /rm\s+-rf\s+(\/|~|\$HOME|\.\.)/i, reason: 'Recursive root or home directory deletion' },
    { regex: /git\s+push.*--force/i, reason: 'Force push can overwrite remote history' },
    { regex: /mkfs\./i, reason: 'Filesystem format operation' },
    { regex: /dd\s+if=.*of=\/dev\//i, reason: 'Direct disk write' },
    { regex: /:\(\)\{\s*:\|:&\s*\};:/i, reason: 'Fork bomb detected' },
  ];

  public checkCommand(commandStr: string): { safe: boolean; reason?: string } {
    for (const pattern of this.dangerousPatterns) {
      if (pattern.regex.test(commandStr)) {
        return { safe: false, reason: pattern.reason };
      }
    }
    return { safe: true };
  }

  public interceptOrThrow(commandStr: string): void {
    const check = this.checkCommand(commandStr);
    if (!check.safe) {
      throw new HighRiskOperationError(commandStr, check.reason || 'Unsafe command');
    }
  }
}
