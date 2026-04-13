export type MessageRole = "system" | "user" | "assistant" | "tool";

export type MemoryRecordType =
  | "goal"
  | "constraint"
  | "decision"
  | "todo"
  | "artifact";

export type MemoryRecordStatus = "active" | "done" | "obsolete";

export interface SessionMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  tokenEstimate: number;
  tags: string[];
}

export interface IncomingMessage {
  role: MessageRole;
  content: string;
  tags?: string[];
}

export interface MemoryRecord {
  id: string;
  sessionId: string;
  type: MemoryRecordType;
  content: string;
  status: MemoryRecordStatus;
  sourceTurnIds: string[];
  updatedAt: string;
}

export interface MemoryState {
  goals: MemoryRecord[];
  constraints: MemoryRecord[];
  decisions: MemoryRecord[];
  todos: MemoryRecord[];
  artifacts: MemoryRecord[];
  updatedAt: string | null;
}

export interface MemoryFlushConfig {
  enabled: boolean;
  softThresholdTokens: number;
  lookbackMessages: number;
}

export interface MemoryRetentionConfig {
  keepDebugFacts: boolean;
  maxSnapshots: number;
  pruneSessionsAfterDays: number;
}

export interface QualityGuardConfig {
  enabled: boolean;
  maxRetries: number;
}

export interface CompactionConfig {
  maxContextTokens: number;
  compactionTriggerTokens?: number;
  recentTurnsPreserve: number;
  postCompactionSections: string[];
  memoryFlush: MemoryFlushConfig;
  qualityGuard: QualityGuardConfig;
  memoryRetention: MemoryRetentionConfig;
}

export interface SummaryAuditResult {
  passed: boolean;
  findings: string[];
  requiredSections: string[];
}

export interface CompactionResult {
  summary: string;
  preservedTurns: SessionMessage[];
  injectedSections: InjectedSection[];
  memoryRefs: MemoryRecord[];
  audit: SummaryAuditResult;
}

export interface InjectedSection {
  section: string;
  content: string;
}

export interface ContextSnapshot {
  workingMessages: SessionMessage[];
  summary: string | null;
  compactedAt: string | null;
}

export interface SessionRuntimeState {
  snapshot: ContextSnapshot;
  pendingCompaction: {
    constraints: MemoryRecord[];
    artifacts: MemoryRecord[];
  };
  processedMessageIds: string[];
}

export interface MemoryMutationSummary {
  inserted: number;
  replaced: number;
  deleted: number;
  finalized: number;
}

export interface ContextUpdateResult {
  message: SessionMessage;
  flushed: boolean;
  compacted: boolean;
  remainingTokens: number;
  snapshot: ContextSnapshot;
  memoryMutation?: MemoryMutationSummary | null;
}
