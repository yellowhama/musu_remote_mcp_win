import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProcessManager } from "../src/process-manager.js";

function createManager(): ProcessManager {
  return new ProcessManager({
    maxRetainedOutputBytes: 1024 * 1024,
    processRetentionMs: 60_000,
    maxProcesses: 16,
    defaultMaxOutputBytes: 1024 * 1024,
  });
}

describe("ProcessManager", () => {
  let manager: ProcessManager | undefined;

  afterEach(async () => {
    await manager?.shutdown();
  });

  it("captures stdout, stderr, and exit state", async () => {
    manager = createManager();
    const sessionId = manager.start({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('stdout'); process.stderr.write('stderr')"],
      commandForDisplay: "test output",
      cwd: process.cwd(),
    });

    await manager.waitForExit(sessionId, 2000);
    const result = await manager.read(sessionId);

    expect(result).toMatchObject({
      running: false,
      exitCode: 0,
      stdout: "stdout",
      stderr: "stderr",
      timedOut: false,
    });
    expect(result.output).toContain("stdout");
    expect(result.output).toContain("stderr");
  });

  it("supports interactive stdin and closes cleanly", async () => {
    manager = createManager();
    const sessionId = manager.start({
      executable: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout)"],
      commandForDisplay: "cat",
      cwd: process.cwd(),
    });

    await manager.write(sessionId, "hello\n", true);
    await manager.waitForExit(sessionId, 2000);
    const result = await manager.read(sessionId);

    expect(result.running).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });

  it("terminates a command when its timeout expires", async () => {
    manager = createManager();
    const sessionId = manager.start({
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10000)"],
      commandForDisplay: "sleep 10",
      cwd: process.cwd(),
      timeoutMs: 50,
    });

    await manager.waitForExit(sessionId, 3000);
    const result = await manager.read(sessionId);

    expect(result.running).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timeout");
  });

  it("handles a rejected initial stdin write without crashing the server", async () => {
    manager = createManager();
    const sessionId = manager.start({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      commandForDisplay: "true",
      cwd: process.cwd(),
      stdin: "x".repeat(1024 * 1024),
    });

    await manager.waitForExit(sessionId, 2000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = await manager.read(sessionId);

    expect(result.running).toBe(false);
    expect(result.error).toMatch(/stdin write failed|EPIPE/i);
  });

  it("rejects a follow-up stdin write without emitting an unhandled error", async () => {
    manager = createManager();
    const sessionId = manager.start({
      executable: process.execPath,
      args: ["-e", "require('node:fs').closeSync(0); process.stdout.write('ready'); setTimeout(() => {}, 2000)"],
      commandForDisplay: "closed stdin",
      cwd: process.cwd(),
    });
    expect((await manager.read(sessionId, { waitMs: 1000 })).stdout).toContain("ready");

    await expect(manager.write(sessionId, "x".repeat(1024 * 1024))).rejects.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await manager.read(sessionId)).error).toMatch(/stdin write failed|EPIPE/i);
  });

  it("preserves UTF-8 characters across paged process output", async () => {
    manager = createManager();
    const expected = `${"a".repeat(16 * 1024 - 1)}😀B`;
    const encoded = Buffer.from(expected).toString("base64");
    const sessionId = manager.start({
      executable: process.execPath,
      args: ["-e", `process.stdout.write(Buffer.from(${JSON.stringify(encoded)}, "base64"))`],
      commandForDisplay: "unicode output",
      cwd: process.cwd(),
    });

    await manager.waitForExit(sessionId, 2000);
    const first = await manager.read(sessionId, { maxOutputBytes: 16 * 1024 });
    const second = await manager.read(sessionId, {
      afterSeq: first.nextSeq,
      maxOutputBytes: 16 * 1024,
    });

    expect(first.hasMore).toBe(true);
    expect(first.output + second.output).toBe(expected);
    expect(first.output + second.output).not.toContain("�");
  });

  it.skipIf(process.platform !== "win32")("terminates the complete Windows process tree", async () => {
    manager = createManager();
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "remote-dev-mcp-tree-"));
    const pidFile = path.join(temporaryDirectory, "grandchild.pid");
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const sessionId = manager.start({
      executable: process.execPath,
      args: ["-e", parentScript],
      commandForDisplay: "Windows process tree",
      cwd: process.cwd(),
    });
    try {
      let grandchildPid = 0;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try { grandchildPid = Number(await readFile(pidFile, "utf8")); break; } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(grandchildPid).toBeGreaterThan(0);
      await manager.terminate(sessionId, "SIGTERM", 2000);
      await manager.waitForExit(sessionId, 3000);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(() => process.kill(grandchildPid, 0)).toThrow();
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("lists processes without pruning and expires completed sessions independently", async () => {
    manager = new ProcessManager({
      maxRetainedOutputBytes: 1024 * 1024,
      processRetentionMs: 500,
      maxProcesses: 16,
      defaultMaxOutputBytes: 1024 * 1024,
    });
    const sessionId = manager.start({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      commandForDisplay: "true",
      cwd: process.cwd(),
    });

    await manager.waitForExit(sessionId, 2000);
    expect(manager.list()).toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId, running: false })]),
    );
    await expect(manager.read(sessionId)).resolves.toMatchObject({ running: false });

    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(manager.read(sessionId)).rejects.toThrow("Unknown process session");
  });
});
