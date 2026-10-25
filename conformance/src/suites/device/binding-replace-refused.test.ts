import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { startBindingHarness, type BindingHarness } from "./harness.js";

/**
 * Replacing a store the writer refuses `wrong_schema`, through the binding,
 * the only device that offers it. The fixture's process plays another app
 * on the same store where one holds the writer role.
 */

let harness: BindingHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** The store file and its write-ahead log, each as a digest, or absent. */
function files(store: string): Array<string | null> {
  return ["", "-wal"].map((suffix) =>
    existsSync(store + suffix)
      ? createHash("sha256")
          .update(readFileSync(store + suffix))
          .digest("hex")
      : null,
  );
}

function edit(store: string, sql: string): void {
  const db = new DatabaseSync(store);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/** The file budget setting the store records, or null for the default. */
function recordedBudget(store: string): string | null {
  const db = new DatabaseSync(store, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'file_budget'")
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

/**
 * A store holding one note, its create answered by the server where
 * `answered`, as a build with another queue would have left it: one column
 * of the queue under another name. The binding has let go of it.
 */
async function refusedStore(
  label: string,
  answered: boolean,
): Promise<{ harness: BindingHarness; note: string }> {
  const started = await startBindingHarness(label, { server: false });
  harness = started;
  const created = await started.device.createItem({
    type: "core.note",
    properties: { title: "kept", body: "kept" },
  });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  const note = created.ok ? (created.value.itemId ?? "") : "";
  // The witness: the store holds the note.
  const read = await started.device.get(note);
  expect(read.ok && read.value?.id).toBe(note);
  await started.device.forget();
  if (answered) {
    edit(
      started.device.store,
      "UPDATE queue SET verdict = 'accepted', sent = 1",
    );
  }
  edit(
    started.device.store,
    "ALTER TABLE queue RENAME COLUMN follows TO after_write",
  );
  const opened = await started.device.tryOpen();
  expect(
    opened.error?.code,
    "the reshaped store was not refused, so it cannot stand for another build's",
  ).toBe("wrong_schema");
  return { harness: started, note };
}

describe("replacing a store the writer refuses", () => {
  it("replaces a refused store that holds nothing unsent with an empty one, and opens it", async () => {
    const { harness: started, note } = await refusedStore(
      "replace-refused",
      true,
    );
    const { device } = started;

    const replaced = await device.replaceRefused();
    expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
    const queue = await device.queue();
    expect(queue.ok && queue.value).toEqual([]);
    const read = await device.get(note);
    expect(
      read.ok && read.value,
      "the new store still holds the note the refused one held",
    ).toBe(null);
    const created = await device.createItem({
      type: "core.note",
      properties: { title: "new", body: "new" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
  });

  it("keeps the file budget the refused store recorded", async () => {
    for (const [recorded, label] of [
      ["4096", "a byte count"],
      ["keep_all", "keep every file"],
    ] as const) {
      const { harness: started } = await refusedStore(
        `replace-budget-${recorded}`,
        true,
      );
      edit(
        started.device.store,
        `INSERT INTO meta (key, value) VALUES ('file_budget', '${recorded}')`,
      );
      const replaced = await started.device.replaceRefused();
      expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
      expect(recordedBudget(started.device.store), label).toBe(recorded);
      await started.stop();
      harness = undefined;
    }
  });

  it("gives the default file budget where the refused store records none that it can read", async () => {
    for (const [sql, label] of [
      ["", "none recorded"],
      [
        "INSERT INTO meta (key, value) VALUES ('file_budget', 'plenty')",
        "a value that is no setting",
      ],
    ] as const) {
      const { harness: started } = await refusedStore("replace-default", true);
      if (sql) edit(started.device.store, sql);
      const replaced = await started.device.replaceRefused();
      expect(replaced.ok, `${label}: ${JSON.stringify(replaced)}`).toBe(true);
      expect(recordedBudget(started.device.store), label).toBeNull();
      await started.stop();
      harness = undefined;
    }
  });

  it("refuses to replace a refused store that holds a write the server has not taken", async () => {
    const { harness: started } = await refusedStore("replace-unsent", false);
    const { device } = started;
    const before = files(device.store);

    const refused = await device.replaceRefused();
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code, refused.refusal.raw).toBe("wrong_schema");
    expect(
      (JSON.parse(refused.refusal.raw) as { unsent?: number }).unsent,
      "the refusal did not count the write the store holds unsent",
    ).toBe(1);
    expect(files(device.store)).toEqual(before);
    expect((await device.tryOpen()).error?.code).toBe("wrong_schema");
  });

  it("refuses to replace a refused store whose writes it cannot count", async () => {
    const { harness: started } = await refusedStore("replace-uncounted", true);
    const { device } = started;
    // A queue whose shape hides its count: what the store holds is unknown.
    edit(
      device.store,
      "ALTER TABLE queue RENAME COLUMN verdict TO answer_kind",
    );
    const before = files(device.store);

    const refused = await device.replaceRefused();
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code, refused.refusal.raw).toBe("wrong_schema");
    expect(
      (JSON.parse(refused.refusal.raw) as { unsent?: number }).unsent,
      "the refusal gave a count of writes it cannot count",
    ).toBeNull();
    expect(files(device.store)).toEqual(before);
    expect((await device.tryOpen()).error?.code).toBe("wrong_schema");
  });

  it("refuses to replace a refused store while another process holds its writer role", async () => {
    const { harness: started } = await refusedStore("replace-held", true);
    const { device } = started;
    const before = files(device.store);

    // Another app's writer, as the core takes the role.
    const holder = new DatabaseSync(`${device.store}.writer-lock`);
    try {
      holder.exec("BEGIN EXCLUSIVE");
      const refused = await device.replaceRefused();
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.refusal.code, refused.refusal.raw).toBe("reading_handle");
      expect(files(device.store)).toEqual(before);
    } finally {
      holder.close();
    }

    // The witness: once the other writer lets go, the same store is replaced.
    const replaced = await device.replaceRefused();
    expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
  });

  it("refuses to replace a store it opens", async () => {
    const started = await startBindingHarness("replace-usable", {
      server: false,
    });
    harness = started;
    const { device } = started;
    const created = await device.createItem({
      type: "core.note",
      properties: { title: "kept", body: "kept" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    await device.forget();
    const before = files(device.store);

    const refused = await device.replaceRefused();
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code, refused.refusal.raw).toBe("invalid");
    expect(files(device.store)).toEqual(before);
    expect((await device.tryOpen()).handle).toBe("writer");
  });
});
