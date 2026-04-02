import type { CompactionConfig, CompactionResult, InjectedSection, MemoryState, SessionMessage } from "./types.js";
import { SummaryAuditor } from "./summary-auditor.js";
export declare class CompactionEngine {
    private readonly auditor;
    constructor(auditor?: SummaryAuditor);
    compact(messages: SessionMessage[], config: CompactionConfig, injectedSections: InjectedSection[], memoryState: MemoryState): CompactionResult;
}
