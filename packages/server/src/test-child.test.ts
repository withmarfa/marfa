import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { forkFixture, nextMessage } from "./test-child.js";

const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

async function start(source: string): Promise<ChildProcess> {
  const dir = await mkdtemp(join(tmpdir(), "marfa-test-child-"));
  dirs.push(dir);
  const file = join(dir, "child.mjs");
  await writeFile(file, source);
  const child = forkFixture(file);
  children.push(child);
  return child;
}

describe("nextMessage", () => {
  it("resolves with the message of the kind it waits for", async () => {
    const child = await start(
      `process.send({ kind: "other" }); process.send({ kind: "ready", url: "u" }); setInterval(() => {}, 1000);`,
    );
    expect(await nextMessage(child, "ready")).toEqual({
      kind: "ready",
      url: "u",
    });
  });

  it("fails at once, with its exit code and stderr, for a child that exits before it reports", async () => {
    const child = await start(
      `console.error("compile failed: boom"); process.exit(3);`,
    );
    const started = Date.now();
    const failure = await nextMessage(child, "ready", 30_000).catch(
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("exited with code 3");
    expect(message).toContain("before it reported ready");
    expect(message).toContain("compile failed: boom");
    // The witness that this was not the budget running out.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("names the signal for a child that is killed before it reports", async () => {
    const child = await start(`setInterval(() => {}, 1000);`);
    const waiting = nextMessage(child, "ready", 30_000).catch(
      (err: unknown) => err,
    );
    child.kill("SIGKILL");
    const failure = await waiting;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("signal SIGKILL");
  });

  it("fails for a child that exited before the wait began", async () => {
    const child = await start(`process.exit(4);`);
    await new Promise((resolve) => child.once("exit", resolve));
    const failure = await nextMessage(child, "ready", 30_000).catch(
      (err: unknown) => err,
    );
    expect((failure as Error).message).toContain("exited with code 4");
  });

  it("reports the budget when a live child never reports", async () => {
    const child = await start(`setInterval(() => {}, 1000);`);
    const failure = await nextMessage(child, "ready", 300).catch(
      (err: unknown) => err,
    );
    expect((failure as Error).message).toContain("did not report ready within");
  });
});
