import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refusal, typeCatalog } from "../../device/marfa-answers.js";
import type { Outcome } from "../../device/protocol.js";
import {
  folderHarness,
  scriptHydration,
  scriptWrites,
  startHarness,
  type FolderHarness,
  type Harness,
} from "./harness.js";

const TYPE = "fixture.fields";
const ROW = "01a00000-0000-7000-8000-00000000000a";
const fields = {
  title: { type: "string", required: true, maxLength: 5 },
  body: { type: "string" },
  read: { type: "boolean" },
  count: { type: "integer" },
  choice: { type: "enum", enum_values: ["yes", "no"] },
  list: { type: "array", maxItems: 2, items: { type: "string" } },
  date: { type: "date" },
  time: { type: "datetime" },
  email: { type: "email" },
  url: { type: "url" },
  object: { type: "object" },
  image: { type: "thumbnail" },
  annotated: { type: "string", format: "bcp47" },
};
const types = [
  {
    id: TYPE,
    fields,
    display_hints: { title_field: "title", body_field: "body" },
  },
];
let harness: Harness | undefined;
let folder: FolderHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  await folder?.stop();
  harness = undefined;
  folder = undefined;
});

async function hydrated() {
  harness = await startHarness("property-validation");
  scriptHydration(harness.server, {
    head: "10",
    catalog: typeCatalog([
      ...types,
      {
        id: "fixture.destination",
        fields: { url: { type: "url", required: true } },
      },
    ]),
    rows: {
      [TYPE]: [
        {
          item: {
            id: ROW,
            type: TYPE,
            version: 3,
            source: "fixture",
            source_id: "known",
            properties: { title: "valid", body: "held" },
          },
        },
      ],
    },
  });
  expect((await harness.device.hydrate([TYPE], "library")).ok).toBe(true);
  return harness;
}

function invalid(outcome: Outcome<unknown>, field: string) {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  const error = (
    JSON.parse(outcome.refusal.raw) as {
      error: { code: string; message: string; server: { code: string } };
    }
  ).error;
  expect(error.code).toBe("validation");
  expect(error.server.code).toBe("invalid_properties");
  expect(error.message).toContain(`${field}:`);
}

describe("a working copy checks the fields its catalog holds", () => {
  it("refuses missing and invalid fields atomically and accepts their boundary neighbours", async () => {
    const { device, server } = await hydrated();
    const good = await device.create({
      type: TYPE,
      properties: {
        title: "😀abc",
        body: "",
        read: null,
        count: 9007199254740991,
        choice: "yes",
        list: [false, {}],
        date: "0000-02-29",
        time: "2026-01-01T23:59+23:59",
        email: "reader+tag@example.test",
        url: " \thttps://example.test\u0000",
        object: {},
        image: "data:image/png;base64,iVBORw0KGgo=",
        annotated: "not a language tag",
        custom: { anything: true },
      },
    });
    expect(good.ok).toBe(true);
    const before = await device.queue();
    const listed = await device.list({ type: TYPE });
    const calls = server.requests.length;
    invalid(await device.create({ type: TYPE, properties: {} }), "title");
    for (const [field, value] of [
      ["title", null],
      ["title", "😀abcd"],
      ["title", "a\u0000b"],
      ["read", "yes"],
      ["count", 9007199254740992],
      ["count", 1.5],
      ["choice", "maybe"],
      ["list", [1, 2, 3]],
      ["date", "1900-02-29"],
      ["time", "2026-01-01T12:00:00"],
      ["time", "2026-01-01T12:00+24:00"],
      ["email", "a..b@example.test"],
      ["url", "relative"],
      ["object", []],
      ["image", "data:image/png;base64,iVBORw0KGgp="],
    ] as Array<[string, unknown]>) {
      invalid(
        await device.create({
          type: TYPE,
          tags: ["untaken"],
          properties: { title: "valid", [field]: value },
        }),
        field,
      );
    }
    expect(await device.queue()).toEqual(before);
    expect(await device.list({ type: TYPE })).toEqual(listed);
    expect(server.requests.length).toBe(calls);
  });

  it("judges an inherited field as the nearest type in the chain declares it", async () => {
    harness = await startHarness("property-validation-inherited");
    // The child redeclares the parent's field as required, which is the one
    // change a subtype may make to it (`types.md`); the grandchild declares
    // nothing of its own.
    const code = { type: "string", maxLength: 3 };
    scriptHydration(harness.server, {
      head: "10",
      catalog: typeCatalog([
        { id: "fixture.parent", fields: { code } },
        {
          id: "fixture.child",
          parent: "fixture.parent",
          fields: { code: { ...code, required: true } },
        },
        { id: "fixture.grandchild", parent: "fixture.child", fields: {} },
      ]),
      rows: {},
    });
    expect(
      (await harness.device.hydrate(["fixture.parent"], "library")).ok,
    ).toBe(true);
    const { device } = harness;
    expect(
      (await device.create({ type: "fixture.parent", properties: {} })).ok,
      "the parent, which does not require the field, was refused without it",
    ).toBe(true);
    for (const type of ["fixture.child", "fixture.grandchild"]) {
      invalid(await device.create({ type, properties: {} }), "code");
      invalid(
        await device.create({ type, properties: { code: "abcd" } }),
        "code",
      );
      expect(
        (await device.create({ type, properties: { code: "abc" } })).ok,
        `${type} refused a value every declaration in its chain takes`,
      ).toBe(true);
    }
  });

  it("judges current merge, replace, retype and version zero while leaving stale results to the server", async () => {
    const { device } = await hydrated();
    const before = await device.get(ROW);
    invalid(
      await device.update(ROW, { version: 3, properties: {}, replace: true }),
      "title",
    );
    invalid(
      await device.update(ROW, { version: 3, properties: { title: null } }),
      "title",
    );
    invalid(
      await device.update(ROW, {
        version: 3,
        type: "fixture.destination",
        properties: {},
      }),
      "url",
    );
    expect(await device.get(ROW)).toEqual(before);
    expect(
      (await device.update(ROW, { version: 3, properties: { read: null } })).ok,
    ).toBe(true);
    expect(
      (
        await device.update(ROW, {
          version: 1,
          asRead: true,
          properties: {},
          replace: true,
        })
      ).ok,
    ).toBe(true);
    invalid(
      await device.update(ROW, {
        version: 1,
        asRead: true,
        properties: { read: "yes" },
      }),
      "read",
    );
    const draft = await device.create({
      type: TYPE,
      properties: { title: "draft" },
    });
    expect(draft.ok).toBe(true);
    if (draft.ok)
      invalid(
        await device.update(draft.value.item_id!, {
          version: 0,
          properties: {},
          replace: true,
        }),
        "title",
      );
  });

  it("judges a known upsert by the row it leaves, and a stale or other-type one by what it supplies", async () => {
    harness = await startHarness("property-validation-known-upsert");
    scriptHydration(harness.server, {
      head: "10",
      catalog: typeCatalog([
        ...types,
        {
          id: "fixture.destination",
          fields: { url: { type: "url", required: true } },
        },
      ]),
      rows: {
        // Held without the title its type requires, as a row written before
        // the type required it is.
        [TYPE]: [
          {
            item: {
              id: ROW,
              type: TYPE,
              version: 3,
              source: "fixture",
              source_id: "gap",
              properties: { body: "held" },
            },
          },
        ],
        "fixture.destination": [
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000c",
              type: "fixture.destination",
              version: 1,
              source: "fixture",
              source_id: "elsewhere",
              properties: { url: "https://example.test" },
            },
          },
        ],
      },
    });
    expect(
      (await harness.device.hydrate([TYPE, "fixture.destination"], "library"))
        .ok,
    ).toBe(true);
    const { device } = harness;
    invalid(
      await device.create({
        type: TYPE,
        source: "fixture",
        sourceId: "gap",
        properties: { read: true },
      }),
      "title",
    );
    expect(
      (
        await device.create({
          type: TYPE,
          source: "fixture",
          sourceId: "gap",
          version: 1,
          properties: { read: true },
        })
      ).ok,
      "a create on a version the copy does not hold was judged on the row the copy holds",
    ).toBe(true);
    expect(
      (
        await device.create({
          type: TYPE,
          source: "fixture",
          sourceId: "elsewhere",
          properties: { read: true },
        })
      ).ok,
      "a create whose key names a row of another type was judged as a whole new row",
    ).toBe(true);
    // The witness: the same create giving the title is taken.
    expect(
      (
        await device.create({
          type: TYPE,
          source: "fixture",
          sourceId: "gap",
          properties: { title: "given" },
        })
      ).ok,
    ).toBe(true);
  });

  it("checks known upserts and supplied values on unresolved or stale targets", async () => {
    const { device } = await hydrated();
    expect(
      (
        await device.create({
          type: TYPE,
          source: "fixture",
          sourceId: "known",
          properties: { read: true },
        })
      ).ok,
    ).toBe(true);
    invalid(
      await device.create({
        type: TYPE,
        source: "fixture",
        sourceId: "known",
        properties: { title: null },
      }),
      "title",
    );
    expect(
      (
        await device.create({
          type: TYPE,
          source: "fixture",
          sourceId: "known",
          version: 1,
          properties: { read: false },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await device.create({
          type: TYPE,
          sourceId: "unresolved",
          properties: {},
        })
      ).ok,
    ).toBe(true);
    invalid(
      await device.create({
        type: TYPE,
        sourceId: "unresolved",
        properties: { read: "yes" },
      }),
      "read",
    );
  });

  it("keeps repeated creates and edits to an unanswered keyed placeholder unresolved", async () => {
    const { device } = await hydrated();
    const keyed = { type: TYPE, source: "fixture", sourceId: "unseen" };
    const first = await device.create({ ...keyed, properties: { read: true } });
    expect(first.ok).toBe(true);
    expect(
      (await device.create({ ...keyed, properties: { read: false } })).ok,
    ).toBe(true);
    if (first.ok) {
      expect(
        (
          await device.update(first.value.item_id!, {
            version: 0,
            properties: { read: false },
            replace: true,
          })
        ).ok,
      ).toBe(true);
      invalid(
        await device.update(first.value.item_id!, {
          version: 0,
          properties: { read: "yes" },
        }),
        "read",
      );
    }
    invalid(
      await device.create({ ...keyed, properties: { read: "yes" } }),
      "read",
    );
  });

  it("retries unchanged document bytes after their destination type is registered", async () => {
    folder = await folderHarness("destination-registration", {
      settings: { search: { types: [TYPE] } },
      catalog: typeCatalog(types),
      rows: {
        [TYPE]: [
          {
            item: {
              id: ROW,
              type: TYPE,
              properties: { title: "valid", body: "held" },
            },
          },
        ],
      },
    });
    expect((await folder.folder.pull()).ok).toBe(true);
    const path = join(folder.dir, "valid.md");
    const original = readFileSync(path, "utf8");
    const changed = /^type:/m.test(original)
      ? original.replace(/^type:.*$/m, "type: fixture.destination")
      : original.replace(/^---\n/, "---\ntype: fixture.destination\n");
    writeFileSync(path, changed);
    writeFileSync(
      join(folder.dir, "other.md"),
      "---\ntitle: other\n---\nvalid neighbour\n",
    );
    const refused = await folder.folder.scan();
    expect(refused.ok && refused.value.created).toBe(1);
    expect(
      refused.ok &&
        refused.value.flagged.some(
          (entry) =>
            entry.path === "valid.md" &&
            entry.reason.includes("fixture.destination"),
        ),
    ).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(changed);
    folder.server.copyAnswer(
      "GET",
      "/types",
      typeCatalog([...types, { ...types[0], id: "fixture.destination" }]),
    );
    expect((await folder.folder.device().catchUp()).ok).toBe(true);
    expect((await folder.folder.device().catchUp()).ok).toBe(true);
    const retried = await folder.folder.scan();
    expect(retried.ok && retried.value.updated).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(changed);
    const moved = await folder.folder.device().get(ROW);
    expect(moved.ok && moved.value?.type).toBe("fixture.destination");
  });

  it("keeps a queued write and its typed server refusal after the server catalog changes", async () => {
    const { device, server } = await hydrated();
    const queued = await device.create({
      type: TYPE,
      properties: { title: "valid" },
    });
    expect(queued.ok).toBe(true);
    server.copyAnswer(
      "GET",
      "/types",
      typeCatalog([
        {
          ...types[0],
          fields: { ...fields, added: { type: "string", required: true } },
        },
      ]),
    );
    expect((await device.catchUp()).ok).toBe(true);
    expect((await device.catchUp()).ok).toBe(true);
    const waiting = await device.queue();
    expect(waiting.ok && waiting.value[0]?.verdict).toBe(null);
    scriptWrites(server, {
      create: [
        refusal(400, "invalid_properties", "Properties do not match the type", {
          errors: [{ field: "added", message: "Required field is missing" }],
        }),
      ],
      read: [refusal(404, "item_not_found", "Item not found")],
    });
    const drained = await device.drain();
    expect(drained.ok).toBe(true);
    if (drained.ok)
      expect(drained.value.verdicts[0]?.refusal?.fields).toEqual([
        { field: "added", message: "Required field is missing" },
      ]);
    const retained = await device.queue();
    expect(retained.ok).toBe(true);
    if (retained.ok)
      expect(retained.value[0]?.body).toMatchObject({
        properties: { title: "valid" },
      });
  });

  it("contains document refusals, preserves bytes through a rename and retries corrected files", async () => {
    folder = await folderHarness("property-validation", {
      settings: { search: { types: [TYPE] } },
      catalog: typeCatalog(types),
      rows: {
        [TYPE]: [
          {
            item: {
              id: ROW,
              type: TYPE,
              properties: { title: "valid", body: "held" },
            },
          },
        ],
      },
    });
    expect((await folder.folder.pull()).ok).toBe(true);
    const valid = join(folder.dir, "good.md");
    const bad = join(folder.dir, "bad.md");
    writeFileSync(
      valid,
      "---\ntype: fixture.fields\ntitle: good\n---\nvalid body\n",
    );
    const invalidText =
      "---\ntype: fixture.fields\ntitle: bad\nread: yes\n---\nkeep these bytes\n";
    writeFileSync(bad, invalidText);
    const scanned = await folder.folder.scan();
    expect(scanned.ok).toBe(true);
    if (scanned.ok) {
      expect(scanned.value.created).toBe(1);
      expect(scanned.value.flagged).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "bad.md",
            flag: "refused",
            reason: expect.stringContaining("read:"),
          }),
        ]),
      );
    }
    expect(readFileSync(bad, "utf8")).toBe(invalidText);
    writeFileSync(bad, invalidText.replace("read: yes", "read: true"));
    const corrected = await folder.folder.scan();
    expect(corrected.ok && corrected.value.created).toBe(1);
    const edited = join(folder.dir, "valid.md");
    const renamed = join(folder.dir, "renamed.md");
    const original = readFileSync(edited, "utf8");
    const badEdit = original.replace("title: valid", "title: invalid");
    writeFileSync(edited, badEdit);
    renameSync(edited, renamed);
    const refusedEdit = await folder.folder.scan();
    expect(refusedEdit.ok).toBe(true);
    if (refusedEdit.ok)
      expect(
        refusedEdit.value.flagged.some(
          (entry) =>
            entry.path === "renamed.md" && entry.reason.includes("title:"),
        ),
      ).toBe(true);
    expect(readFileSync(renamed, "utf8")).toBe(badEdit);
    const held = await folder.folder.device().get(ROW);
    expect(held.ok && held.value?.properties.title).toBe("valid");
    folder.server.copyAnswer(
      "GET",
      "/types",
      typeCatalog([
        {
          ...types[0],
          fields: {
            ...fields,
            title: { type: "string", required: true, maxLength: 7 },
          },
        },
      ]),
    );
    expect((await folder.folder.device().catchUp()).ok).toBe(true);
    expect((await folder.folder.device().catchUp()).ok).toBe(true);
    const retrySameBytes = await folder.folder.scan();
    expect(retrySameBytes.ok && retrySameBytes.value.updated).toBe(1);
    expect(readFileSync(renamed, "utf8")).toBe(badEdit);
    writeFileSync(renamed, badEdit.replace("title: invalid", "title: fixed"));
    const fixed = await folder.folder.scan();
    expect(fixed.ok && fixed.value.updated).toBe(1);
    folder.server.copyAnswer("GET", "/types", typeCatalog());
    expect((await folder.folder.device().catchUp()).ok).toBe(true);
    expect((await folder.folder.device().catchUp()).ok).toBe(true);
    writeFileSync(renamed, readFileSync(renamed, "utf8") + "a changed body\n");
    writeFileSync(
      join(folder.dir, "neighbour.md"),
      "---\ntype: core.note\ntitle: neighbour\n---\nvalid body\n",
    );
    const deletedType = await folder.folder.scan();
    expect(deletedType.ok).toBe(true);
    if (deletedType.ok) {
      expect(deletedType.value.created).toBe(1);
      expect(
        deletedType.value.flagged.some(
          (entry) =>
            entry.path === "renamed.md" &&
            entry.reason.includes("unknown type:"),
        ),
      ).toBe(true);
    }
  });
});
