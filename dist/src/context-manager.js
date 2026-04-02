import { randomUUID } from "node:crypto";
import { estimateTokens } from "./tokenizer.js";
import { InstructionInjector } from "./instruction-injector.js";
import { CompactionEngine } from "./compaction-engine.js";
const DEFAULT_CONFIG = {
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
export class ContextManager {
    sessionId;
    config;
    memoryStore;
    injector;
    compactionEngine;
    messages = [];
    snapshot = {
        workingMessages: [],
        summary: null,
        compactedAt: null,
    };
    constructor(sessionId, config, options) {
        this.sessionId = sessionId;
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
        if (options.initialSnapshot) {
            this.snapshot = {
                workingMessages: [...options.initialSnapshot.workingMessages],
                summary: options.initialSnapshot.summary,
                compactedAt: options.initialSnapshot.compactedAt,
            };
            this.messages = [...options.initialSnapshot.workingMessages];
        }
    }
    async addMessage(input) {
        const message = toSessionMessage(input);
        this.messages.push(message);
        let flushed = false;
        let compacted = false;
        let remainingTokens = this.getRemainingTokens();
        if (this.config.memoryFlush.enabled &&
            remainingTokens < this.config.memoryFlush.softThresholdTokens) {
            const records = extractMemoryRecords(this.sessionId, this.messages.slice(-this.config.memoryFlush.lookbackMessages));
            if (records.length > 0) {
                await this.memoryStore.append(this.sessionId, records);
                flushed = true;
            }
        }
        const compactionTrigger = this.config.compactionTriggerTokens ??
            this.config.maxContextTokens - Math.floor(this.config.memoryFlush.softThresholdTokens / 2);
        if (this.getUsedTokens() >= compactionTrigger) {
            await this.compactInternal();
            compacted = true;
            remainingTokens = this.getRemainingTokens();
        }
        else {
            this.snapshot = {
                workingMessages: [...this.messages],
                summary: this.snapshot.summary,
                compactedAt: this.snapshot.compactedAt,
            };
            await this.memoryStore.saveRuntimeState(this.sessionId, this.snapshot);
        }
        return {
            message,
            flushed,
            compacted,
            remainingTokens,
            snapshot: this.snapshot,
        };
    }
    getSnapshot() {
        return {
            workingMessages: [...this.snapshot.workingMessages],
            summary: this.snapshot.summary,
            compactedAt: this.snapshot.compactedAt,
        };
    }
    async flushNow() {
        const records = extractMemoryRecords(this.sessionId, this.messages.slice(-this.config.memoryFlush.lookbackMessages));
        if (records.length === 0) {
            return false;
        }
        await this.memoryStore.append(this.sessionId, records);
        await this.memoryStore.saveRuntimeState(this.sessionId, this.snapshot);
        return true;
    }
    async compactNow() {
        await this.compactInternal();
        return this.getSnapshot();
    }
    getUsedTokens() {
        return this.messages.reduce((sum, message) => sum + message.tokenEstimate, 0);
    }
    getRemainingTokens() {
        return this.config.maxContextTokens - this.getUsedTokens();
    }
    async compactInternal() {
        const memoryState = await this.memoryStore.getState(this.sessionId);
        const injectedSections = this.injector.inject(this.config.postCompactionSections);
        const result = this.compactionEngine.compact(this.messages, this.config, injectedSections, memoryState);
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
        await this.memoryStore.saveRuntimeState(this.sessionId, this.snapshot);
    }
}
function toSessionMessage(input) {
    return {
        id: randomUUID(),
        role: input.role,
        content: input.content,
        timestamp: new Date().toISOString(),
        tokenEstimate: estimateTokens(input.content),
        tags: input.tags ?? [],
    };
}
function buildWorkingMessages(result, existingMessages) {
    const injected = result.injectedSections.map((section) => toSyntheticMessage("system", `[Injected:${section.section}]\n${section.content}`, ["injected-rule"]));
    const summaryMessage = toSyntheticMessage("system", result.summary, ["history-summary"]);
    const memoryMessage = toSyntheticMessage("system", renderMemoryContext(result.memoryRefs), ["memory-context"]);
    return [...injected, summaryMessage, memoryMessage, ...result.preservedTurns].map((message) => ({
        ...message,
        tokenEstimate: estimateTokens(message.content),
    }));
}
function toSyntheticMessage(role, content, tags) {
    return {
        id: randomUUID(),
        role,
        content,
        timestamp: new Date().toISOString(),
        tokenEstimate: estimateTokens(content),
        tags,
    };
}
function renderMemoryContext(records) {
    const active = records.filter((record) => record.status !== "obsolete");
    if (active.length === 0) {
        return "No active memory records.";
    }
    return [
        "Active memory records:",
        ...active.map((record) => `- [${record.type}/${record.status}] ${record.content}`),
    ].join("\n");
}
function extractMemoryRecords(sessionId, messages) {
    const records = [];
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
function parseMemoryLine(line, sourceTurnId) {
    const rules = [
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
function dedupeMemoryRecords(records) {
    const map = new Map();
    for (const record of records) {
        const key = `${record.type}:${record.status}:${record.content.toLowerCase()}`;
        map.set(key, record);
    }
    return Array.from(map.values());
}
