import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
const EMPTY_STATE = {
    goals: [],
    constraints: [],
    decisions: [],
    todos: [],
    artifacts: [],
    updatedAt: null,
};
export class FileMemoryStore {
    baseDir;
    constructor(baseDir) {
        this.baseDir = baseDir;
    }
    async append(sessionId, records) {
        if (records.length === 0) {
            return;
        }
        const factsPath = this.getFactsPath(sessionId);
        await mkdir(dirname(factsPath), { recursive: true });
        const payload = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
        await appendFile(factsPath, payload, "utf8");
        await this.rebuildState(sessionId);
    }
    async getState(sessionId) {
        const statePath = this.getStatePath(sessionId);
        try {
            const raw = await readFile(statePath, "utf8");
            return JSON.parse(raw);
        }
        catch {
            return structuredClone(EMPTY_STATE);
        }
    }
    async writeSnapshot(sessionId, name, payload) {
        const filePath = join(this.baseDir, sessionId, "snapshots", `${name}.json`);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
        return filePath;
    }
    async getRuntimeState(sessionId) {
        const runtimePath = this.getRuntimePath(sessionId);
        try {
            const raw = await readFile(runtimePath, "utf8");
            return JSON.parse(raw);
        }
        catch {
            return {
                snapshot: {
                    workingMessages: [],
                    summary: null,
                    compactedAt: null,
                },
            };
        }
    }
    async saveRuntimeState(sessionId, snapshot) {
        const runtimePath = this.getRuntimePath(sessionId);
        await mkdir(dirname(runtimePath), { recursive: true });
        await writeFile(runtimePath, JSON.stringify({ snapshot }, null, 2), "utf8");
    }
    async rebuildState(sessionId) {
        const factsPath = this.getFactsPath(sessionId);
        let raw = "";
        try {
            raw = await readFile(factsPath, "utf8");
        }
        catch {
            raw = "";
        }
        const state = structuredClone(EMPTY_STATE);
        const bucketMap = new Map();
        const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
        for (const line of lines) {
            const record = JSON.parse(line);
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
    getFactsPath(sessionId) {
        return join(this.baseDir, sessionId, "facts.jsonl");
    }
    getStatePath(sessionId) {
        return join(this.baseDir, sessionId, "state.json");
    }
    getRuntimePath(sessionId) {
        return join(this.baseDir, sessionId, "context.json");
    }
}
function normalizeContent(content) {
    return content.replace(/\s+/g, " ").trim().toLowerCase();
}
