import type { MemoryRecord, SummaryAuditResult } from "./types.js";

const REQUIRED_SECTIONS = [
  "当前目标",
  "已确认约束",
  "已完成事项",
  "未完成事项",
  "当前卡点",
  "关键文件/接口/路径",
];

export class SummaryAuditor {
  audit(summary: string, activeTodos: MemoryRecord[]): SummaryAuditResult {
    const findings: string[] = [];

    for (const heading of REQUIRED_SECTIONS) {
      if (!summary.includes(`## ${heading}`)) {
        findings.push(`missing section: ${heading}`);
      }
    }

    for (const todo of activeTodos) {
      if (!summary.includes(todo.content)) {
        findings.push(`missing active todo: ${todo.content}`);
      }
    }

    return {
      passed: findings.length === 0,
      findings,
      requiredSections: REQUIRED_SECTIONS,
    };
  }
}
