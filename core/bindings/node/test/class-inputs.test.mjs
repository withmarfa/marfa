// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const binding = new URL("../index.js", import.meta.url).href;

/**
 * @param {import("node:test").TestContext} t
 * @param {string} body
 */
function inChild(t, body) {
  const directory = mkdtempSync(join(tmpdir(), "marfa-node-classes-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // Native argument checks run in a bounded child so a failing check cannot
  // end the test controller or leave its stores open.
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import assert from "node:assert/strict";
        import { MarfaCore, SliceTier, Stop } from ${JSON.stringify(binding)};
        const core = MarfaCore.open(process.argv[1], "http://127.0.0.1:1", "k");
        const stop = new Stop();
        const invoke = (value, operation) => {
          const result = operation(value);
          result?.catch(() => {});
          return result;
        };
        ${body}
      `,
      join(directory, "copy.sqlite"),
    ],
    {
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 65_536,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
}

test("accepts genuine class receivers and a Stop for every long call", (t) => {
  inChild(
    t,
    `
      Stop.prototype.raise.call(stop);
      assert.equal(MarfaCore.prototype.status.call(core).hydration, "never");
      for (const call of [
        () => core.hydrate(["core.note"], SliceTier.Library, stop),
        () => core.hydrateWith(["core.note"], SliceTier.Library, [], stop),
        () => core.catchUp(stop),
        () => core.drain(stop),
      ]) {
        await assert.rejects(call(), { code: "canceled" });
      }
    `,
  );
});

for (const operation of [
  'value => core.hydrate(["core.note"], SliceTier.Library, value)',
  'value => core.hydrateWith(["core.note"], SliceTier.Library, [], value)',
  "value => core.catchUp(value)",
  "value => core.drain(value)",
]) {
  test(`requires a Stop argument: ${operation.split("core.")[1].split("(")[0]}`, (t) => {
    inChild(
      t,
      `assert.throws(() => invoke(core, ${operation}), { code: "InvalidArg" });`,
    );
  });
}

test("rejects a class argument whose prototype alone names Stop", (t) => {
  inChild(
    t,
    `
      Object.setPrototypeOf(core, Stop.prototype);
      const owner = MarfaCore.open(process.argv[1] + ".owner");
      assert.throws(() => invoke(core, value => owner.drain(value)), { code: "InvalidArg" });
      assert.throws(() => invoke(Object.create(Stop.prototype), value => owner.drain(value)), Error);
    `,
  );
});

test("requires the matching class as a method receiver", (t) => {
  inChild(
    t,
    `
      assert.throws(() => Stop.prototype.raise.call(core), Error);
      assert.throws(() => MarfaCore.prototype.status.call(stop), Error);
      assert.throws(() => Stop.prototype.raise.call(Object.create(Stop.prototype)), Error);
    `,
  );
});
