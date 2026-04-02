# AGENTS.md

## Language

Respond in Chinese by default unless explicitly requested otherwise.

---

## Thinking

Use first-principles thinking:

- Start from real objectives, constraints, and current state
- Do not assume current approach is optimal
- Clarify unclear goals before proceeding
- Propose better paths if current one is inefficient

---

## Communication

Keep responses concise and practical:

- Use plain language
- Avoid unnecessary long reasoning
- For debugging, always provide:
  - problem
  - cause
  - fix

---

## Execution Principles

- Prefer small, verifiable changes
- Tie validation to real objectives
- Prefer existing toolchains
- Do not introduce new frameworks unless necessary
- Avoid over-engineering and unnecessary abstraction
- Avoid excessive defensive programming
- Prioritize efficiency and simplicity

---

## Workflow

For non-trivial tasks:

1. Define goal, scope, constraints
2. Define success criteria and validation
3. Implement
4. Validate each meaningful change
5. Summarize status and next step

---

## Global Context Governor

For non-trivial tasks and long-running coding sessions in any workspace:

- Automatically use the global context governor scripts under `C:\Users\prohibit\.codex\scripts`
- Treat this as a default workflow in the Codex app; do not wait for the user to ask
- Use the current workspace path as the session key

Initialization:

- At the start of a non-trivial task, run:
- `powershell -ExecutionPolicy Bypass -File C:\Users\prohibit\.codex\scripts\context-governor-init.ps1 -WorkspacePath "<current workspace>" -TaskName "<short task summary>"`

Resume:

- If continuing an existing task, if the user says "继续", or if the task context feels long/unclear, run:
- `powershell -ExecutionPolicy Bypass -File C:\Users\prohibit\.codex\scripts\context-governor-resume.ps1 -WorkspacePath "<current workspace>"`
- Read the resume output before proceeding

Resume from previous thread:

- If the user opens a new conversation but clearly wants to continue the previous task, adopt the previous session into the current thread before resuming
- Preferred command:
- `powershell -ExecutionPolicy Bypass -File C:\Users\prohibit\.codex\scripts\context-governor-adopt.ps1 -WorkspacePath "<current workspace>"`
- If a specific prior thread or session is known, pass `-SourceThreadId` or `-SourceSessionId`
- If no source is specified, `adopt` should auto-pick the most recently active session in the same workspace
- After adopt, read the resume output and continue from that recovered state

Flush:

- After the user confirms goals, constraints, decisions, todos, or important files/interfaces, first write them into the governor with:
- `powershell -ExecutionPolicy Bypass -File C:\Users\prohibit\.codex\scripts\context-governor-checkpoint.ps1 -WorkspacePath "<current workspace>" -Goal "<...>" -Constraint "<...>" -Decision "<...>" -Todo "<...>" -Done "<...>" -Artifact "<...>" -FlushAfter`
- Use only the fields that actually apply; do not invent empty fields
- At the end of each meaningful phase, if facts were already checkpointed, you may also run:
- `powershell -ExecutionPolicy Bypass -File C:\Users\prohibit\.codex\scripts\context-governor-flush.ps1 -WorkspacePath "<current workspace>"`

Compact:

- Before handoff, before switching subtasks, when the session is getting long, or before a large output likely to push context size, run:
- `powershell -ExecutionPolicy Bypass -File C:\Users\prohibit\.codex\scripts\context-governor-compact.ps1 -WorkspacePath "<current workspace>"`

Memory writing rules:

- Prefer writing key facts in structured form inside your own working notes or messages:
- `goal:`
- `constraint:`
- `decision:`
- `todo:`
- `done:`
- `artifact:`
- Only persist confirmed facts, not guesses or casual chat
- When possible, checkpoint concise structured items instead of long prose
