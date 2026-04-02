#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ContextManager } from "./context-manager.js";
import { FileMemoryStore } from "./memory-store.js";
import type { CompactionConfig, IncomingMessage } from "./types.js";

type CommandName = "init" | "append" | "flush" | "compact" | "resume";

interface ParsedArgs {
  command: CommandName;
  options: Record<string, string | boolean>;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const memoryDir = resolve(cwd, getString(parsed.options, "memoryDir", "memory"));

  switch (parsed.command) {
    case "init":
      await handleInit(memoryDir, parsed.options);
      break;
    case "append":
      await handleAppend(memoryDir, parsed.options);
      break;
    case "flush":
      await handleFlush(memoryDir, parsed.options);
      break;
    case "compact":
      await handleCompact(memoryDir, parsed.options);
      break;
    case "resume":
      await handleResume(memoryDir, parsed.options);
      break;
  }
}

async function handleInit(memoryDir: string, options: Record<string, string | boolean>): Promise<void> {
  const sessionId = getRequired(options, "session");
  const config = buildConfig(options);
  const store = new FileMemoryStore(memoryDir);
  await mkdir(join(memoryDir, sessionId, "snapshots"), { recursive: true });
  await store.saveRuntimeState(sessionId, {
    workingMessages: [],
    summary: null,
    compactedAt: null,
  });
  await writeJson(join(memoryDir, sessionId, "config.json"), config);
  await writeJson(join(memoryDir, sessionId, "instructions.json"), await loadInstructionSources(options));
  printJson({
    ok: true,
    command: "init",
    sessionId,
    memoryDir,
  });
}

async function handleAppend(memoryDir: string, options: Record<string, string | boolean>): Promise<void> {
  const sessionId = getRequired(options, "session");
  const manager = await loadManager(memoryDir, sessionId);
  const message: IncomingMessage = {
    role: getString(options, "role", "user") as IncomingMessage["role"],
    content: await loadContent(options),
    tags: splitCsv(getString(options, "tags", "")),
  };
  const result = await manager.addMessage(message);
  printJson({
    ok: true,
    command: "append",
    sessionId,
    flushed: result.flushed,
    compacted: result.compacted,
    remainingTokens: result.remainingTokens,
  });
}

async function handleFlush(memoryDir: string, options: Record<string, string | boolean>): Promise<void> {
  const sessionId = getRequired(options, "session");
  const manager = await loadManager(memoryDir, sessionId);
  const flushed = await manager.flushNow();
  printJson({
    ok: true,
    command: "flush",
    sessionId,
    flushed,
  });
}

async function handleCompact(memoryDir: string, options: Record<string, string | boolean>): Promise<void> {
  const sessionId = getRequired(options, "session");
  const manager = await loadManager(memoryDir, sessionId);
  const snapshot = await manager.compactNow();
  printJson({
    ok: true,
    command: "compact",
    sessionId,
    compactedAt: snapshot.compactedAt,
    workingMessages: snapshot.workingMessages.length,
  });
}

async function handleResume(memoryDir: string, options: Record<string, string | boolean>): Promise<void> {
  const sessionId = getRequired(options, "session");
  const store = new FileMemoryStore(memoryDir);
  const runtime = await store.getRuntimeState(sessionId);
  const state = await store.getState(sessionId);
  const instructions = await readJson<Record<string, string>>(
    join(memoryDir, sessionId, "instructions.json"),
    {},
  );

  const lines = [
    `# Session Resume: ${sessionId}`,
    "",
    "## Rules",
    ...renderKeyValueRules(instructions),
    "",
    "## Summary",
    runtime.snapshot.summary ?? "- no summary yet",
    "",
    "## Active Memory",
    ...renderState(state),
    "",
    "## Recent Turns",
    ...runtime.snapshot.workingMessages.slice(-5).map((message) => `- [${message.role}] ${firstLine(message.content)}`),
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

async function loadManager(memoryDir: string, sessionId: string): Promise<ContextManager> {
  const store = new FileMemoryStore(memoryDir);
  const runtime = await store.getRuntimeState(sessionId);
  const config = await readJson<CompactionConfig>(
    join(memoryDir, sessionId, "config.json"),
    defaultConfig(),
  );
  const instructions = await readJson<Record<string, string>>(
    join(memoryDir, sessionId, "instructions.json"),
    {},
  );

  return new ContextManager(sessionId, config, {
    memoryStore: store,
    instructionSources: instructions,
    initialSnapshot: runtime.snapshot,
  });
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command || !["init", "append", "flush", "compact", "resume"].includes(command)) {
    throw new Error("Usage: context-governor <init|append|flush|compact|resume> [options]");
  }

  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const item = rest[i];
    if (!item.startsWith("--")) {
      continue;
    }

    const key = item.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    i += 1;
  }

  return {
    command: command as CommandName,
    options,
  };
}

async function loadInstructionSources(
  options: Record<string, string | boolean>,
): Promise<Record<string, string>> {
  const sectionsPath = options.sectionsFile;
  if (typeof sectionsPath === "string") {
    return readJson<Record<string, string>>(resolve(process.cwd(), sectionsPath), {});
  }

  return {
    workflow: "Search before answering when repo truth is required.",
    handoff: "Update HANDOFF with unresolved work before yielding.",
    memory: "Persist confirmed goals, constraints, decisions, and todos.",
    output: "Keep outputs concise and action-oriented.",
  };
}

async function loadContent(options: Record<string, string | boolean>): Promise<string> {
  const file = options.file;
  if (typeof file === "string") {
    return readFile(resolve(process.cwd(), file), "utf8");
  }

  const inline = options.content;
  if (typeof inline === "string") {
    return inline;
  }

  throw new Error("append command requires --file or --content");
}

function buildConfig(options: Record<string, string | boolean>): CompactionConfig {
  const base = defaultConfig();
  return {
    ...base,
    maxContextTokens: getNumber(options, "maxContextTokens", base.maxContextTokens),
    compactionTriggerTokens: getNumber(
      options,
      "compactionTriggerTokens",
      base.compactionTriggerTokens ?? base.maxContextTokens - 2000,
    ),
    recentTurnsPreserve: getNumber(options, "recentTurnsPreserve", base.recentTurnsPreserve),
    postCompactionSections: splitCsv(
      getString(options, "postCompactionSections", base.postCompactionSections.join(",")),
    ),
    memoryFlush: {
      ...base.memoryFlush,
      softThresholdTokens: getNumber(
        options,
        "softThresholdTokens",
        base.memoryFlush.softThresholdTokens,
      ),
      lookbackMessages: getNumber(
        options,
        "lookbackMessages",
        base.memoryFlush.lookbackMessages,
      ),
    },
    qualityGuard: {
      ...base.qualityGuard,
      maxRetries: getNumber(options, "maxRetries", base.qualityGuard.maxRetries),
    },
  };
}

function defaultConfig(): CompactionConfig {
  return {
    maxContextTokens: 24000,
    compactionTriggerTokens: 22000,
    recentTurnsPreserve: 5,
    postCompactionSections: ["workflow", "handoff", "memory", "output"],
    memoryFlush: {
      enabled: true,
      softThresholdTokens: 4000,
      lookbackMessages: 8,
    },
    qualityGuard: {
      enabled: true,
      maxRetries: 0,
    },
  };
}

function getRequired(options: Record<string, string | boolean>, key: string): string {
  const value = options[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required option --${key}`);
  }
  return value;
}

function getString(options: Record<string, string | boolean>, key: string, fallback: string): string {
  const value = options[key];
  return typeof value === "string" ? value : fallback;
}

function getNumber(options: Record<string, string | boolean>, key: string, fallback: number): number {
  const value = options[key];
  if (typeof value !== "string") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(stripBom(raw)) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function renderKeyValueRules(instructions: Record<string, string>): string[] {
  const entries = Object.entries(instructions);
  if (entries.length === 0) {
    return ["- no injected rules"];
  }
  return entries.map(([key, value]) => `- ${key}: ${value}`);
}

function renderState(state: Awaited<ReturnType<FileMemoryStore["getState"]>>): string[] {
  const lines: string[] = [];
  for (const goal of state.goals) {
    lines.push(`- [goal] ${goal.content}`);
  }
  for (const constraint of state.constraints) {
    lines.push(`- [constraint] ${constraint.content}`);
  }
  for (const decision of state.decisions) {
    lines.push(`- [decision/${decision.status}] ${decision.content}`);
  }
  for (const todo of state.todos) {
    lines.push(`- [todo/${todo.status}] ${todo.content}`);
  }
  for (const artifact of state.artifacts) {
    lines.push(`- [artifact] ${artifact.content}`);
  }
  return lines.length > 0 ? lines : ["- no active memory"];
}

function firstLine(content: string): string {
  return content.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
