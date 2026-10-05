import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackType,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

/**
 * A device holds a write to the bounds the server holds it to on the names it
 * carries: a tag and a property name. Run against a real server and the real
 * binary, so the verdicts each side gives are the same ones.
 */

let client: MarfaClient;
let ctx: TestContext;
let device: CliDevice;
let type: string;
let row: string;
let store: string;
let scratch: string;

/** Refused by the server on every door that takes a tag. */
const REFUSED_TAGS: Array<[string, string]> = [
  ["", "empty"],
  ["   ", "blank"],
  ["\t  ﻿", "blank in the way JavaScript's trim reads blank"],
  ["a".repeat(129), "129 UTF-16 code units"],
  ["\u{1F600}".repeat(65), "65 characters of two UTF-16 code units each"],
];

/** Taken by the server, and so by the device. */
const ACCEPTED_TAGS: Array<[string, string]> = [
  ["a".repeat(128), "128 UTF-16 code units"],
  ["\u{1F600}".repeat(64), "64 characters of two UTF-16 code units each"],
  // The one character Unicode calls white space and JavaScript's trim keeps.
  ["\u0085", "a lone next-line character, which JavaScript does not trim"],
  [" padded ", "spaces round a word"],
];

beforeAll(async () => {
  const context = await createTestContext("device", "name-bounds");
  ({ client, ctx } = context);
  type = `fixture.${ctx.runId}.names`;
  expect(
    (
      await client.registerType({
        id: type,
        fields: { title: { type: "string" } },
      })
    ).ok,
  ).toBe(true);
  trackType(ctx, type);
  const made = await client.createItem({
    type,
    source: ctx.source,
    properties: { title: "row" },
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  row = made.data.item.id;
  trackItem(ctx, row);
  store = newStore("name-bounds-live");
  scratch = mkdtempSync(join(tmpdir(), "marfa-name-bounds-"));
  device = new CliDevice({
    binary: requireBinary(),
    store,
    url: context.apiUrl,
    key: context.apiKey,
  });
  expect((await device.hydrate([type], "library")).ok).toBe(true);
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
  if (store) rmSync(dirname(store), { recursive: true, force: true });
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** Refused as the server refuses: the `validation` class, carrying its code. */
function expectRefusedAsTheServerDoes(
  outcome: Outcome<unknown>,
  what: string,
): void {
  expect(outcome.ok, `${what} was accepted`).toBe(false);
  if (outcome.ok) return;
  const envelope = JSON.parse(outcome.refusal.raw) as {
    error: { code: string; server: { code: string | null } | null };
  };
  expect(
    [envelope.error.code, envelope.error.server?.code],
    `${what} was refused, but not as the server refuses it: ${outcome.refusal.raw}`,
  ).toEqual(["validation", "validation_error"]);
}

it("refuses a tag the server refuses, on every door, before it saves or queues anything", async () => {
  const before = await device.queue();
  expect(before.ok).toBe(true);
  const file = join(scratch, "note.txt");
  writeFileSync(file, "bytes a refused file must not leave behind");
  const held = await device.get(row);
  for (const [tag, why] of REFUSED_TAGS) {
    // The witness: the server refuses the same tag on the doors a person
    // writes one through, so the device's refusal is the server's rule and
    // not a stricter one.
    const served = [
      await client.addTags(row, [tag]),
      await client.updateMetadata(row, { tags: [tag] }),
      await client.replaceMetadata(row, { tags: [tag] }),
      await client.createItem({
        type,
        source: ctx.source,
        properties: { title: "refused" },
        tags: [tag],
      }),
    ];
    for (const refused of served) {
      expect(refused.status, `the server took a tag that is ${why}`).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }

    for (const [door, outcome] of [
      ["tags add", await device.addTag(row, tag)],
      [
        "metadata merge",
        await device.writeMetadata(row, ["fine", tag], "merge"),
      ],
      ["metadata replace", await device.writeMetadata(row, [tag], "replace")],
      [
        "items create",
        await device.create({
          type,
          properties: { title: "refused" },
          tags: [tag],
        }),
      ],
      ["items add", await device.addFile(file, { tags: [tag] })],
    ] as const) {
      expectRefusedAsTheServerDoes(
        outcome,
        `${door} with a tag that is ${why}`,
      );
    }
  }
  expect(await device.queue(), "a refused tag was queued").toEqual(before);
  expect(await device.get(row), "a refused tag was saved").toEqual(held);
});

it("takes a tag the server takes, queues it, and has it accepted when the queue drains", async () => {
  for (const [tag, what] of ACCEPTED_TAGS) {
    const served = await client.addTags(row, [tag]);
    expect(
      served.ok,
      `the server refused a tag of ${what}: ${JSON.stringify(served.error)}`,
    ).toBe(true);
  }
  const written: string[] = [];
  const queue = async (outcome: Promise<Outcome<{ id: string }>>) => {
    const queued = await outcome;
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    if (queued.ok) written.push(queued.value.id);
  };
  await queue(device.addTag(row, ACCEPTED_TAGS[0]![0]));
  await queue(device.addTag(row, ACCEPTED_TAGS[2]![0]));
  await queue(
    device.writeMetadata(
      row,
      ACCEPTED_TAGS.map(([tag]) => tag),
      "merge",
    ),
  );
  const created = await device.create({
    type,
    properties: { title: "named" },
    tags: ACCEPTED_TAGS.map(([tag]) => tag),
  });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  if (created.ok) trackItem(ctx, created.value.item_id!);

  const drained = await device.drain();
  expect(drained.ok, JSON.stringify(drained)).toBe(true);
  if (!drained.ok) return;
  expect(
    drained.value.verdicts.length,
    "the drain did not answer every write",
  ).toBeGreaterThanOrEqual(written.length + 1);
  expect(
    drained.value.verdicts.map((verdict) => verdict.verdict),
    "the server refused a write the device took",
  ).toEqual(drained.value.verdicts.map(() => "accepted"));

  const metadata = await client.getMetadata(row);
  expect(metadata.ok).toBe(true);
  expect(metadata.data.metadata.tags).toEqual(
    expect.arrayContaining(ACCEPTED_TAGS.map(([tag]) => tag)),
  );
});

it("refuses a property with no name on create and edit, and takes one with a name", async () => {
  const before = await device.queue();
  expect(before.ok).toBe(true);
  const current = await client.getItem(row);
  expect(current.ok).toBe(true);
  const version = current.data.item.version;
  const unnamed = { title: "unnamed", "": 1 };

  for (const refused of [
    await client.createItem({ type, source: ctx.source, properties: unnamed }),
    await client.updateItem(row, { version, properties: { "": 1 } }),
  ]) {
    expect(refused.status, "the server took a property with no name").toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
  }
  expectRefusedAsTheServerDoes(
    await device.create({ type, properties: unnamed }),
    "a create naming a property with no name",
  );
  expectRefusedAsTheServerDoes(
    await device.update(row, { properties: { "": 1 }, version }),
    "an update naming a property with no name",
  );
  expectRefusedAsTheServerDoes(
    await device.update(row, { properties: { "": 1 }, version, replace: true }),
    "a whole-properties update naming a property with no name",
  );
  expect(await device.queue(), "a refused property was queued").toEqual(before);

  const named = { title: "named", " ": 1, "a b": 2 };
  const served = await client.createItem({
    type,
    source: ctx.source,
    properties: named,
  });
  expect(served.ok, JSON.stringify(served.error)).toBe(true);
  trackItem(ctx, served.data.item.id);
  const local = await device.create({ type, properties: named });
  expect(local.ok, JSON.stringify(local)).toBe(true);
  if (local.ok) trackItem(ctx, local.value.item_id!);
  const drained = await device.drain();
  expect(drained.ok && drained.value.verdicts.at(-1)?.verdict).toBe("accepted");
});
