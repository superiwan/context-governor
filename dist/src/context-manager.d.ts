import type { CompactionConfig, ContextSnapshot, ContextUpdateResult, IncomingMessage } from "./types.js";
import { FileMemoryStore } from "./memory-store.js";
import { CompactionEngine } from "./compaction-engine.js";
interface ContextManagerOptions {
    memoryStore: FileMemoryStore;
    instructionSources?: Record<string, string>;
    compactionEngine?: CompactionEngine;
    initialSnapshot?: ContextSnapshot;
}
export declare class ContextManager {
    private readonly sessionId;
    private readonly config;
    private readonly memoryStore;
    private readonly injector;
    private readonly compactionEngine;
    private messages;
    private snapshot;
    constructor(sessionId: string, config: Partial<CompactionConfig>, options: ContextManagerOptions);
    addMessage(input: IncomingMessage): Promise<ContextUpdateResult>;
    getSnapshot(): ContextSnapshot;
    flushNow(): Promise<boolean>;
    compactNow(): Promise<ContextSnapshot>;
    private getUsedTokens;
    private getRemainingTokens;
    private compactInternal;
}
export {};
