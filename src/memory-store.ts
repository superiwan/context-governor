import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { MemoryRecord, MemoryState } from "./types.js";

const EMPTY_STATE: MemoryState = {
  goals: [],
  constraints: [],
  decisions: [],
  todos: [],
  artifacts: [],
  updatedAt: null,
};

export class FileMemoryStore {
  constructor(private readonly baseDir: string) {}

  async append(sessionId: string, records: MemoryRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const factsPath = this.getFactsPath(sessionId);
    await mkdir(dirname(factsPath), { recursive: true });

    const payload = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    await appendFile(factsPath, payload, "utf8");
    await this.rebuildState(sessionId);
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

  async writeSnapshot(
    sessionId: string,
    name: string,
    payload: unknown,
  ): Promise<string> {
    const filePath = join(this.baseDir, sessionId, "snapshots", `${name}.json`);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
    return filePath;
  }

  private async rebuildState(sessionId: string): Promise<void> {
    const factsPath = this.getFactsPath(sessionId);
    let raw = "";
    try {
      raw = await readFile(factsPath, "utf8");
    } catch {
      raw = "";
    }

    const state = structuredClone(EMPTY_STATE);
    const bucketMap = new Map<string, MemoryRecord>();
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);

    for (const line of lines) {
      const record = JSON.parse(line) as MemoryRecord;
      const key = `${record.type}:${normalizeContent(record.content)}`;
      bucketMap.set(key, {
        ...record,
        id: record.id || randomUUID(),
      });
    }

    for (const record of bucketMap.values()) {
      if (record.status === "obsolete") {
        continue;
      }

      switch (record.type) {
        case "goal":
          state.goals.push(record);
          break;
        case "constraint":
          state.constraints.push(record);
          break;
        case "decision":
          state.decisions.push(record);
          break;
        case "todo":
          state.todos.push(record);
          break;
        case "artifact":
          state.artifacts.push(record);
          break;
      }
      state.updatedAt = record.updatedAt;
    }

    const statePath = this.getStatePath(sessionId);
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  }

  private getFactsPath(sessionId: string): string {
    return join(this.baseDir, sessionId, "facts.jsonl");
  }

  private getStatePath(sessionId: string): string {
    return join(this.baseDir, sessionId, "state.json");
  }
}

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, " ").trim().toLowerCase();
}
