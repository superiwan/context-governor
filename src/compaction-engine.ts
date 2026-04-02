import type {
  CompactionConfig,
  CompactionResult,
  InjectedSection,
  MemoryRecord,
  MemoryState,
  SessionMessage,
} from "./types.js";
import { SummaryAuditor } from "./summary-auditor.js";

export class CompactionEngine {
  constructor(private readonly auditor = new SummaryAuditor()) {}

  compact(
    messages: SessionMessage[],
    config: CompactionConfig,
    injectedSections: InjectedSection[],
    memoryState: MemoryState,
  ): CompactionResult {
    const preservedTurns = messages.slice(-config.recentTurnsPreserve);
    const olderTurns = messages.slice(0, Math.max(0, messages.length - preservedTurns.length));
    const summary = buildTaskSummary(olderTurns, memoryState);
    const memoryRefs = flattenMemoryState(memoryState);
    const audit = this.auditor.audit(
      summary,
      memoryState.todos.filter((item) => item.status === "active"),
    );

    return {
      summary,
      preservedTurns,
      injectedSections,
      memoryRefs,
      audit,
    };
  }
}

function buildTaskSummary(messages: SessionMessage[], memoryState: MemoryState): string {
  const goals = pickLines(memoryState.goals, messages, "goal");
  const constraints = pickLines(memoryState.constraints, messages, "constraint");
  const completed = memoryState.todos
    .filter((item) => item.status === "done")
    .map((item) => item.content);
  const pending = memoryState.todos
    .filter((item) => item.status === "active")
    .map((item) => item.content);
  const blockers = extractBlockers(messages);
  const artifacts = pickLines(memoryState.artifacts, messages, "artifact");

  return [
    "## 当前目标",
    renderList(goals, "暂无明确目标"),
    "",
    "## 已确认约束",
    renderList(constraints, "暂无已确认约束"),
    "",
    "## 已完成事项",
    renderList(completed, "暂无已完成事项"),
    "",
    "## 未完成事项",
    renderList(pending, "暂无未完成事项"),
    "",
    "## 当前卡点",
    renderList(blockers, "暂无明确卡点"),
    "",
    "## 关键文件/接口/路径",
    renderList(artifacts, "暂无关键工件"),
  ].join("\n");
}

function renderList(items: string[], fallback: string): string {
  const unique = Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
  if (unique.length === 0) {
    return `- ${fallback}`;
  }
  return unique.map((item) => `- ${item}`).join("\n");
}

function pickLines(memoryRecords: MemoryRecord[], messages: SessionMessage[], tag: string): string[] {
  const fromMemory = memoryRecords
    .filter((item) => item.status !== "obsolete")
    .map((item) => item.content);
  const fromMessages = messages
    .filter((message) => message.tags.includes(tag))
    .map((message) => firstLine(message.content));
  return Array.from(new Set([...fromMemory, ...fromMessages].filter(Boolean)));
}

function extractBlockers(messages: SessionMessage[]): string[] {
  return messages
    .filter((message) => /卡点|阻塞|blocker|blocked|无法|失败/i.test(message.content))
    .map((message) => firstLine(message.content));
}

function flattenMemoryState(memoryState: MemoryState): MemoryRecord[] {
  return [
    ...memoryState.goals,
    ...memoryState.constraints,
    ...memoryState.decisions,
    ...memoryState.todos,
    ...memoryState.artifacts,
  ];
}

function firstLine(content: string): string {
  return content.split(/\r?\n/, 1)[0]?.trim() ?? "";
}
