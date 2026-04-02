import { randomUUID } from "node:crypto";

import type {
  CompactionConfig,
  ContextSnapshot,
  ContextUpdateResult,
  IncomingMessage,
  MemoryRecord,
  MemoryRecordStatus,
  MemoryRecordType,
  SessionMessage,
} from "./types.js";
import { estimateTokens } from "./tokenizer.js";
import { FileMemoryStore } from "./memory-store.js";
import { InstructionInjector } from "./instruction-injector.js";
import { CompactionEngine } from "./compaction-engine.js";

const DEFAULT_CONFIG: CompactionConfig = {
  maxContextTokens: 24000,
  recentTurnsPreserve: 5,
  postCompactionSections: [],
  memoryFlush: {
    enabled: true,
    softThresholdTokens: 4000,
    lookbackMessages: 8,
  },
  qualityGuard: {
    enabled: true,
    maxRetries: 0,
  },
};

interface ContextManagerOptions {
  memoryStore: FileMemoryStore;
  instructionSources?: Record<string, string>;
  compactionEngine?: CompactionEngine;
}

export class ContextManager {
  private readonly config: CompactionConfig;
  private readonly memoryStore: FileMemoryStore;
  private readonly injector: InstructionInjector;
  private readonly compactionEngine: CompactionEngine;
  private messages: SessionMessage[] = [];
  private snapshot: ContextSnapshot = {
    workingMessages: [],
    summary: null,
    compactedAt: null,
  };

  constructor(
    private readonly sessionId: string,
    config: Partial<CompactionConfig>,
    options: ContextManagerOptions,
  ) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      memoryFlush: {
        ...DEFAULT_CONFIG.memoryFlush,
        ...config.memoryFlush,
      },
      qualityGuard: {
        ...DEFAULT_CONFIG.qualityGuard,
        ...config.qualityGuard,
      },
    };
    this.memoryStore = options.memoryStore;
    this.injector = new InstructionInjector(options.instructionSources ?? {});
    this.compactionEngine = options.compactionEngine ?? new CompactionEngine();
  }

  async addMessage(input: IncomingMessage): Promise<ContextUpdateResult> {
    const message = toSessionMessage(input);
    this.messages.push(message);

    let flushed = false;
    let compacted = false;
    let remainingTokens = this.getRemainingTokens();

    if (
      this.config.memoryFlush.enabled &&
      remainingTokens < this.config.memoryFlush.softThresholdTokens
    ) {
      const records = extractMemoryRecords(
        this.sessionId,
        this.messages.slice(-this.config.memoryFlush.lookbackMessages),
      );
      if (records.length > 0) {
        await this.memoryStore.append(this.sessionId, records);
        flushed = true;
      }
    }

    const compactionTrigger =
      this.config.compactionTriggerTokens ??
      this.config.maxContextTokens - Math.floor(this.config.memoryFlush.softThresholdTokens / 2);

    if (this.getUsedTokens() >= compactionTrigger) {
      const memoryState = await this.memoryStore.getState(this.sessionId);
      const injectedSections = this.injector.inject(this.config.postCompactionSections);
      const result = this.compactionEngine.compact(
        this.messages,
        this.config,
        injectedSections,
        memoryState,
      );

      await this.memoryStore.writeSnapshot(this.sessionId, `${Date.now()}-pre`, {
        messages: this.messages,
      });
      await this.memoryStore.writeSnapshot(this.sessionId, `${Date.now()}-post`, result);

      this.messages = buildWorkingMessages(result, this.messages);
      this.snapshot = {
        workingMessages: [...this.messages],
        summary: result.summary,
        compactedAt: new Date().toISOString(),
      };
      compacted = true;
      remainingTokens = this.getRemainingTokens();
    } else {
      this.snapshot = {
        workingMessages: [...this.messages],
        summary: this.snapshot.summary,
        compactedAt: this.snapshot.compactedAt,
      };
    }

    return {
      message,
      flushed,
      compacted,
      remainingTokens,
      snapshot: this.snapshot,
    };
  }

  getSnapshot(): ContextSnapshot {
    return {
      workingMessages: [...this.snapshot.workingMessages],
      summary: this.snapshot.summary,
      compactedAt: this.snapshot.compactedAt,
    };
  }

  private getUsedTokens(): number {
    return this.messages.reduce((sum, message) => sum + message.tokenEstimate, 0);
  }

  private getRemainingTokens(): number {
    return this.config.maxContextTokens - this.getUsedTokens();
  }
}

function toSessionMessage(input: IncomingMessage): SessionMessage {
  return {
    id: randomUUID(),
    role: input.role,
    content: input.content,
    timestamp: new Date().toISOString(),
    tokenEstimate: estimateTokens(input.content),
    tags: input.tags ?? [],
  };
}

function buildWorkingMessages(
  result: ReturnType<CompactionEngine["compact"]>,
  existingMessages: SessionMessage[],
): SessionMessage[] {
  const injected = result.injectedSections.map((section) =>
    toSyntheticMessage(
      "system",
      `[Injected:${section.section}]\n${section.content}`,
      ["injected-rule"],
    ),
  );

  const summaryMessage = toSyntheticMessage("system", result.summary, ["history-summary"]);
  const memoryMessage = toSyntheticMessage(
    "system",
    renderMemoryContext(result.memoryRefs),
    ["memory-context"],
  );

  return [...injected, summaryMessage, memoryMessage, ...result.preservedTurns].map((message) => ({
    ...message,
    tokenEstimate: estimateTokens(message.content),
  }));
}

function toSyntheticMessage(
  role: SessionMessage["role"],
  content: string,
  tags: string[],
): SessionMessage {
  return {
    id: randomUUID(),
    role,
    content,
    timestamp: new Date().toISOString(),
    tokenEstimate: estimateTokens(content),
    tags,
  };
}

function renderMemoryContext(records: MemoryRecord[]): string {
  const active = records.filter((record) => record.status !== "obsolete");
  if (active.length === 0) {
    return "No active memory records.";
  }

  return [
    "Active memory records:",
    ...active.map((record) => `- [${record.type}/${record.status}] ${record.content}`),
  ].join("\n");
}

function extractMemoryRecords(sessionId: string, messages: SessionMessage[]): MemoryRecord[] {
  const records: MemoryRecord[] = [];
  for (const message of messages) {
    const lines = message.content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const parsed = parseMemoryLine(line, message.id);
      if (parsed) {
        records.push({
          id: randomUUID(),
          sessionId,
          updatedAt: new Date().toISOString(),
          ...parsed,
        });
      }
    }
  }

  return dedupeMemoryRecords(records);
}

function parseMemoryLine(
  line: string,
  sourceTurnId: string,
):
  | {
      type: MemoryRecordType;
      content: string;
      status: MemoryRecordStatus;
      sourceTurnIds: string[];
    }
  | null {
  const rules: Array<{
    pattern: RegExp;
    type: MemoryRecordType;
    status: MemoryRecordStatus;
  }> = [
    { pattern: /^(goal|目标)[:：]\s*(.+)$/i, type: "goal", status: "active" },
    { pattern: /^(constraint|约束)[:：]\s*(.+)$/i, type: "constraint", status: "active" },
    { pattern: /^(decision|决策)[:：]\s*(.+)$/i, type: "decision", status: "active" },
    { pattern: /^(todo|待办)[:：]\s*(.+)$/i, type: "todo", status: "active" },
    { pattern: /^(done|完成)[:：]\s*(.+)$/i, type: "todo", status: "done" },
    { pattern: /^(artifact|文件|路径|接口)[:：]\s*(.+)$/i, type: "artifact", status: "active" },
    { pattern: /^(obsolete|废弃)[:：]\s*(.+)$/i, type: "decision", status: "obsolete" },
  ];

  for (const rule of rules) {
    const match = line.match(rule.pattern);
    if (!match) {
      continue;
    }

    return {
      type: rule.type,
      content: match[2].trim(),
      status: rule.status,
      sourceTurnIds: [sourceTurnId],
    };
  }

  return null;
}

function dedupeMemoryRecords(records: MemoryRecord[]): MemoryRecord[] {
  const map = new Map<string, MemoryRecord>();
  for (const record of records) {
    const key = `${record.type}:${record.status}:${record.content.toLowerCase()}`;
    map.set(key, record);
  }
  return Array.from(map.values());
}
