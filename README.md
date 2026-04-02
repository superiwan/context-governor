# Context Governor

面向长会话 Agent 的上下文治理中间层，第一版提供：

- `memoryFlush`：在接近上下文上限时，把高价值事实写入文件记忆
- `postCompactionSections`：压缩后重注入关键规则章节
- `recentTurnsPreserve`：保留最近若干轮原始对话
- `qualityGuard`：轻量摘要结构审计接口

## 安装

```bash
npm install
```

## 运行测试

```bash
npm test
```

## 目录结构

```text
memory/<sessionId>/
  facts.jsonl
  state.json
  snapshots/
```

## 最小用法

```ts
import { ContextManager, FileMemoryStore } from "./src/index.js";

const memoryStore = new FileMemoryStore("./memory");

const manager = new ContextManager(
  "session-1",
  {
    maxContextTokens: 24000,
    recentTurnsPreserve: 5,
    postCompactionSections: ["workflow", "handoff"],
    memoryFlush: {
      enabled: true,
      softThresholdTokens: 4000,
      lookbackMessages: 8,
    },
    qualityGuard: {
      enabled: true,
      maxRetries: 0,
    },
  },
  {
    memoryStore,
    instructionSources: {
      workflow: "Always search before answering when repo context is missing.",
      handoff: "Summarize unresolved work before yielding to another agent.",
    },
  },
);

await manager.addMessage({
  role: "user",
  content: "goal: 实现长会话上下文治理\ntodo: 写入文件记忆",
});
```

## 当前约束

- token 估算使用近似算法，不绑定具体模型 tokenizer
- 记忆抽取优先依赖结构化前缀，如 `goal:`、`todo:`、`constraint:`
- `qualityGuard` 目前只做结构完整性校验，不做重生成闭环
