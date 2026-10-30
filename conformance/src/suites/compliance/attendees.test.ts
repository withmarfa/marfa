import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "attendees"));
});

afterAll(async () => {
  await cleanup(ctx);
});

const STARTS = "2032-05-10T10:00:00.000Z";

async function create(type: string, properties: Record<string, unknown>) {
  const created = await client.createItem({
    type,
    source: ctx.source,
    properties,
  });
  if (created.ok) trackItem(ctx, created.data.item.id);
  return created;
}

const refusedFields = (response: {
  error?: { error: { details?: unknown } };
}) =>
  (
    response.error?.error.details as
      { errors?: { field: string }[] } | undefined
  )?.errors?.map((e) => e.field);

const event = (attendees: unknown) => ({
  title: "Planning",
  starts_at: STARTS,
  attendees,
});

describe("an event's attendees and a task's assignees", () => {
  it("lists attendees on core.event and assignees on core.task", async () => {
    const people = {
      name: { type: "string" },
      email: { type: "email" },
    };
    const attendees = (await client.getType("core.event")).data.fields
      .attendees;
    expect(attendees).toMatchObject({
      type: "array",
      items_type: "object",
      items_fields: {
        ...people,
        response: {
          type: "enum",
          enum_values: ["needs_action", "accepted", "declined", "tentative"],
        },
      },
    });
    const assignees = (await client.getType("core.task")).data.fields.assignees;
    expect(assignees).toMatchObject({
      type: "array",
      items_type: "object",
      items_fields: people,
    });
    expect(Object.keys(assignees?.items_fields ?? {})).toEqual([
      "name",
      "email",
    ]);
    for (const field of [attendees, assignees]) {
      expect(field?.required).not.toBe(true);
      for (const member of Object.values(field?.items_fields ?? {})) {
        expect(member.required).not.toBe(true);
      }
    }
  });

  it("takes an event with two attendees, one only an email and one only a name, in the order written", async () => {
    const written = [
      { email: "sam@example.test", response: "accepted" },
      { name: "Alex" },
    ];
    const made = await create("core.event", event(written));
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const read = await client.getItem(made.data.item.id);
    expect(read.data.item.properties.attendees).toEqual(written);
  });

  it.each(["maybe", "ACCEPTED", 1])(
    "refuses a response outside the four, naming attendees.0.response: %j",
    async (response) => {
      const refused = await create("core.event", event([{ response }]));
      expect(refused.status).toBe(400);
      expect(refused.error?.error.code).toBe("invalid_properties");
      expect(refusedFields(refused)).toEqual(["attendees.0.response"]);
    },
  );

  it("takes each of the four responses", async () => {
    for (const response of [
      "needs_action",
      "accepted",
      "declined",
      "tentative",
    ]) {
      const taken = await create("core.event", event([{ response }]));
      expect(taken.status, response).toBe(201);
    }
  });

  it("refuses an attendee whose email is not an email address, or who holds another member", async () => {
    const badEmail = await create(
      "core.event",
      event([{ email: "sam@example.test" }, { email: "not an email" }]),
    );
    expect(badEmail.error?.error.code).toBe("invalid_properties");
    expect(refusedFields(badEmail)).toEqual(["attendees.1.email"]);

    const undeclared = await create(
      "core.event",
      event([{ name: "Alex", role: "chair" }]),
    );
    expect(refusedFields(undeclared)).toEqual(["attendees.0.role"]);

    const empty = await create("core.event", event([{}]));
    expect(refusedFields(empty)).toEqual(["attendees.0"]);
  });

  it("takes a task with an assignee and refuses a response on it", async () => {
    const written = [
      { name: "octocat" },
      { name: "Sam", email: "s@example.test" },
    ];
    const made = await create("core.task", {
      title: "Fix",
      assignees: written,
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const read = await client.getItem(made.data.item.id);
    expect(read.data.item.properties.assignees).toEqual(written);

    const refused = await create("core.task", {
      title: "Fix",
      assignees: [{ email: "s@example.test", response: "accepted" }],
    });
    expect(refused.error?.error.code).toBe("invalid_properties");
    expect(refusedFields(refused)).toEqual(["assignees.0.response"]);
    const badEmail = await create("core.task", {
      title: "Fix",
      assignees: [{ email: "nope" }],
    });
    expect(refusedFields(badEmail)).toEqual(["assignees.0.email"]);
  });

  it("lets a type under core.event hold attendees and refuse a bad one", async () => {
    const id = `acme-${ctx.runId}.meeting`;
    const registered = await client.registerType({
      id,
      parent: "core.event",
      fields: {},
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const taken = await create(id, event([{ email: "sam@example.test" }]));
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
    const refused = await create(id, event([{ response: "maybe" }]));
    expect(refusedFields(refused)).toEqual(["attendees.0.response"]);
  });
});
