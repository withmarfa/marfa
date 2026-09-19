/**
 * Conformance for what a credential may do with the internal `system.*` type
 * set, which under one permission model is: nothing.
 *
 * Every real `system.*` row is written by the server through the storage
 * layer, so the half that is assertable black-box is the refusal, asserted
 * from a credential holding write on every type.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackKey, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "system-types",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function narrowClient(label: string): Promise<MarfaClient> {
  const resp = await client.createKey({
    label,
    source: `${ctx.source}-${label}`,
    type_permissions: { "*": "write" },
  });
  expect(resp.ok).toBe(true);
  trackKey(ctx, resp.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: resp.data.key });
}

describe("system.* set", () => {
  it("rejects system.* writes from every key the API can mint", async () => {
    const np = await narrowClient("np-system-write");
    const r = await np.createItem({
      type: "system.device",
      properties: { name: "np-write", kind: "laptop" },
    });
    expect(r.status).toBe(403);
    expect(r.error?.error.code).toBe("type_not_permitted");
  });

  it("names, in system.connection's own description, the fields nothing writes", async () => {
    // Eight connector fields are declared on a shipped type that no door
    // accepts and no server path stamps. Declaring them is a forward
    // declaration rather than a lie only while the type says so.
    //
    // **The field list alone is not the claim.** This asserted only that
    // each of the eight was a key of `fields` and a substring of
    // `description`, which a rewording to "populated by the connector
    // runtime" would have passed while inverting the meaning, and which the
    // type's own self-contradiction passed unchanged: the description said
    // `runtime_status` was "server-stamped only" four sentences before
    // listing it among the fields nothing stamps. So the sentences are
    // asserted, not just the names in them, and the contradicted phrasing
    // is asserted absent.
    const unwritten = [
      "attached_device",
      "feed_activity",
      "last_error_at",
      "last_sync_at",
      "mapping_reapply_until",
      "next_run_at",
      "runtime_status",
      "triggers",
    ];
    const r = await client.getType("system.connection");
    expect(r.ok).toBe(true);
    const declared = Object.keys(r.data.fields);
    expect(unwritten.filter((name) => !declared.includes(name))).toEqual([]);
    const description = r.data.description ?? "";
    expect(unwritten.filter((name) => !description.includes(name))).toEqual([]);

    // The claim itself, in the words that make it one.
    expect(description).toContain(
      "Eight connector fields are declared here and written by nothing in this build",
    );
    expect(description).toContain(
      "No door accepts them and no server path stamps them",
    );
    // The sentence that contradicted all of the above. `runtime_status` is
    // one of the eight; nothing stamps it, so nothing may say it does.
    expect(description).not.toContain("server-stamped");

    // And the same claim where a client reading one field alone meets it.
    // Dropping this note from `runtime_status` left that reader inferring
    // the opposite of what the type description says.
    expect(r.data.fields.runtime_status.description ?? "").toContain(
      "No door writes it in this build.",
    );
    // `feed_activity` promised a server behavior that does not exist: that a
    // true value gets the connector's `system.activity` items stamped
    // `tier:'feed'`. Nothing reads the field, so nothing stamps anything.
    const feedActivity = r.data.fields.feed_activity.description ?? "";
    expect(feedActivity).toContain("no server path stamps a tier from it");
    expect(feedActivity).not.toContain("server-stamped");
  });

  it("promises no feed stamp on system.activity, which nothing performs", async () => {
    // `system.activity` said feed eligibility "lives on the emitting
    // `system.connection.feed_activity`; when true, server stamps
    // tier:'feed'". `feed_activity` is one of the eight fields nothing
    // reads: no server, shared or SDK code reads or writes it, so no path
    // stamps a tier on an activity item and every door refuses a client
    // that asks for one. Two types stated the same consequence and neither
    // had anything behind it.
    const r = await client.getType("system.activity");
    expect(r.ok).toBe(true);
    const description = r.data.description ?? "";
    expect(description).toContain("nothing in this build reads");
    expect(description).toContain("no server path stamps a tier");
    expect(description).not.toContain("server stamps");
  });

  it("serves no system.connection carrying a field nothing writes", async () => {
    // The other half of the same claim, and the half the description cannot
    // make on its own: "a reader will never meet one populated" is a
    // statement about rows. Nothing over the wire creates a
    // `system.connection` — an OAuth grant is what writes one — so this
    // asserts over whatever the instance happens to hold and is vacuous on a
    // dataset with none. Vacuous and honest beats absent: the moment a grant
    // exists in the run, a server path that started filling one of the eight
    // reddens here.
    const unwritten = [
      "attached_device",
      "feed_activity",
      "last_error_at",
      "last_sync_at",
      "mapping_reapply_until",
      "next_run_at",
      "runtime_status",
      "triggers",
    ];
    const r = await client.rawRequest<{
      data: { id: string; properties: Record<string, unknown> }[];
    }>("/items?type=system.connection&include=system&limit=100");
    expect(r.status).toBe(200);
    const populated: string[] = [];
    for (const row of r.data.data) {
      for (const name of unwritten) {
        if (row.properties[name] !== undefined) {
          populated.push(`${row.id}.${name}`);
        }
      }
    }
    expect(populated).toEqual([]);
  });
});
