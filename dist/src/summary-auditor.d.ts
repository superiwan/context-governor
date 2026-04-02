import type { MemoryRecord, SummaryAuditResult } from "./types.js";
export declare class SummaryAuditor {
    audit(summary: string, activeTodos: MemoryRecord[]): SummaryAuditResult;
}
