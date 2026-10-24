// @ts-check
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { FileBudgetKind, MarfaCore } from "../index.js";
import { scripted, storeFor } from "./copy-fixture.mjs";

/** @param {(path: string) => void} body */
function inStore(body) {
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-file-cache-"));
  try {
    body(join(dir, "copy.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "a cache folder that cannot be read reports its held bytes as unknown",
  {
    skip: process.platform === "win32",
  },
  () => {
    inStore((path) => {
      const core = MarfaCore.open(path);
      const none = core.fileCache();
      assert.equal(none.held, 0);
      assert.equal(none.heldUnreadable, undefined);

      const folder = `${path}.blobs`;
      mkdirSync(folder);
      chmodSync(folder, 0o000);
      try {
        // The witness: a process that can read it anyway cannot show this.
        assert.throws(() => readFileSync(join(folder, "x")));
        const sealed = core.fileCache();
        assert.equal(sealed.held, undefined);
        assert.equal(typeof sealed.heldUnreadable, "string");
        assert.equal(
          core.setFileBudget({ kind: FileBudgetKind.Bytes, bytes: 0 }),
          0,
        );
      } finally {
        chmodSync(folder, 0o755);
      }
      assert.equal(core.fileCache().held, 0);
    });
  },
);

test("the file budget is set, read, kept and trimmed through the module", () => {
  inStore((path) => {
    const core = MarfaCore.open(path);
    assert.equal(core.fileCache().setting.kind, FileBudgetKind.Default);
    assert.equal(core.status().fileCache.held, 0);

    assert.equal(core.fileCache().backupMarkFailure, undefined);

    // Nothing is held, so setting the budget takes nothing.
    assert.equal(
      core.setFileBudget({ kind: FileBudgetKind.Bytes, bytes: 100 }),
      0,
    );
    const set = core.fileCache();
    assert.deepEqual(set.setting, { kind: FileBudgetKind.Bytes, bytes: 100 });
    assert.equal(set.budget, 100);
    assert.equal(core.trimFiles(), 0);

    core.setFileBudget({ kind: FileBudgetKind.KeepAll });
    assert.equal(core.fileCache().budget, undefined);

    // A reading handle sees the setting and cannot change it.
    const reader = MarfaCore.openReader(path);
    assert.equal(reader.fileCache().setting.kind, FileBudgetKind.KeepAll);
    assert.throws(() => reader.trimFiles(), { code: "reading_handle" });
    assert.throws(
      () => reader.setFileBudget({ kind: FileBudgetKind.Default }),
      { code: "reading_handle" },
    );
  });
});

test("a budget that names bytes needs a whole count, and no other kind takes one", () => {
  inStore((path) => {
    const core = MarfaCore.open(path);
    const kept = { kind: FileBudgetKind.Bytes, bytes: 100 };
    core.setFileBudget(kept);
    for (const budget of [
      { kind: FileBudgetKind.Bytes },
      { kind: FileBudgetKind.Bytes, bytes: -1 },
      { kind: FileBudgetKind.Bytes, bytes: 1.5 },
      { kind: FileBudgetKind.Bytes, bytes: -0.5 },
      { kind: FileBudgetKind.Bytes, bytes: Number.NaN },
      { kind: FileBudgetKind.Bytes, bytes: Number.POSITIVE_INFINITY },
      { kind: FileBudgetKind.Bytes, bytes: Number.NEGATIVE_INFINITY },
      { kind: FileBudgetKind.Bytes, bytes: Number.MAX_SAFE_INTEGER + 1 },
      { kind: FileBudgetKind.Default, bytes: 1 },
      { kind: FileBudgetKind.KeepAll, bytes: 1 },
    ]) {
      assert.throws(
        () => core.setFileBudget(budget),
        { code: "invalid" },
        `${String(budget.bytes)} was taken`,
      );
      assert.deepEqual(core.fileCache().setting, kept);
    }

    // The witness: the largest whole count JavaScript holds exactly is taken.
    const largest = {
      kind: FileBudgetKind.Bytes,
      bytes: Number.MAX_SAFE_INTEGER,
    };
    core.setFileBudget(largest);
    assert.deepEqual(core.fileCache().setting, largest);
  });
});

test("a blob is kept from every trim until its promise resolves", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-file-cache-"));
  try {
    const path = join(dir, "copy.sqlite");
    const core = MarfaCore.open(path);
    const bytes = "held until the promise resolves";
    const hex = createHash("sha256").update(bytes).digest("hex");
    const blobs = `${path}.blobs`;
    mkdirSync(blobs, { recursive: true });
    const held = join(blobs, hex);
    writeFileSync(held, bytes);

    assert.equal(await core.blob(`sha256:${hex}`), held);
    // A writer marks the bytes read when it answers, which says when the
    // work behind the promise is done.
    const long = new Date(Date.now() - 60_000);
    utimesSync(held, long, long);
    const pending = core.blob(`sha256:${hex}`);
    const waited = Date.now();
    while (statSync(held).mtimeMs < waited - 30_000) {
      assert.ok(Date.now() - waited < 10_000, "the work never read the bytes");
    }
    // Keep the JavaScript thread busy past the work's end, so the promise
    // cannot resolve before the trim.
    const busy = Date.now();
    while (Date.now() - busy < 200) {}
    core.setFileBudget({ kind: FileBudgetKind.Bytes, bytes: 0 });

    const answered = await pending;
    assert.equal(
      readFileSync(answered, "utf8"),
      bytes,
      "a trim took the bytes of a promise not yet resolved",
    );
    // The witness: once the promise has resolved, a trim takes them.
    assert.equal(core.trimFiles(), Buffer.byteLength(bytes));
    assert.equal(existsSync(held), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attachments are reported and fetched through the module, and kept through a trim", async (t) => {
  const server = await scripted([]);
  t.after(server.close);
  const path = storeFor(t);
  const core = MarfaCore.open(path, server.url, "k");
  assert.deepEqual(core.fileCache().attachments, {
    held: 0,
    heldBytes: 0,
    partialBytes: 0,
    notHeld: 0,
    notHeldBytes: 0,
    notHeldByReason: [],
  });

  const host = core.createItem({
    type: "core.note",
    properties: { title: "Host", body: "" },
  });
  const file = join(dirname(path), "photo.png");
  writeFileSync(file, "a photo");
  await core.attach(host.itemId ?? "", file);
  const asked = server.asked();
  const fetched = await core.fetchKept();
  assert.equal(fetched.fetched, 0);
  assert.equal(fetched.fetchedBytes, 0);
  assert.equal(fetched.attachments?.held, 1);
  assert.equal(fetched.attachments?.heldBytes, Buffer.byteLength("a photo"));
  assert.equal(server.asked(), asked, "an attachment held was fetched");
  assert.equal(core.status().fileCache.attachments?.held, 1);
  assert.equal(
    core.setFileBudget({ kind: FileBudgetKind.Bytes, bytes: 0 }),
    0,
  );

  const reader = MarfaCore.openReader(path);
  await assert.rejects(reader.fetchKept(), { code: "reading_handle" });
});
