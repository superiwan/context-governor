import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  ContextSnapshot,
  MemoryMutationSummary,
  MemoryRecord,
  MemoryRetentionConfig,
  MemoryState,
  SessionRuntimeState,
} from "./types.js";

const EMPTY_STATE: MemoryState = {
  goals: [],
  constraints: [],
  decisions: [],
  todos: [],
  artifacts: [],
  updatedAt: null,
};

const EMPTY_RUNTIME: SessionRuntimeState = {
  snapshot: {
    workingMessages: [],
    summary: null,
    compactedAt: null,
  },
  pendingCompaction: {
    constraints: [],
    artifacts: [],
  },
  processedMessageIds: [],
};

const RESERVED_SESSION_DIRS = new Set(["snapshots"]);

export class FileMemoryStore {
  constructor(private readonly baseDir: string) {}

  async applyRecords(
    sessionId: string,
    records: MemoryRecord[],
    phase: "flush" | "compact",
    retention: MemoryRetentionConfig,
  ): Promise<MemoryMutationSummary> {
    if (records.length === 0 && phase !== "compact") {
      return emptyMutation();
    }

    const state = await this.getState(sessionId);
    const runtime = await this.getRuntimeState(sessionId);
    const deduped = dedupeRecords(records);
    const summary = emptyMutation();

    const latestGoal = latestRecord(deduped, "goal");
    if (latestGoal) {
      summary.replaced += state.goals.length;
      summary.inserted += 1;
      state.goals = [latestGoal];
      state.updatedAt = latestGoal.updatedAt;
    }

    const latestDecision = latestDecisionRecord(deduped);
    if (latestDecision) {
      summary.replaced += state.decisions.length;
      if (latestDecision.status === "obsolete") {
        summary.deleted += state.decisions.length;
        state.decisions = [];
      } else {
        summary.inserted += 1;
        state.decisions = [latestDecision];
        state.updatedAt = latestDecision.updatedAt;
      }
    }

    const todoSummary = mergeTodos(state.todos, deduped);
    state.todos = todoSummary.todos;
    summary.inserted += todoSummary.summary.inserted;
    summary.replaced += todoSummary.summary.replaced;
    summary.deleted += todoSummary.summary.deleted;
    if (todoSummary.updatedAt) {
      state.updatedAt = todoSummary.updatedAt;
    }

    const incomingConstraints = bucketRecords(deduped, "constraint");
    if (incomingConstraints.length > 0) {
      runtime.pendingCompaction.constraints = mergeRecordSet(
        runtime.pendingCompaction.constraints,
        incomingConstraints,
      );
      summary.inserted += incomingConstraints.length;
      state.updatedAt = incomingConstraints.at(-1)?.updatedAt ?? state.updatedAt;
    }

    const incomingArtifacts = bucketRecords(deduped, "artifact");
    if (incomingArtifacts.length > 0) {
      runtime.pendingCompaction.artifacts = mergeRecordSet(
        runtime.pendingCompaction.artifacts,
        incomingArtifacts,
      );
      summary.inserted += incomingArtifacts.length;
      state.updatedAt = incomingArtifacts.at(-1)?.updatedAt ?? state.updatedAt;
    }

    if (phase === "compact") {
      if (runtime.pendingCompaction.constraints.length > 0) {
        summary.deleted += state.constraints.length;
        summary.finalized += runtime.pendingCompaction.constraints.length;
        state.constraints = mergeRecordSet([], runtime.pendingCompaction.constraints);
        runtime.pendingCompaction.constraints = [];
      }

      if (runtime.pendingCompaction.artifacts.length > 0) {
        summary.deleted += state.artifacts.length;
        summary.finalized += runtime.pendingCompaction.artifacts.length;
        state.artifacts = mergeRecordSet([], runtime.pendingCompaction.artifacts);
        runtime.pendingCompaction.artifacts = [];
      }
    }

    await this.writeState(sessionId, state);
    await this.writeFacts(sessionId, state, retention.keepDebugFacts);
    await this.saveRuntimeState(sessionId, runtime.snapshot, runtime.pendingCompaction);
    return summary;
  }

  async getState(sessionId: string): Promise<MemoryState> {
    const statePath = this.getStatePath(sessionId);
    try {
      const raw = await readFile(statePath, "utf8");
      return JSON.parse(raw) as MemoryState;
    } catch {
      return structuredClone(EMPTY_STATE);
    }
  }

  async writeSnapshot(sessionId: string, name: string, payload: unknown): Promise<string> {
    const filePath = join(this.baseDir, sessionId, "snapshots", `${name}.json`);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
    return filePath;
  }

  async pruneSnapshots(sessionId: string, maxSnapshots: number): Promise<number> {
    const snapshotsDir = join(this.baseDir, sessionId, "snapshots");
    if (maxSnapshots < 1) {
      return 0;
    }

    let entries;
    try {
      entries = await readdir(snapshotsDir, { withFileTypes: true });
    } catch {
      return 0;
    }

    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const fullPath = join(snapshotsDir, entry.name);
          const info = await stat(fullPath);
          return {
            fullPath,
            mtimeMs: info.mtimeMs,
          };
        }),
    );

    if (files.length <= maxSnapshots) {
      return 0;
    }

    files.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const stale = files.slice(maxSnapshots);
    for (const file of stale) {
      await rm(file.fullPath, { force: true });
    }

    return stale.length;
  }

  async pruneSessions(days: number): Promise<{ deletedSessions: string[] }> {
    if (days < 0) {
      return { deletedSessions: [] };
    }

    const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
    let entries;
    try {
      entries = await readdir(this.baseDir, { withFileTypes: true });
    } catch {
      return { deletedSessions: [] };
    }

    const deletedSessions: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || RESERVED_SESSION_DIRS.has(entry.name)) {
        continue;
      }

      const sessionDir = join(this.baseDir, entry.name);
      const markerPath = this.getStatePath(entry.name);
      const candidatePath = await selectExistingPath([markerPath, this.getRuntimePath(entry.name), sessionDir]);
      if (!candidatePath) {
        continue;
      }

      const info = await stat(candidatePath);
      if (info.mtimeMs >= threshold) {
        continue;
      }

      await rm(sessionDir, { recursive: true, force: true });
      deletedSessions.push(entry.name);
    }

    return { deletedSessions };
  }

  async getRuntimeState(sessionId: string): Promise<SessionRuntimeState> {
    const runtimePath = this.getRuntimePath(sessionId);
    try {
      const raw = await readFile(runtimePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SessionRuntimeState>;
      return {
        snapshot: parsed.snapshot ?? structuredClone(EMPTY_RUNTIME.snapshot),
        pendingCompaction: {
          constraints: parsed.pendingCompaction?.constraints ?? [],
          artifacts: parsed.pendingCompaction?.artifacts ?? [],
        },
        processedMessageIds: parsed.processedMessageIds ?? [],
      };
    } catch {
      return structuredClone(EMPTY_RUNTIME);
    }
  }

  async saveRuntimeState(
    sessionId: string,
    snapshot: ContextSnapshot,
    pendingCompaction?: SessionRuntimeState["pendingCompaction"],
    processedMessageIds?: string[],
  ): Promise<void> {
    const runtimePath = this.getRuntimePath(sessionId);
    const existing = await this.getRuntimeState(sessionId);
    const effectivePending = pendingCompaction ?? existing.pendingCompaction;
    const effectiveProcessedMessageIds = processedMessageIds ?? existing.processedMessageIds;
    await mkdir(dirname(runtimePath), { recursive: true });
    await writeFile(
      runtimePath,
      JSON.stringify(
        {
          snapshot,
          pendingCompaction: effectivePending,
          processedMessageIds: effectiveProcessedMessageIds,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  private async writeState(sessionId: string, state: MemoryState): Promise<void> {
    const statePath = this.getStatePath(sessionId);
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  }

  private async writeFacts(
    sessionId: string,
    state: MemoryState,
    keepDebugFacts: boolean,
  ): Promise<void> {
    const factsPath = this.getFactsPath(sessionId);
    if (!keepDebugFacts) {
      await rm(factsPath, { force: true });
      return;
    }

    const payload = flattenState(state)
      .map((record) => JSON.stringify(record))
      .join("\n");
    await mkdir(dirname(factsPath), { recursive: true });
    await writeFile(factsPath, payload.length > 0 ? `${payload}\n` : "", "utf8");
  }

  private getFactsPath(sessionId: string): string {
    return join(this.baseDir, sessionId, "facts.jsonl");
  }

  private getStatePath(sessionId: string): string {
    return join(this.baseDir, sessionId, "state.json");
  }

  private getRuntimePath(sessionId: string): string {
    return join(this.baseDir, sessionId, "context.json");
  }
}

function emptyMutation(): MemoryMutationSummary {
  return {
    inserted: 0,
    replaced: 0,
    deleted: 0,
    finalized: 0,
  };
}

function dedupeRecords(records: MemoryRecord[]): MemoryRecord[] {
  const map = new Map<string, MemoryRecord>();
  for (const record of records) {
    const key = `${record.type}:${record.status}:${normalizeContent(record.content)}`;
    map.set(key, record);
  }
  return Array.from(map.values());
}

function latestRecord(records: MemoryRecord[], type: MemoryRecord["type"]): MemoryRecord | null {
  const bucket = bucketRecords(records, type).filter((record) => record.status !== "obsolete");
  return bucket.at(-1) ?? null;
}

function latestDecisionRecord(records: MemoryRecord[]): MemoryRecord | null {
  const bucket = bucketRecords(records, "decision");
  return bucket.at(-1) ?? null;
}

function bucketRecords(records: MemoryRecord[], type: MemoryRecord["type"]): MemoryRecord[] {
  return records.filter((record) => record.type === type);
}

function mergeTodos(
  currentTodos: MemoryRecord[],
  incomingRecords: MemoryRecord[],
): { todos: MemoryRecord[]; summary: MemoryMutationSummary; updatedAt: string | null } {
  const summary = emptyMutation();
  const map = new Map<string, MemoryRecord>();
  let updatedAt: string | null = null;

  for (const todo of currentTodos) {
    map.set(normalizeContent(todo.content), todo);
  }

  for (const record of bucketRecords(incomingRecords, "todo")) {
    const key = normalizeContent(record.content);
    if (map.has(key)) {
      summary.replaced += 1;
    } else {
      summary.inserted += 1;
    }
    map.set(key, record);
    updatedAt = record.updatedAt;
  }

  return {
    todos: Array.from(map.values()),
    summary,
    updatedAt,
  };
}

function mergeRecordSet(existing: MemoryRecord[], incoming: MemoryRecord[]): MemoryRecord[] {
  const map = new Map<string, MemoryRecord>();
  for (const record of [...existing, ...incoming]) {
    if (record.status === "obsolete") {
      continue;
    }
    map.set(normalizeContent(record.content), record);
  }
  return Array.from(map.values());
}

function flattenState(state: MemoryState): MemoryRecord[] {
  return [
    ...state.goals,
    ...state.constraints,
    ...state.decisions,
    ...state.todos,
    ...state.artifacts,
  ];
}

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, " ").trim().toLowerCase();
}

async function selectExistingPath(paths: string[]): Promise<string | null> {
  for (const candidate of paths) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}
