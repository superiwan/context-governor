import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../src/context-manager.js";
import { FileMemoryStore } from "../src/memory-store.js";
async function createManager(overrides = {}) {
    const baseDir = await mkdtemp(join(tmpdir(), "context-governor-"));
    const memoryStore = new FileMemoryStore(baseDir);
    const manager = new ContextManager("session-a", {
        maxContextTokens: 180,
        compactionTriggerTokens: 120,
        recentTurnsPreserve: 3,
        postCompactionSections: ["workflow", "handoff"],
        memoryFlush: {
            enabled: true,
            softThresholdTokens: 80,
            lookbackMessages: 10,
        },
        ...overrides,
    }, {
        memoryStore,
        instructionSources: {
            workflow: "Follow search-before-answer workflow.",
            handoff: "Use HANDOFF.md when transferring unresolved work.",
        },
    });
    return { manager, memoryStore, baseDir };
}
test("flushes high-value memory before compaction", async () => {
    const { manager, memoryStore } = await createManager();
    await manager.addMessage({
        role: "user",
        content: [
            "goal: 实现长会话上下文治理",
            "constraint: 不要引入重框架",
            "todo: 完成文件记忆存储",
            "artifact: src/context-manager.ts",
            "这里补一点额外描述让 token 更快接近阈值。",
        ].join("\n"),
    });
    const result = await manager.addMessage({
        role: "assistant",
        content: "收到，我会先把 memoryFlush 和 postCompactionSections 的链路搭起来，并继续填充一些描述以逼近阈值。",
    });
    assert.equal(result.flushed, true);
    const state = await memoryStore.getState("session-a");
    assert.equal(state.goals[0]?.content, "实现长会话上下文治理");
    assert.equal(state.constraints[0]?.content, "不要引入重框架");
    assert.equal(state.todos[0]?.content, "完成文件记忆存储");
    assert.equal(state.artifacts[0]?.content, "src/context-manager.ts");
});
test("compaction preserves injected sections and recent turns", async () => {
    const { manager } = await createManager();
    await manager.addMessage({
        role: "user",
        content: "goal: 构建上下文治理模块\nconstraint: 最近三轮不能丢\nartifact: src/index.ts",
    });
    await manager.addMessage({
        role: "assistant",
        content: "todo: 先实现 ContextManager 和 FileMemoryStore，再做压缩引擎。",
    });
    await manager.addMessage({
        role: "user",
        content: "补充一大段背景信息，让窗口继续增长，确保进入压缩阈值。这里反复说明我们需要长会话、规则保留、摘要连续性。",
    });
    await manager.addMessage({
        role: "assistant",
        content: "done: 已完成记忆抽取草图。todo: 实现规则重注入。",
    });
    const result = await manager.addMessage({
        role: "user",
        content: "最后再补一些内容，推动 compaction 发生，并保留最近 3 轮原始对话。",
    });
    assert.equal(result.compacted, true);
    const workingMessages = result.snapshot.workingMessages;
    assert.match(workingMessages[0]?.content ?? "", /Injected:workflow/);
    assert.match(workingMessages[1]?.content ?? "", /Injected:handoff/);
    assert.match(result.snapshot.summary ?? "", /## 当前目标/);
    assert.equal(workingMessages.slice(-3).every((message) => !message.tags.includes("history-summary")), true);
});
test("noise should not become active memory", async () => {
    const { manager, memoryStore } = await createManager();
    await manager.addMessage({
        role: "user",
        content: "今天天气不错，我们先随便聊两句。这段话没有结构化标签，不应该进入记忆。",
    });
    await manager.addMessage({
        role: "assistant",
        content: "好的，先轻松一下。这些内容也不应该被当作 goal 或 todo。",
    });
    await manager.addMessage({
        role: "user",
        content: [
            "goal: 开始正式任务",
            "再补一些文本，逼近 soft threshold。",
            "这里继续补充一些背景描述，确保触发 memoryFlush，同时不产生新的结构化记忆。",
        ].join("\n"),
    });
    await manager.addMessage({
        role: "assistant",
        content: "继续推进实现，这里只补充普通描述，不增加 constraint 或 todo。",
    });
    const state = await memoryStore.getState("session-a");
    assert.equal(state.constraints.length, 0);
    assert.equal(state.todos.length, 0);
    assert.equal(state.goals.length, 1);
});
test("state compaction deduplicates repeated goals and keeps done todos", async () => {
    const { manager, baseDir } = await createManager({
        maxContextTokens: 140,
        compactionTriggerTokens: 130,
        memoryFlush: {
            enabled: true,
            softThresholdTokens: 110,
            lookbackMessages: 10,
        },
    });
    await manager.addMessage({
        role: "user",
        content: "goal: 稳定长 session\ngoal: 稳定长 session\ntodo: 写 state.json\ndone: 明确目录结构",
    });
    await manager.addMessage({
        role: "assistant",
        content: [
            "constraint: 文件存储优先",
            "todo: 写 state.json",
            "补充额外说明，确保触发 soft threshold 并完成状态归并。",
        ].join("\n"),
    });
    await manager.addMessage({
        role: "user",
        content: "再补一些普通描述，帮助持久化流程真正落地。",
    });
    const statePath = join(baseDir, "session-a", "state.json");
    const raw = await readFile(statePath, "utf8");
    const state = JSON.parse(raw);
    assert.equal(state.goals.length, 1);
    assert.equal(state.todos.some((item) => item.content === "明确目录结构" && item.status === "done"), true);
});
