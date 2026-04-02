import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("cli persists session runtime across commands", async () => {
  const workdir = await mkdtemp(join(tmpdir(), "context-governor-cli-"));
  const cliPath = join(process.cwd(), "dist", "src", "cli.js");

  await execFileAsync(process.execPath, [cliPath, "init", "--session", "s1", "--memoryDir", workdir]);
  await execFileAsync(process.execPath, [
    cliPath,
    "append",
    "--session",
    "s1",
    "--memoryDir",
    workdir,
    "--role",
    "user",
    "--content",
    "goal: 稳定长会话\ntodo: 写 resume 输出\na lot of extra text to move token usage upward quickly",
  ]);
  await execFileAsync(process.execPath, [cliPath, "flush", "--session", "s1", "--memoryDir", workdir]);
  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "resume",
    "--session",
    "s1",
    "--memoryDir",
    workdir,
  ]);

  assert.match(stdout, /Session Resume: s1/);
  assert.match(stdout, /\[goal\] 稳定长会话/);

  const runtime = JSON.parse(await readFile(join(workdir, "s1", "context.json"), "utf8")) as {
    snapshot: { workingMessages: unknown[] };
  };
  assert.equal(Array.isArray(runtime.snapshot.workingMessages), true);
});

test("cli init loads instructions file written with BOM-compatible utf8", async () => {
  const workdir = await mkdtemp(join(tmpdir(), "context-governor-cli-bom-"));
  const cliPath = join(process.cwd(), "dist", "src", "cli.js");
  const instructionsPath = join(workdir, "instructions.json");

  const payload = "\ufeff{\n  \"workflow\": \"先读取 resume\",\n  \"memory\": \"只写确认信息\"\n}";
  await writeFile(instructionsPath, payload, "utf8");

  await execFileAsync(process.execPath, [
    cliPath,
    "init",
    "--session",
    "s2",
    "--memoryDir",
    workdir,
    "--sectionsFile",
    instructionsPath,
  ]);

  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "resume",
    "--session",
    "s2",
    "--memoryDir",
    workdir,
  ]);

  assert.match(stdout, /workflow: 先读取 resume/);
  assert.match(stdout, /memory: 只写确认信息/);
});
