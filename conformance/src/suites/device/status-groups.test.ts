import { afterEach, describe, expect, it } from "vitest";
import { typeCatalog } from "../../device/marfa-answers.js";
import type { Outcome } from "../../device/protocol.js";
import { scriptHydration, startHarness, type Harness } from "./harness.js";

const TASK = "fixture.task";
const CHORE = "fixture.chore";
const NOTE = "fixture.plain";
const words = [
  { value: "todo", group: "not_started" },
  { value: "doing", group: "in_progress" },
  { value: "done", group: "completed" },
  { value: "dropped", group: "canceled" },
];
const catalog = typeCatalog([
  {
    id: TASK,
    fields: {
      title: { type: "string" },
      stage: { type: "status", status_values: words },
    },
    display_hints: { title_field: "title" },
  },
  {
    id: CHORE,
    parent: TASK,
    fields: {
      stage: {
        type: "status",
        status_values: [{ value: "waiting", group: "in_progress" }],
      },
    },
  },
  // A property of the same name on a type with no status field.
  { id: NOTE, fields: { stage: { type: "string" } } },
]);

function row(n: number, type: string, properties: Record<string, unknown>) {
  return {
    item: {
      id: `01a00000-0000-7000-8000-0000000000${String(n).padStart(2, "0")}`,
      type,
      version: 1,
      source: "fixture",
      properties: { title: `row ${String(n)}`, ...properties },
    },
  };
}

const rows = {
  [TASK]: [
    row(1, TASK, { stage: "todo" }),
    row(2, TASK, { stage: "doing" }),
    row(3, TASK, { stage: "done" }),
    // A word the type no longer declares, as a row written before a word was
    // removed is held.
    row(4, TASK, { stage: "pending" }),
    // A chore's word on a task, which a task does not declare.
    row(5, TASK, { stage: "waiting" }),
    row(6, TASK, {}),
    // A listing of a type answers its subtypes too.
    row(7, CHORE, { stage: "waiting" }),
    row(8, CHORE, { stage: "done" }),
  ],
  [NOTE]: [row(9, NOTE, { stage: "done" })],
};

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

async function hydrated(name: string) {
  harness = await startHarness(name);
  scriptHydration(harness.server, { head: "10", catalog, rows });
  expect((await harness.device.hydrate([TASK, NOTE], "library")).ok).toBe(true);
  return harness;
}

function undeclared(outcome: Outcome<unknown>, list: string) {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  const error = (
    JSON.parse(outcome.refusal.raw) as {
      error: { code: string; message: string; server: { code: string } };
    }
  ).error;
  expect(error.code).toBe("validation");
  expect(error.server.code).toBe("invalid_properties");
  expect(error.message).toContain(
    `stage: Must be a status word the type declares: ${list}`,
  );
}

const TASK_WORDS = "todo, doing, done, dropped";

describe("a working copy reads status words through the groups every type shares", () => {
  it("refuses a write that changes a status word to one the type does not declare, and not one that leaves a stored word alone", async () => {
    const { device, server } = await hydrated("status-groups-writes");
    const queued = await device.queue();
    const calls = server.requests.length;
    undeclared(
      await device.create({ type: TASK, properties: { stage: "pending" } }),
      TASK_WORDS,
    );
    undeclared(
      await device.create({ type: TASK, properties: { stage: "waiting" } }),
      TASK_WORDS,
    );
    undeclared(
      await device.create({ type: CHORE, properties: { stage: "pending" } }),
      `${TASK_WORDS}, waiting`,
    );
    const pending = rows[TASK][3]!.item.id;
    undeclared(
      await device.update(pending, {
        version: 1,
        properties: { stage: "waiting" },
      }),
      TASK_WORDS,
    );
    expect(await device.queue(), "a refused write was queued").toEqual(queued);
    expect(server.requests.length).toBe(calls);
    // The witnesses: the same row takes an edit that names its word
    // unchanged, as a synced file sends every property, and each type takes
    // the words its chain declares.
    expect(
      (
        await device.update(pending, {
          version: 1,
          properties: { title: "renamed", stage: "pending" },
          replace: true,
        })
      ).ok,
      "an edit that left a stored undeclared word alone was refused",
    ).toBe(true);
    for (const [type, stage] of [
      [TASK, "dropped"],
      [CHORE, "waiting"],
      [CHORE, "todo"],
      [TASK, null],
    ] as const) {
      expect(
        (await device.create({ type, properties: { stage } })).ok,
        `${type} refused ${String(stage)}`,
      ).toBe(true);
    }
  });

  it("refuses a move into a type that does not declare the row's status word", async () => {
    const { device, server } = await hydrated("status-groups-move");
    const queued = await device.queue();
    const calls = server.requests.length;
    const waiting = rows[TASK][6]!.item.id;
    undeclared(
      await device.update(waiting, { version: 1, type: TASK, properties: {} }),
      TASK_WORDS,
    );
    expect(await device.queue(), "a refused move was queued").toEqual(queued);
    expect(server.requests.length).toBe(calls);
    // The witness: a row holding a word the type declares moves.
    const done = rows[TASK][7]!.item.id;
    expect(
      (await device.update(done, { version: 1, type: TASK, properties: {} }))
        .ok,
      "a move into a type declaring the row's word was refused",
    ).toBe(true);
  });

  it("answers status_group by each type's own words, and takes only a group", async () => {
    const { device } = await hydrated("status-groups-filter");
    const ids = async (filter: string) => {
      const listed = await device.list({ filter });
      expect(listed.ok, filter).toBe(true);
      if (!listed.ok) return [];
      return listed.value.map((item) => item.properties.title).sort();
    };
    expect(await ids('status_group eq "in_progress"')).toEqual([
      "row 2",
      "row 7",
    ]);
    expect(await ids('status_group eq "completed"')).toEqual([
      "row 3",
      "row 8",
    ]);
    expect(await ids('status_group neq "completed"')).toEqual([
      "row 1",
      "row 2",
      "row 7",
    ]);
    expect(await ids("status_group exists")).toEqual([
      "row 1",
      "row 2",
      "row 3",
      "row 7",
      "row 8",
    ]);
    // No word, a word the type does not declare, and a type with no status
    // field are in no group.
    expect(await ids("status_group not_exists")).toEqual([
      "row 4",
      "row 5",
      "row 6",
      "row 9",
    ]);
    for (const filter of [
      'status_group eq "done"',
      'status_group contains "completed"',
      "status_group eq null",
    ]) {
      const refused = await device.list({ filter });
      expect(refused.ok, filter).toBe(false);
      if (refused.ok) continue;
      const error = (
        JSON.parse(refused.refusal.raw) as {
          error: { code: string; server: { code: string | null } | null };
        }
      ).error;
      expect([error.code, error.server?.code], filter).toEqual([
        "validation",
        "validation_error",
      ]);
    }
  });
});
