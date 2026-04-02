# Context Governor

面向长会话 Agent 的上下文治理中间层，用来解决 4 类典型问题：

- 压缩前，关键事实还没落盘
- 压缩后，行为规则和工作流丢失
- 最近几轮对话断片
- 摘要质量不稳定，导致长 session 越跑越偏

第一版提供：

- `memoryFlush`：接近上下文上限时，把高价值事实写入持久记忆
- `postCompactionSections`：压缩后重注入关键规则章节
- `recentTurnsPreserve`：保留最近若干轮原始对话
- `qualityGuard`：轻量摘要结构审计接口

## 它是怎么工作的

核心链路是：

1. `init`：为当前 session 建立治理目录和规则
2. `resume`：恢复当前目标、约束、待办、规则和最近上下文
3. `checkpoint`：把刚确认的重要事实写成结构化条目
4. `flush`：把这些事实持久化到记忆文件
5. `compact`：在会话变长时重建一个可继续执行的短上下文
6. 下次继续任务时再次 `resume`

可以把它理解成一条“长会话防失忆流水线”：

```mermaid
flowchart TD
    A["开始长任务"] --> B["init"]
    B --> C["resume"]
    C --> D["正常工作"]
    D --> E["checkpoint 关键事实"]
    E --> F["flush 到持久记忆"]
    D --> G["上下文变长 / 切子任务 / 准备交接"]
    G --> H["compact"]
    H --> I["生成 summary + 更新 context"]
    I --> J["继续工作"]
    J --> C
```

## 在 Codex 应用里的真实使用方式

这套现在已经接成“用户级全局工作流”，重点是：

- 不是写进某个工程仓库
- 不是要求你手动开 CLI
- 而是通过全局 `AGENTS.md` + 全局 PowerShell 脚本，让 Codex 应用里的 agent 自己去调用

全局入口在：

- 用户级规则：[C:\Users\prohibit\.codex\AGENTS.md](C:\Users\prohibit\.codex\AGENTS.md)
- 用户级脚本目录：`C:\Users\prohibit\.codex\scripts`

当前已经接好的全局脚本有：

- `context-governor-init.ps1`
- `context-governor-resume.ps1`
- `context-governor-checkpoint.ps1`
- `context-governor-flush.ps1`
- `context-governor-compact.ps1`

Codex 应用里的默认工作节奏是：

1. 打开任意工程，开始一个非简单任务
2. agent 先初始化当前 workspace 的 governor session
3. 如果是“继续刚才任务”，先做 `resume`
4. 用户确认了目标、约束、待办、关键文件后，agent 做 `checkpoint`
5. 阶段结束时 `flush`
6. 会话变长、切子任务、准备交接时 `compact`

## 文件会存到哪里

默认不会把治理文件写进你的工程目录，也不会污染 Git 仓库。

统一存到用户目录：

`C:\Users\prohibit\.codex\memories\context-governor`

结构大致如下：

```text
C:\Users\prohibit\.codex\memories\context-governor\
  workspace-sessions.json
  <sessionId>\
    config.json
    instructions.json
    context.json
    facts.jsonl
    state.json
    workspace-brief.md
    snapshots\
```

各文件作用：

- `workspace-sessions.json`
  - 记录“某个 workspace 当前对应哪个 sessionId”
- `facts.jsonl`
  - 原始增量记忆账本
- `state.json`
  - 当前聚合后的有效记忆视图
- `context.json`
  - 当前工作上下文快照
- `instructions.json`
  - 压缩后需要重新注入的规则
- `snapshots/`
  - compaction 前后的快照

## 真实使用场景举例

### 例子 1：在 Codex 应用里做一个长代码任务

场景：

- 你在 Codex 应用里打开某个工程
- 让它连续做一个超过 30 轮的重构任务

实际流程：

1. agent 先为当前 workspace 建一个 session
2. 当你确认目标时，agent 会把类似下面的信息 checkpoint 进去：

```text
goal: 重构上下文治理模块
constraint: 不引入新框架
todo: 先打通 flush 和 compact 主链路
artifact: src/context-manager.ts
```

3. 阶段结束时，agent 会把这些结构化事实 flush 到持久记忆
4. 当会话变长时，agent 会 compact，保留规则、summary、active memory 和最近几轮对话
5. 你下次说“继续刚才任务”，agent 先 resume，再继续工作

结果：

- 即使聊天上下文变长
- 目标、约束、待办、关键文件仍然能从全局记忆里恢复

### 例子 2：同一个工程第二天继续

场景：

- 昨天在 `D:\ai_project` 里做了一半
- 今天重新打开 Codex 应用，继续同一个工程

实际流程：

1. agent 通过 workspace 路径查 `workspace-sessions.json`
2. 找到对应的 `sessionId`
3. 执行 `resume`
4. 从 `state.json + context.json + instructions.json` 里恢复：
   - 当前目标
   - 已确认约束
   - 未完成事项
   - 规则和工作方式

结果：

- 不需要完全依赖聊天窗口剩余上下文
- 长任务续接更稳

### 例子 3：你想确认这套机制有没有真的生效

最直接的检查路径：

1. 看 `workspace-sessions.json` 里有没有当前工程路径
2. 看对应 session 目录有没有生成
3. 看 `facts.jsonl` 里有没有 `goal / constraint / todo / artifact`
4. 看 `state.json` 里有没有 active memory
5. 看 `context.json` 是否在 compaction 后更新

一个真实的 `resume` 输出会像这样：

```text
# Session Resume: 20260402-164249-global-app-smoke

## Rules
- output: 输出简洁，优先状态、原因、修复、下一步。
- memory: 只持久化已确认的 goal、constraint、decision、todo、artifact，不写猜测。

## Active Memory
- [goal] 让 Codex 应用全局自动使用上下文治理
- [constraint] 用户不手动使用 CLI
- [todo/active] 通过全局 AGENTS 和脚本驱动自动调用
```

## CLI 和脚本层

虽然你在应用里不需要自己用 CLI，但底层模块仍然提供 CLI，方便调试或二次集成。

先构建：

```bash
npm install
npm run build
```

基础命令：

```bash
node dist/src/cli.js init --session demo --memoryDir ../context-governor-memory
node dist/src/cli.js append --session demo --memoryDir ../context-governor-memory --role user --content "goal: 实现长会话治理"
node dist/src/cli.js flush --session demo --memoryDir ../context-governor-memory
node dist/src/cli.js compact --session demo --memoryDir ../context-governor-memory
node dist/src/cli.js resume --session demo --memoryDir ../context-governor-memory
```

## 最小代码接入

如果你不是走 Codex 应用，而是想把它作为模块接到自己的 Agent 编排层，可以直接使用：

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
- CLI / 脚本模式下，当前工作上下文会写入 `context.json`，用于跨命令续接
- 现在的“应用端自动调用”本质上是全局工作流自动化，不是直接改写 Codex 内核压缩器

## 配合 Codex 使用

如果你想看当前这套全局接法本身的文件位置：

- 全局规则：[C:\Users\prohibit\.codex\AGENTS.md](C:\Users\prohibit\.codex\AGENTS.md)
- 全局脚本目录：`C:\Users\prohibit\.codex\scripts`
- 全局记忆目录：`C:\Users\prohibit\.codex\memories\context-governor`

如果你想看项目侧包装：

- 启动脚本：[start-codex-session.ps1](D:\ai_project\scripts\start-codex-session.ps1)
- 项目级规则示例：[AGENTS.md](D:\ai_project\AGENTS.md)
