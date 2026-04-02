import type { MemoryRecord, MemoryState } from "./types.js";
export declare class FileMemoryStore {
    private readonly baseDir;
    constructor(baseDir: string);
    append(sessionId: string, records: MemoryRecord[]): Promise<void>;
    getState(sessionId: string): Promise<MemoryState>;
    writeSnapshot(sessionId: string, name: string, payload: unknown): Promise<string>;
    private rebuildState;
    private getFactsPath;
    private getStatePath;
}
