import type { ContextSnapshot, MemoryRecord, MemoryState, SessionRuntimeState } from "./types.js";
export declare class FileMemoryStore {
    private readonly baseDir;
    constructor(baseDir: string);
    append(sessionId: string, records: MemoryRecord[]): Promise<void>;
    getState(sessionId: string): Promise<MemoryState>;
    writeSnapshot(sessionId: string, name: string, payload: unknown): Promise<string>;
    getRuntimeState(sessionId: string): Promise<SessionRuntimeState>;
    saveRuntimeState(sessionId: string, snapshot: ContextSnapshot): Promise<void>;
    private rebuildState;
    private getFactsPath;
    private getStatePath;
    private getRuntimePath;
}
