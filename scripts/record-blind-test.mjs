#!/usr/bin/env node
/**
 * Interactive Blind Test Recording Helper
 * Appends real tester feedback directly to docs/FIRST-TASK-LOG.md according to ROUTE-B §3.5
 */
import readline from "node:readline/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logPath = path.join(root, "docs/FIRST-TASK-LOG.md");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log("=========================================");
console.log("  XioCode 盲测反馈快速录入工具 (ROUTE-B §3.5)");
console.log("=========================================\n");

const date = new Date().toISOString().split("T")[0];
const source = (await rl.question("1. 用户来源 (blind/linux.do/v2ex/HN/reddit/other) [blind]: ")).trim() || "blind";
const env = (await rl.question("2. 测试环境 (如 macOS arm64, Node 22.6, npm): ")).trim() || "macOS Node 22.6";
const model = (await rl.question("3. 使用的 Provider/模型 (如 deepseek/deepseek-chat): ")).trim() || "deepseek/deepseek-chat";
const installSuccess = (await rl.question("4. 安装是否一次成功? (y/n): ")).trim().toLowerCase().startsWith("y") ? "✅" : "❌";
const taskSuccess = (await rl.question("5. 首任务是否成功完成? (y/n): ")).trim().toLowerCase().startsWith("y") ? "✅" : "❌";

let failureReason = "-";
if (taskSuccess === "❌") {
  console.log("\n失败原因分类可选: install | onboarding | config | agent-wrong | agent-slow | tui | trust | env");
  failureReason = (await rl.question("   请输入分类: ")).trim() || "agent-wrong";
}

const secondWeek = (await rl.question("6. 第二周留存情况 (yes/no/pending) [pending]: ")).trim() || "未到期";
const quote = (await rl.question("7. 用户真实原话反馈: ")).trim();

rl.close();

const row = `| ${date} | ${source} | ${env} | ${model} | ${installSuccess} | ${taskSuccess} | ${failureReason} | ${secondWeek} | ${quote} |\n`;

let content = fs.readFileSync(logPath, "utf8");
const marker = "| 日期 | 来源 | 环境 | Provider/模型 | 安装一次成功 | 首任务成功 | 失败原因 | 第二周留存 | 原话 |\n|------|------|------|---------------|--------------|-----------|----------|-----------|------|\n";

if (content.includes(marker)) {
  content = content.replace(marker, marker + row);
  fs.writeFileSync(logPath, content, "utf8");
  console.log(`\n✅ 录入成功！已写入 ${logPath}`);
} else {
  console.error("❌ 未找到表格标记，请检查 docs/FIRST-TASK-LOG.md");
}
