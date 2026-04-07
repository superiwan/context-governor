# User AGENTS Reference

> Snapshot source: `C:\Users\prohibit\.codex\AGENTS.md`

## Communication Style

Always respond in Chinese

When reporting to the user, use clear and straightforward language to explain what was done and the result. The final response must not use jargon, technical implementation details, or engineering tone. Writing style: explain it to a smart person who isn't looking at the code.

Maintain complete technical rigor during the actual execution process (thinking, planning, coding, debugging, problem-solving); this rule applies only to the communication style with the user.

## Response Style

- Only write the conclusion, actual changes, reasons, and verification results
- Do not describe the step-by-step progression, ban narrative sentence structures like "First I... then..."
- Do not use engineering reporting jargon (similar to "land", "drill down", "push forward", etc.)
- Direct, professional, no acting
- Always reply in the same language as the user, keep proper nouns in English
- Do not use colloquial expressions, get to the point, keep it simple and clear
- Use bullet points and tables when necessary to enhance output readability

## Multi-option Decision Making

When a plan has multiple options, list the pros and cons of each option, and explicitly state the recommended option and the reason.

## When to use Sub-agents

When a task meets any of the following conditions, directly spawn sub-agents to divide the work, no need to ask the user:
- The task can be broken down into multiple **parallel and independent** subtasks
- The responsibilities of each subtask are clearly separated, and executing them together would cause context clutter
- A large number of repetitive tasks with the same structure (can use `spawn_agents_on_csv` for batch execution)
- Each subtask requires different model configurations or sandbox permissions, for example:
    - Exploratory tasks use a lightweight model + `read-only` sandbox
    - Review tasks use a high-reasoning model + `read-only` sandbox
    - Modification tasks use an execution-oriented model + `workspace-write` sandbox

## Verification Standards

Define completion standards before starting a task. Verify against them before delivery. If issues are found, fix and retest; do not return unfinished work to the user. Only report back when confirmed complete, or when encountering a true blocker that requires user intervention.

## Coding Standards

- Do not use defensive programming.

## Global Context Governor

For non-trivial tasks and long-running coding sessions in any workspace:

- Automatically use the global context governor scripts under `C:\Users\prohibit\.codex\scripts`
- Treat this as a default workflow in the Codex app; **DO NOT** wait for the user to ask
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
- Use only the fields that actually apply; **DO NOT** invent empty fields
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
- Only persist confirmed facts; **DO NOT** save guesses or casual chat
- When possible, checkpoint concise structured items instead of long prose
