import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BindingDevice } from "../../device/binding-adapter.js";
import { tempFolder } from "../../utils/temp-folder.js";
import { requireModule } from "./harness.js";

const open: BindingDevice[] = [];

afterEach(async () => {
  for (const device of open.splice(0)) await device.close();
});

async function started(store: string): Promise<BindingDevice> {
  const device = await BindingDevice.start({ module: requireModule(), store });
  open.push(device);
  return device;
}

function files(store: string): Record<string, string | null> {
  return Object.fromEntries(
    [store, `${store}-wal`].map((name) => [
      name.slice(store.length) || "file",
      existsSync(name) ? readFileSync(name).toString("base64") : null,
    ]),
  );
}

async function openWriterWithQueuedItems(name: string) {
  const store = join(tempFolder("marfa-reader-"), `${name}.sqlite`);
  const writer = await started(store);
  for (const title of ["one", "two", "three"]) {
    const saved = await writer.createItem({
      type: "core.note",
      properties: { title, body: title.repeat(2000) },
    });
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
  }
  return { store, writer };
}

describe("a reading handle", () => {
  it("changes the store or its log when the last connection can write", async () => {
    const { store, writer } = await openWriterWithQueuedItems("writable-last");
    const last = new DatabaseSync(store);
    last.exec("PRAGMA journal_mode = WAL");
    last.prepare("SELECT count(*) FROM queue").get();
    await writer.forget();
    const left = files(store);
    expect(left["-wal"]).not.toBeNull();
    last.close();

    expect(files(store)).not.toEqual(left);
  });

  it("leaves the store and its log as the writer left them when it closes after the writer", async () => {
    const { store, writer } = await openWriterWithQueuedItems("reader-last");
    const reader = await started(store);
    const refused = await reader.createItem({
      type: "core.note",
      properties: { title: "from the reader", body: "from the reader" },
    });
    expect(
      refused.ok ? "written" : refused.refusal.code,
      "the second opener took the writer role, so it is no reading handle",
    ).toBe("reading_handle");
    const seen = await reader.queue();
    expect(seen.ok ? seen.value.length : 0).toBe(3);

    await writer.forget();
    const left = files(store);
    expect(
      left["-wal"],
      "the writer left no log, so there is nothing for the reader to checkpoint",
    ).not.toBeNull();
    await reader.forget();

    expect(
      files(store),
      "a reading handle that closed last changed the store or its log",
    ).toEqual(left);
  });
});
