import { afterAll, beforeAll, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";
import { fileOf, requireBinary } from "./harness.js";

/**
 * "A file item a device writes from bytes it took in shows their length
 * before any server answers."
 *
 * Run against a real server and the real binary: a file attached and one
 * added with no server reachable show their size in the copy, and once the
 * queue drains the server holds the size it measured itself.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let store: string;
let note: string;

beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "file-size",
  ));
  const made = await client.createItem({
    type: "core.note",
    source: ctx.source,
    properties: { title: "holds a file", body: "see attached" },
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  note = made.data.item.id;
  trackItem(ctx, note);
  store = newStore("file-size-live");
  const online = new CliDevice({
    binary: requireBinary(),
    store,
    url: apiUrl,
    key: apiKey,
  });
  value(await online.hydrate(["core.note", "core.file"], "library"));
});

afterAll(async () => {
  if (ctx) await cleanup(ctx);
  if (store) rmSync(dirname(store), { recursive: true, force: true });
});

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

it("shows a file's size in the copy before it drains, and the server's once it has", async () => {
  const photo = Buffer.from(`a photo ${ctx.runId} ${"x".repeat(300)}`);
  const report = Buffer.from(`a report ${ctx.runId}`);
  const offline = new CliDevice({ binary: requireBinary(), store });

  const attached = value(
    await offline.attach(note, fileOf("photo.png", photo)),
  );
  const added = value(await offline.addFile(fileOf("report.txt", report)));
  const files = [
    { id: attached.item.item_id ?? "", size: photo.length },
    { id: added[1]?.item_id ?? "", size: report.length },
  ];
  for (const file of files) {
    const local = value(await offline.get(file.id));
    expect(
      local.properties.size_bytes,
      `${local.type} shows no size before it is sent`,
    ).toBe(file.size);
  }

  const online = offline.reopen({ url: apiUrl, key: apiKey });
  const drained = value(await online.drain());
  expect(
    drained.verdicts.map((entry) => entry.verdict),
    JSON.stringify(drained),
  ).toEqual(["accepted", "accepted", "accepted", "accepted", "accepted"]);
  for (const file of files) {
    trackItem(ctx, file.id);
    const read = await client.getItem(file.id);
    expect(read.ok, JSON.stringify(read.error)).toBe(true);
    expect(read.data.item.properties.size_bytes).toBe(file.size);
    expect(value(await online.get(file.id)).properties.size_bytes).toBe(
      file.size,
    );
  }
});
