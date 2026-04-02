#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ContextManager } from "./context-manager.js";
import { FileMemoryStore } from "./memory-store.js";
async function main() {
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
async function handleInit(memoryDir, options) {
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
async function handleAppend(memoryDir, options) {
    const sessionId = getRequired(options, "session");
    const manager = await loadManager(memoryDir, sessionId);
    const message = {
        role: getString(options, "role", "user"),
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
async function handleFlush(memoryDir, options) {
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
async function handleCompact(memoryDir, options) {
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
async function handleResume(memoryDir, options) {
    const sessionId = getRequired(options, "session");
    const store = new FileMemoryStore(memoryDir);
    const runtime = await store.getRuntimeState(sessionId);
    const state = await store.getState(sessionId);
    const instructions = await readJson(join(memoryDir, sessionId, "instructions.json"), {});
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
async function loadManager(memoryDir, sessionId) {
    const store = new FileMemoryStore(memoryDir);
    const runtime = await store.getRuntimeState(sessionId);
    const config = await readJson(join(memoryDir, sessionId, "config.json"), defaultConfig());
    const instructions = await readJson(join(memoryDir, sessionId, "instructions.json"), {});
    return new ContextManager(sessionId, config, {
        memoryStore: store,
        instructionSources: instructions,
        initialSnapshot: runtime.snapshot,
    });
}
function parseArgs(argv) {
    const [command, ...rest] = argv;
    if (!command || !["init", "append", "flush", "compact", "resume"].includes(command)) {
        throw new Error("Usage: context-governor <init|append|flush|compact|resume> [options]");
    }
    const options = {};
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
        command: command,
        options,
    };
}
async function loadInstructionSources(options) {
    const sectionsPath = options.sectionsFile;
    if (typeof sectionsPath === "string") {
        return readJson(resolve(process.cwd(), sectionsPath), {});
    }
    return {
        workflow: "Search before answering when repo truth is required.",
        handoff: "Update HANDOFF with unresolved work before yielding.",
        memory: "Persist confirmed goals, constraints, decisions, and todos.",
        output: "Keep outputs concise and action-oriented.",
    };
}
async function loadContent(options) {
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
function buildConfig(options) {
    const base = defaultConfig();
    return {
        ...base,
        maxContextTokens: getNumber(options, "maxContextTokens", base.maxContextTokens),
        compactionTriggerTokens: getNumber(options, "compactionTriggerTokens", base.compactionTriggerTokens ?? base.maxContextTokens - 2000),
        recentTurnsPreserve: getNumber(options, "recentTurnsPreserve", base.recentTurnsPreserve),
        postCompactionSections: splitCsv(getString(options, "postCompactionSections", base.postCompactionSections.join(","))),
        memoryFlush: {
            ...base.memoryFlush,
            softThresholdTokens: getNumber(options, "softThresholdTokens", base.memoryFlush.softThresholdTokens),
            lookbackMessages: getNumber(options, "lookbackMessages", base.memoryFlush.lookbackMessages),
        },
        qualityGuard: {
            ...base.qualityGuard,
            maxRetries: getNumber(options, "maxRetries", base.qualityGuard.maxRetries),
        },
    };
}
function defaultConfig() {
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
function getRequired(options, key) {
    const value = options[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Missing required option --${key}`);
    }
    return value;
}
function getString(options, key, fallback) {
    const value = options[key];
    return typeof value === "string" ? value : fallback;
}
function getNumber(options, key, fallback) {
    const value = options[key];
    if (typeof value !== "string") {
        return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}
function splitCsv(value) {
    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}
async function readJson(filePath, fallback) {
    try {
        const raw = await readFile(filePath, "utf8");
        return JSON.parse(stripBom(raw));
    }
    catch {
        return fallback;
    }
}
async function writeJson(filePath, value) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}
function renderKeyValueRules(instructions) {
    const entries = Object.entries(instructions);
    if (entries.length === 0) {
        return ["- no injected rules"];
    }
    return entries.map(([key, value]) => `- ${key}: ${value}`);
}
function renderState(state) {
    const lines = [];
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
function firstLine(content) {
    return content.split(/\r?\n/, 1)[0]?.trim() ?? "";
}
function stripBom(raw) {
    return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}
function printJson(value) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
